# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start with NODE_ENV=development (loads .env then .env.development)
npm start         # Start with NODE_ENV=production
npm run docs      # Generate README.md from JSDoc comments
```

No test suite exists (`npm test` just exits with an error).

## Architecture

Node.js/Express API that syncs product data from **PNV** (Partner.net Vision) into **MongoDB**, enriches it with stock and pricing from **Metakocka**, and exposes configurable product exports. Scheduling is handled externally by **n8n** — there is no internal cron scheduler.

### Startup sequence (`index.js`)

1. Loads `.env` (and `.env.development` in dev mode) from `DATA_PATH` or `cwd()`
2. Connects to MongoDB (`connectToDb`)
3. Runs `ensureIndexesAndMigrate` (sets up indexes and migrates legacy export configs)
4. Starts the Express server on `PORT` (default 3000)

### Route layout (`src/app.js`)

All routes are under `/api/export`:

| Prefix | File |
|---|---|
| `/api/export/health` | `src/routes/healthRoutes.js` — public, no auth |
| `/api/export/product` | `src/routes/productRoutes.js` |
| `/api/export/exports` | `src/routes/exportsRoutes.js` |
| `/api/export/categories` | `src/routes/categoriesRoutes.js` |
| `/api/export/custom-export` | `src/routes/customExportRoutes.js` |
| `/api/export/recharge` | `src/routes/rechargeRoutes.js` |
| `/api/export/webhooks` | `src/routes/webhookRoutes.js` — n8n triggers |

### Authentication

Two middleware options are available:

- **`src/middleware/auth0.js`** — Auth0 JWT bearer (`express-oauth2-jwt-bearer`). Currently commented out in `src/routes/export/index.js`.
- **`src/middleware/dualAuth.js`** — Tries JWT first (`Authorization: Bearer`), falls back to API key (`X-Api-Key` header or `api_key` body field). Sets `req.authContext` on success.
- **`src/middleware/webhookApiKey.js`** — Simple static key check for webhook endpoints (`x-api-key` header vs `WEBHOOK_API_KEY` env var).

### PNV sync pipeline

Triggered by `POST /api/export/webhooks/sync/pnv`. Responds `202` immediately and runs in the background:

1. `pnvProductsSync.service.js` — authenticates with PNV (SHA1-hashed password in cookie), triggers CSV export, downloads CSV to `DATA_PATH/pnv/products.csv`
2. `processPnvProductExport.service.js` — parses the CSV, maps fields via `src/config/pnv/products.js`
3. Enriches each product with warehouse stock and pricing from Metakocka (`src/services/metakocka/`)
4. Upserts products into the `products` MongoDB collection; products absent from CSV are soft-deleted (`active: false`)
5. Optionally POSTs a callback to a `webhook` URL when done

### AI categorization

Triggered by `POST /api/export/webhooks/sync/ai-categorization`. Uses Google Gemini (`@google/generative-ai`) to assign categories to uncategorized products. Categories are stored as an `ai_categories` array on each product document, keyed by `exportId`.

### Custom exports (`src/services/customExport.service.js`)

Export configurations are stored in the `export_configs` MongoDB collection. Each config defines field selection, filters, and pricelist priority. Supports presets: `shopify`, `simple`, `detailed`, `inventory`. Generates CSV/JSON/XML on demand.

The **inventory preset** uses a dedicated code path (`generateInventoryRows()`) that produces a fixed-column Shopify inventory import CSV: `Handle, Title, Option1 Name, Option1 Value, Option2 Name, Option2 Value, Option3 Name, Option3 Value, SKU, HS Code, COO, {locationName}`. The last column header is the `inventoryLocationName` stored on the config — it must be an exact case-sensitive match of the Shopify location name. Field selection is skipped for inventory; only CSV export is supported (no JSON/XML).

### Analytics

`src/services/analytics.service.js` provides `monitorFunction(fn, actionName)` — wraps any async function, measures duration, and writes a record to the `analytics` MongoDB collection. Also tracks API request logs via `src/middleware/analytics.js` using PostHog (`posthog-node`).

### MongoDB collections

| Collection | Purpose |
|---|---|
| `products` | Synced PNV products with Metakocka enrichment and AI categories |
| `exports` | Export definitions (name, AI categorization enabled, roles/users) |
| `export_configs` | Custom export configurations (fields, filters, presets) |
| `analytics` | Function performance and API request logs |

### `products` document shape

A product is a **parent** with an optional `child_products` array of **variants**. Variants are normally the sellable SKUs; the parent groups them.

- **Parent:** `code`, `token` (handle), `product_name`, `short_description`/`detailed_description` (HTML), `images[]`, `categories[]` (PNV path), `ai_categories[]`, `published`, `active`, `archived`, `stock_amount` (often `0` — variants carry stock), `pricelist[]` (often empty — variants carry pricing), `ean_code`, `size`.
- **Variant (`child_products[]`):** `code` (**SKU**), `ean_code` (**barcode**), `token`, `product_name`, `size` (variant option, e.g. `"77"`), `stock_amount`, `images[]`, per-variant flags (`published`, `archived`, `cart`, `new`, `recomended`), and `pricelist[]`.
- **`pricelist[]`:** array of `{ name, valid_from, price, vat }` — e.g. `RRP 2025` (`vat: 22`) and a future-dated `RRP 2026` (`vat: 0`). No single price field; resolve via `getPriceFromPriority(variant, pricelistPriority)` in `customExport.service.js`. VAT and `valid_from` vary per list.
- **`ai_categories[]`:** `{ exportId, categoryId, categoryName }` — categorization is per export, keyed by `exportId`.
- **Publishing:** parents and variants each have a `published` flag; a published parent may contain unpublished variants. Exports are **always published-only** — `applyFilters` drops unpublished parents and narrows `child_products` to published variants.
- **No-variant products:** if `child_products` is empty, the parent is the sellable item (use its own `code`/`pricelist`/`stock_amount`).

## Environment variables

See README.md for the full table. Key variables: `MONGO_URI`, `MONGO_DB_NAME`, `PNV_BASE_URL`, `PNV_EXPORT_PRODUCTS_URL`, `PNV_USER`, `PNV_PASS`, `PNV_GROUP`, `PNV_USER_ID`, `METAKOCKA_ID`, `METAKOCKA_KEY`, `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`.

`.env` files are loaded from `DATA_PATH` if set (Docker mounts `/data`), otherwise from the project root.
