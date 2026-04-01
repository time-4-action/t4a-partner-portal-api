# patrik-products-automation

Node.js/Express API that syncs product data from PNV into MongoDB, enriches it with stock and pricing from Metakocka, and exposes configurable product exports (CSV, JSON, XML).

Scheduling is handled externally by **n8n** via webhook endpoints — there is no internal cron scheduler.

---

## Environment variables

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default: `3000`) |
| `NODE_ENV` | `production` or `development` |
| `DATA_PATH` | Base path for `.env` and downloaded data files (Docker: `/data`) |
| `PNV_BASE_URL` | Base URL of the PNV admin panel |
| `PNV_EXPORT_PRODUCTS_URL` | PNV endpoint that triggers the CSV export |
| `PNV_USER` | PNV login username |
| `PNV_PASS` | PNV login password (hashed SHA1 internally) |
| `PNV_GROUP` | PNV group ID |
| `PNV_USER_ID` | PNV user ID |
| `METAKOCKA_ID` | Metakocka account ID |
| `METAKOCKA_KEY` | Metakocka API key |
| `GOOGLE_API_KEY` | Google Gemini API key for AI categorization |
| `MONGO_URI` | MongoDB connection string |
| `MONGO_DB_NAME` | MongoDB database name |
| `WEBHOOK_API_KEY` | Secret key used to authenticate the webhook endpoints (see below) |

---

## Webhook endpoints (n8n triggers)

All webhook endpoints are protected by an API key passed in the `x-api-key` request header.
The key must match the `WEBHOOK_API_KEY` environment variable.

### 1. PNV Product Sync

**`POST /api/export/webhooks/sync/pnv`**

Triggers a full product sync from PNV:
1. Authenticates with PNV and triggers a CSV export
2. Downloads the resulting CSV file
3. Parses and enriches each product with stock (Metakocka) and pricelist (Metakocka)
4. Upserts all products into MongoDB (`products` collection)
5. Products no longer in the CSV are soft-deleted (`active: false`)

The endpoint responds immediately with `202 Accepted` and runs the sync in the background.

**Request**

```
POST /api/export/webhooks/sync/pnv
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "webhook": "https://your-n8n/webhook/abc123"
}
```

`webhook` is optional. When provided, the app POSTs a result payload to that URL once the sync finishes (success or failure).

**Callback payload — success**
```json
{
  "event": "pnv_sync_completed",
  "success": true,
  "startedAt": "2024-01-15T10:00:00.000Z",
  "finishedAt": "2024-01-15T10:05:30.000Z",
  "durationMs": 330000,
  "stats": {
    "totalProcessed": 125,
    "productsCreated": 5,
    "productsUpdated": 120,
    "productsDeactivated": 2
  }
}
```

**Callback payload — failure**
```json
{
  "event": "pnv_sync_completed",
  "success": false,
  "startedAt": "2024-01-15T10:00:00.000Z",
  "finishedAt": "2024-01-15T10:00:05.000Z",
  "durationMs": 5000,
  "error": "Failed to download CSV from PNV."
}
```

**Response `202`**

```json
{
  "message": "PNV product sync started.",
  "startedAt": "2024-01-15T10:00:00.000Z"
}
```

---

### 2. AI Categorization

**`POST /api/export/webhooks/sync/ai-categorization`**

Runs AI category identification (Google Gemini) on products that have not yet been categorized.

- If **no body** is sent, it runs for **all exports** that have `aiCategorizationEnabled: true` in MongoDB.
- If a specific `exportId` is sent in the body, it runs only for that export.

The endpoint responds immediately with `202 Accepted` and runs in the background.

**Request — all AI-enabled exports**

```
POST /api/export/webhooks/sync/ai-categorization
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "webhook": "https://your-n8n/webhook/abc123"
}
```

**Request — specific export**

```
POST /api/export/webhooks/sync/ai-categorization
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "exportId": "664f1a2b3c4d5e6f7a8b9c0d",
  "webhook": "https://your-n8n/webhook/abc123"
}
```

`webhook` is optional. When provided, the app POSTs a result payload to that URL once all exports are processed.

**Callback payload — success**
```json
{
  "event": "ai_categorization_completed",
  "success": true,
  "startedAt": "2024-01-15T10:05:30.000Z",
  "finishedAt": "2024-01-15T10:07:00.000Z",
  "durationMs": 90000,
  "stats": {
    "exportsProcessed": 2,
    "results": [
      {
        "exportId": "664f1a2b3c4d5e6f7a8b9c0d",
        "success": true,
        "durationMs": 45000,
        "productsFound": 20,
        "productsCategorized": 18
      }
    ]
  }
}
```

**Callback payload — failure** (one or more exports failed — `results` array shows which ones)
```json
{
  "event": "ai_categorization_completed",
  "success": false,
  "startedAt": "2024-01-15T10:05:30.000Z",
  "finishedAt": "2024-01-15T10:06:00.000Z",
  "durationMs": 30000,
  "stats": {
    "exportsProcessed": 1,
    "results": [
      {
        "exportId": "664f1a2b3c4d5e6f7a8b9c0d",
        "success": false,
        "durationMs": 30000,
        "error": "No categories found for exportId."
      }
    ]
  }
}
```

**Response `202`**

```json
{
  "message": "AI categorization started for 2 export(s).",
  "exportIds": ["664f1a2b3c4d5e6f7a8b9c0d", "664f1a2b3c4d5e6f7a8b9c0e"],
  "startedAt": "2024-01-15T10:05:00.000Z"
}
```

**Tip — chaining in n8n:** Pass the URL of the AI categorization n8n workflow as `webhook` in the PNV sync request body. When PNV sync finishes, it GETs that URL and n8n immediately fires the next step.

```
[Schedule] → POST /webhooks/sync/pnv  { webhook: <n8n webhook> }
                  ↓ (background finishes)
             GET <n8n webhook>
                  ↓
             POST /webhooks/sync/ai-categorization  { webhook: <n8n webhook 2> }
                  ↓ (background finishes)
             GET <n8n webhook 2>
```

---

## Other API endpoints

### Health check

```
GET /api/export/health
```

Public, no authentication required. Checks the status of the service and all its dependencies in parallel and returns a single combined result.

**Response `200` — all healthy**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "appName": "patrik-products-export",
  "timestamp": "2024-01-15T10:00:00.000Z",
  "uptime": 3600.5,
  "memoryUsage": { "rss": 12345678, "heapUsed": 9876543 },
  "dependencies": {
    "database": "ok",
    "pnv": "ok",
    "metakocka": "ok"
  }
}
```

**Response `503` — one or more dependencies unhealthy**

Same shape as above but `"status": "error"` and the affected dependency shows `"error"` or `"misconfigured"`.

**Dependency statuses**

| Dependency | What is checked | Possible values |
|---|---|---|
| `database` | MongoDB ping | `ok`, `error` |
| `pnv` | HEAD request to `PNV_BASE_URL` (5 s timeout) | `ok`, `error`, `misconfigured` |
| `metakocka` | POST to warehouse stock endpoint with limit=1 (5 s timeout) | `ok`, `error`, `misconfigured` |

`misconfigured` means the required environment variables for that service are not set.

### Custom exports

Saved export configurations (CSV / JSON / XML) with filtering, field selection, and pricelist priority.

```
GET    /api/export/custom-export              List all configs
POST   /api/export/custom-export              Create a config
GET    /api/export/custom-export/:id          Get a config
PUT    /api/export/custom-export/:id          Update a config
DELETE /api/export/custom-export/:id          Delete a config (soft)
GET    /api/export/custom-export/:id/csv      Download CSV
GET    /api/export/custom-export/:id/json     Download JSON
GET    /api/export/custom-export/:id/xml      Download XML
```

### Recharge XML export

```
GET /api/export/recharge/xml
```

Returns a fixed-format XML feed for the Recharge platform, including products, variants, stock, prices, and AI-assigned Katalog categories.

---

## Development

```bash
npm run dev
```

## Production

```bash
npm start
```
