# Architecture

This document describes the system design, data flow, and key components of the Export API.

---

## System Overview

The Export API is a Node.js/Express application that acts as a data hub between multiple external services:

```
┌──────────────────────────────────────────────────────────────────────┐
│                        External Services                             │
│                                                                      │
│   ┌─────────┐    ┌────────────┐    ┌──────────┐    ┌─────────────┐  │
│   │   PNV   │    │ Metakocka  │    │  Gemini  │    │    n8n      │  │
│   │ (source)│    │(enrich)    │    │  (AI)    │    │(scheduler)  │  │
│   └────┬────┘    └─────┬──────┘    └────┬─────┘    └──────┬──────┘  │
│        │               │               │                  │         │
└────────┼───────────────┼───────────────┼──────────────────┼─────────┘
         │               │               │                  │
         ▼               ▼               ▼                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                          Export API                                   │
│                                                                      │
│   ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │
│   │  Webhooks   │  │   Custom    │  │   Health    │                │
│   │  (sync,     │  │   Exports   │  │   Check     │                │
│   │   AI cat.)  │  │  (CRUD +    │  │             │                │
│   │             │  │   download) │  │             │                │
│   └──────┬──────┘  └──────┬──────┘  └─────────────┘                │
│          │                │                                          │
│          ▼                ▼                                          │
│   ┌──────────────────────────────────────┐                          │
│   │            MongoDB                    │                          │
│   │                                      │                          │
│   │  products   exports   export_configs │                          │
│   │  categories analytics                │                          │
│   └──────────────────────────────────────┘                          │
│                         │                                            │
└─────────────────────────┼────────────────────────────────────────────┘
                          │
                ┌─────────┼─────────┐
                ▼         ▼         ▼
              CSV       JSON       XML
           (Shopify)  (custom)  (Recharge)
```

---

## Key Design Decisions

### No Internal Scheduler

All recurring jobs are triggered externally by **n8n** via webhook endpoints. This keeps the API stateless and lets scheduling logic live in n8n's visual workflow editor where it can be modified without code changes.

### Background Processing with Callbacks

Webhook endpoints respond immediately with `202 Accepted` and process in the background. An optional `webhook` callback URL allows n8n to chain jobs into pipelines.

### Soft Deletes

Products and export configurations use soft deletes (`active: false` / `isActive: false`) instead of hard deletes. This preserves audit trails and allows recovery.

### Dual Authentication

The API supports two auth strategies simultaneously:
- **JWT Bearer** (Auth0) for frontend/dashboard access
- **API Key** for programmatic/webhook access

The `dualAuth` middleware tries JWT first, then falls back to API key.

---

## Startup Sequence

```
index.js
  │
  ├── 1. Load .env from DATA_PATH (or cwd)
  │      └── In dev: overlay .env.development (override: true)
  │
  ├── 2. Connect to MongoDB
  │      └── connectToDb() in src/services/db/mongo.service.js
  │
  ├── 3. Run migrations
  │      └── ensureIndexesAndMigrate() -- sets up indexes, migrates legacy configs
  │
  ├── 4. Start Express server on PORT (default: 3000)
  │
  └── 5. Register graceful shutdown handlers (SIGTERM, SIGINT)
```

---

## Route Layout

All routes are mounted under `/api/export`:

| Route prefix | File | Auth |
|--------------|------|------|
| `/api/export/health` | `src/routes/healthRoutes.js` | Public |
| `/api/export/product` | `src/routes/productRoutes.js` | Dual Auth |
| `/api/export/exports` | `src/routes/exportsRoutes.js` | Dual Auth |
| `/api/export/categories` | `src/routes/categoriesRoutes.js` | Dual Auth |
| `/api/export/custom-export` | `src/routes/customExportRoutes.js` | Dual Auth |
| `/api/export/recharge` | `src/routes/rechargeRoutes.js` | Dual Auth |
| `/api/export/webhooks` | `src/routes/webhookRoutes.js` | API Key |

---

## Data Flow

### Product Sync Pipeline

```
PNV Admin Panel
     │
     │  1. Authenticate (cookie-based, SHA1 password)
     │  2. Trigger CSV export
     │  3. Download CSV
     ▼
┌─────────────────────────┐
│  CSV Parsing & Mapping  │  src/services/pnv/processPnvProductExport.service.js
│                         │  src/config/pnv/products.js (field mappings)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Metakocka Enrichment   │  src/services/metakocka/warehouse.service.js (stock)
│                         │  src/services/metakocka/price.service.js (pricing)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  MongoDB Upsert         │  products collection
│  + Soft-delete removed  │  active: false for missing products
└─────────────────────────┘
```

### AI Categorization

```
Uncategorized Products (from MongoDB)
     │
     │  Batched in groups of 30
     ▼
┌─────────────────────────┐
│  Google Gemini 2.5 Flash│  src/services/ai/categoryIdentification.service.js
│                         │
│  Input: product + list  │
│  of available categories│
│                         │
│  Output: categoryId per │
│  product                │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  MongoDB Update         │  products.ai_categories[] array
│                         │  Keyed by exportId
└─────────────────────────┘
```

### Export Generation

```
Export Config (from export_configs collection)
     │
     ├── Preset (shopify / simple / detailed / inventory)
     ├── Selected fields
     ├── Filters
     └── Pricelist priority
            │
            ▼
┌─────────────────────────┐
│  Load & Filter Products │  Apply all filter conditions (AND logic)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Resolve Prices         │  Walk pricelist priority, first match wins
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│  Generate Output        │  CSV (with BOM) / JSON / XML
│                         │  Shopify: product rows + variant rows + image rows
│                         │  Inventory: fixed columns for Shopify import
└─────────────────────────┘
```

---

## MongoDB Collections

| Collection | Purpose | Key fields |
|------------|---------|------------|
| `products` | Synced product data with enrichments | `code`, `active`, `child_products[]`, `ai_categories[]`, `stock_amount`, `pricelist[]` |
| `exports` | Export definitions (groups of categories) | `name`, `aiCategorizationEnabled`, `roles[]`, `users[]` |
| `export_configs` | Saved export configurations | `name`, `preset`, `selectedFields[]`, `filters`, `pricelistPriority[]`, `isActive` |
| `categories` | Product categories per export | `exportId`, `name` |
| `analytics` | Function performance logs | `actionName`, `durationMs`, `timestamp` |

---

## Middleware Stack

| Middleware | File | Purpose |
|------------|------|---------|
| `dualAuth` | `src/middleware/dualAuth.js` | JWT bearer + API key fallback |
| `webhookApiKey` | `src/middleware/webhookApiKey.js` | Static key check for webhooks |
| `analytics` | `src/middleware/analytics.js` | PostHog request logging |
| `logger` | `src/middleware/logger.js` | Request logging |
| `requireExportAccess` | `src/middleware/requireExportAccess.js` | Per-export authorization |
| `requireExportRole` | `src/middleware/requireExportRole.js` | Role-based access control |

---

## External Dependencies

| Service | Purpose | SDK/Client |
|---------|---------|------------|
| PNV (Partner.net Vision) | Product source data (CSV) | HTTP (axios) |
| Metakocka | Stock levels & pricelist pricing | HTTP (axios) |
| Google Gemini | AI product categorization | `@google/generative-ai` |
| MongoDB | Primary data store | `mongodb` (native driver) |
| PostHog | Analytics & request tracking | `posthog-node` |
| Auth0 | JWT authentication | `express-oauth2-jwt-bearer` |
