# Webhooks API

All webhook endpoints are designed to be triggered by **n8n** workflows on a schedule. They respond immediately with `202 Accepted` and run processing in the background.

## Authentication

All webhook endpoints require the `x-api-key` header:

```
x-api-key: <WEBHOOK_API_KEY>
```

The key must match the `WEBHOOK_API_KEY` environment variable.

---

## PNV Product Sync

```http
POST /api/export/webhooks/sync/pnv
```

Triggers a full product sync from PNV (Partner.net Vision). The entire pipeline runs in the background:

1. Authenticates with PNV and triggers a CSV export
2. Downloads the resulting CSV file
3. Parses and enriches each product with stock (Metakocka) and pricelist (Metakocka)
4. Upserts all products into MongoDB (`products` collection)
5. Products no longer in the CSV are soft-deleted (`active: false`)

### Request

```http
POST /api/export/webhooks/sync/pnv
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "webhook": "https://your-n8n/webhook/abc123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `webhook` | string | No | URL to POST results to when sync completes |

### Response `202 Accepted`

```json
{
  "message": "PNV product sync started.",
  "startedAt": "2026-01-15T10:00:00.000Z"
}
```

### Callback Payloads

**Success:**

```json
{
  "event": "pnv_sync_completed",
  "success": true,
  "startedAt": "2026-01-15T10:00:00.000Z",
  "finishedAt": "2026-01-15T10:05:30.000Z",
  "durationMs": 330000,
  "stats": {
    "totalProcessed": 125,
    "productsCreated": 5,
    "productsUpdated": 120,
    "productsDeactivated": 2
  }
}
```

**Failure:**

```json
{
  "event": "pnv_sync_completed",
  "success": false,
  "startedAt": "2026-01-15T10:00:00.000Z",
  "finishedAt": "2026-01-15T10:00:05.000Z",
  "durationMs": 5000,
  "error": "Failed to download CSV from PNV."
}
```

---

## AI Categorization

```http
POST /api/export/webhooks/sync/ai-categorization
```

Runs AI category identification (Google Gemini) on products that have not yet been categorized.

- **No body** = runs for all exports with `aiCategorizationEnabled: true`
- **With `exportId`** = runs only for that specific export

### Request -- All Exports

```http
POST /api/export/webhooks/sync/ai-categorization
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "webhook": "https://your-n8n/webhook/abc123"
}
```

### Request -- Single Export

```http
POST /api/export/webhooks/sync/ai-categorization
x-api-key: <WEBHOOK_API_KEY>
Content-Type: application/json

{
  "exportId": "664f1a2b3c4d5e6f7a8b9c0d",
  "webhook": "https://your-n8n/webhook/abc123"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exportId` | string | No | Limit to a specific export |
| `webhook` | string | No | URL to POST results to when done |

### Response `202 Accepted`

```json
{
  "message": "AI categorization started for 2 export(s).",
  "exportIds": ["664f1a2b3c4d5e6f7a8b9c0d", "664f1a2b3c4d5e6f7a8b9c0e"],
  "startedAt": "2026-01-15T10:05:00.000Z"
}
```

### Callback Payloads

**Success:**

```json
{
  "event": "ai_categorization_completed",
  "success": true,
  "startedAt": "2026-01-15T10:05:30.000Z",
  "finishedAt": "2026-01-15T10:07:00.000Z",
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

**Failure:**

```json
{
  "event": "ai_categorization_completed",
  "success": false,
  "startedAt": "2026-01-15T10:05:30.000Z",
  "finishedAt": "2026-01-15T10:06:00.000Z",
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

---

## Recharge XML

```http
GET /api/export/recharge/xml
```

Returns a fixed-format XML feed for the Recharge platform, including products, variants, stock, prices, and AI-assigned Katalog categories.

---

## Chaining Webhooks in n8n

Pass the URL of the next n8n workflow as the `webhook` field. When processing finishes, the API calls that URL and n8n immediately fires the next step:

```
[Schedule] --> POST /webhooks/sync/pnv  { webhook: <n8n AI workflow URL> }
                    |
                    v  (background finishes)
               GET <n8n AI workflow URL>
                    |
                    v
               POST /webhooks/sync/ai-categorization  { webhook: <n8n next step> }
                    |
                    v  (background finishes)
               GET <n8n next step>
```

This allows building full sync pipelines entirely within n8n's visual workflow editor.
