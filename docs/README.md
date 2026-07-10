# Documentation

Documentation for the **Time-4-Action Partner Portal API**, served from
**`https://api.time-4-action.com`**.

## Guides

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System design, data flow, components, and MongoDB collections |
| [Deployment](deployment.md) | Docker setup, environment variables, and production checklist |
| [Releasing](RELEASING.md) | Version tags and GitHub Releases process |

## API Reference

Start with **[Authentication](api/authentication.md)** — it explains every auth
strategy the endpoints below reference.

| Document | Base path | Description |
|----------|-----------|-------------|
| [Authentication](api/authentication.md) | — | JWT, API keys, webhook key, admin token, Shopify HMAC |
| [Health Check](api/health.md) | `/api/export/health` | Service health and dependency monitoring |
| [Products](api/products.md) | `/api/product` | Catalogue list / search / lookup (+ full-catalogue `x-api-key`) |
| [Exports](api/exports.md) | `/api/export/exports` | Export groupings + AI-status polling |
| [Categories](api/categories.md) | `/api/export/categories` | Category sets per export |
| [Custom Exports](api/custom-exports.md) | `/api/export/custom-export` | Export configs + CSV/JSON/XML download |
| [API Keys & Access](api/api-keys-and-access.md) | `/api/export/custom-export/:id` | Per-export API keys & access grants |
| [Shopify Integration](api/shopify.md) | `/api/export/shopify` | Store OAuth, connections, sync |
| [Own Sources](api/own-sources.md) | `/api/export/external` | External supplier feed ingest |
| [Recharge XML Feed](api/recharge.md) | `/api/export/recharge` | Fixed-format XML product feed |
| [Webhooks](api/webhooks.md) | `/api/export/webhooks` | PNV sync, AI categorization, Shopify/external triggers |
| [AI Categorization](api/ai-categorization.md) | `/api/export/webhooks/categorize` | Synchronous categorization for integrations |
| [Admin (Internal)](api/admin.md) | `/api/admin` | Partner analytics + catalogue-sync control (t4a-admin only) |

## Quick Links

- [Getting Started](../README.md#quick-start)
- [Contributing](../CONTRIBUTING.md)
- [License](../LICENSE)
