<div align="center">

# Patrik Products Export API

**Product data pipeline & configurable export engine**

Syncs products from PNV, enriches with stock & pricing from Metakocka,
categorizes with AI, and exports to CSV / JSON / XML.

[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.0-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#docker)

</div>

---

## Overview

This API serves as the backbone of the Patrik product management pipeline. It connects multiple data sources into a single MongoDB store and exposes flexible export endpoints for downstream consumers like Shopify, Recharge, and custom integrations.

**Key capabilities:**

- **Product sync** from PNV (Partner.net Vision) with automatic CSV parsing
- **Stock & pricing enrichment** from Metakocka warehouse/pricelist APIs
- **AI categorization** using Google Gemini 2.5 Flash
- **Configurable exports** in CSV, JSON, and XML with preset templates
- **Webhook-driven scheduling** via n8n (no internal cron)

## Architecture

```
                          n8n (scheduler)
                               |
                     webhook triggers (POST)
                               |
                               v
  ┌─────────┐   CSV    ┌─────────────────┐   enrich   ┌────────────┐
  │   PNV   │ -------> │                 │ <---------> │ Metakocka  │
  │ (admin) │          │   Export API    │             │  (stock &  │
  └─────────┘          │   (Express)    │             │  pricing)  │
                       │                 │             └────────────┘
                       │                 │
  ┌─────────┐  batch   │                 │   query    ┌────────────┐
  │ Gemini  │ <------> │                 │ <--------> │  MongoDB   │
  │  (AI)   │          │                 │            │            │
  └─────────┘          └────────┬────────┘            └────────────┘
                                │
                    ┌───────────┼───────────┐
                    v           v           v
                  CSV         JSON         XML
               (Shopify)   (custom)    (Recharge)
```

> For a deep dive into the system design, see [Architecture](docs/architecture.md).

## Quick Start

### Prerequisites

- **Node.js** 22 LTS (or compatible)
- **MongoDB** 7.0+
- PNV admin credentials
- Metakocka API key
- Google Gemini API key *(optional, for AI categorization)*

### Installation

```bash
git clone https://github.com/etiam-si/patrik-products-automation.git
cd patrik-products-automation
npm install
```

### Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.development .env
```

See the [Environment Variables](docs/deployment.md#environment-variables) reference for all available options.

### Run

```bash
# Development (hot-reloads .env.development overrides)
npm run dev

# Production
npm start
```

The API starts on `http://localhost:3000` by default. All routes are under `/api/export`.

## API Reference

| Endpoint | Description | Auth | Docs |
|----------|-------------|------|------|
| `GET /api/export/health` | Service & dependency health | Public | [Health](docs/api/health.md) |
| `POST /api/export/webhooks/sync/pnv` | Trigger PNV product sync | API Key | [Webhooks](docs/api/webhooks.md#pnv-product-sync) |
| `POST /api/export/webhooks/sync/ai-categorization` | Run AI categorization | API Key | [Webhooks](docs/api/webhooks.md#ai-categorization) |
| `POST /api/export/webhooks/categorize` | Categorize external products | API Key | [AI Categorization](docs/api/ai-categorization.md) |
| `GET\|POST\|PUT\|DELETE /api/export/custom-export` | Manage export configs | Dual Auth | [Custom Exports](docs/api/custom-exports.md) |
| `GET /api/export/custom-export/:id/csv\|json\|xml` | Download export data | Dual Auth | [Custom Exports](docs/api/custom-exports.md#download-endpoints) |
| `GET /api/export/recharge/xml` | Recharge XML feed | Dual Auth | [Webhooks](docs/api/webhooks.md#recharge-xml) |

> **Auth types:** `API Key` = `x-api-key` header, `Dual Auth` = JWT bearer or API key, `Public` = no auth required.

## Data Pipeline

The sync pipeline runs as a background job triggered by n8n webhooks:

```
1. Authenticate with PNV  ─>  trigger CSV export  ─>  download CSV
2. Parse CSV  ─>  map fields  ─>  normalize product data
3. Enrich with Metakocka stock levels and pricelist pricing
4. Upsert into MongoDB  ─>  soft-delete removed products
5. (Optional) AI categorization pass with Google Gemini
6. Callback to n8n webhook URL on completion
```

Each step is instrumented with analytics tracking and optional webhook callbacks for pipeline orchestration.

## Docker

Build and run with Docker:

```bash
docker build -t patrik-export-api .
docker run -d \
  --name export-api \
  -p 3000:3000 \
  -v /path/to/data:/data \
  --env-file .env \
  patrik-export-api
```

Or use the included build script:

```bash
./scripts/build-and-push.sh
```

> See [Deployment Guide](docs/deployment.md) for full Docker and production setup instructions.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, data flow, and component overview |
| [Deployment](docs/deployment.md) | Docker, environment variables, and production setup |
| **API Reference** | |
| [Webhooks](docs/api/webhooks.md) | PNV sync, AI categorization triggers, and Recharge |
| [Custom Exports](docs/api/custom-exports.md) | Export configuration CRUD and download endpoints |
| [AI Categorization](docs/api/ai-categorization.md) | Third-party product categorization API |
| [Health Check](docs/api/health.md) | Service health and dependency monitoring |

## Project Structure

```
patrik-products-automation/
├── index.js                  # Entry point & server startup
├── src/
│   ├── app.js                # Express app setup & route mounting
│   ├── config/               # External service configurations
│   │   ├── metakocka/        # Metakocka API config
│   │   └── pnv/              # PNV field mappings
│   ├── controllers/          # Request handlers
│   ├── jobs/                 # Background job orchestration
│   │   └── pnv/              # PNV sync job implementation
│   ├── middleware/            # Auth, analytics, logging
│   ├── models/               # Data models
│   ├── routes/               # Route definitions
│   │   └── export/           # Route aggregation & middleware
│   └── services/             # Business logic
│       ├── ai/               # Gemini AI categorization
│       ├── db/               # MongoDB connection & migrations
│       ├── metakocka/        # Stock & pricing queries
│       └── pnv/              # PNV sync & CSV processing
├── docs/                     # Documentation
│   └── api/                  # API reference docs
├── scripts/                  # Build & deploy scripts
├── public/                   # Static assets
└── data/                     # Runtime data files (CSV, XML)
```

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">
  <sub>Built by <a href="https://etiam.si">etiam.si</a></sub>
</div>
