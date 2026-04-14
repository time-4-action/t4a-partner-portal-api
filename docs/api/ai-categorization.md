# AI Categorization API

Categorize any products using the AI categorization engine (Google Gemini 2.5 Flash) against your existing category sets -- without importing them into the system.

This is a **synchronous** endpoint: it processes the request and returns results immediately. Nothing is saved to the database.

> For the **background** categorization of internal products, see [Webhooks -- AI Categorization](webhooks.md#ai-categorization).

---

## Endpoint

```http
POST /api/export/webhooks/categorize
```

### Authentication

```
x-api-key: <WEBHOOK_API_KEY>
```

---

## Request

### Headers

| Header | Required | Value |
|--------|----------|-------|
| `Content-Type` | Yes | `application/json` |
| `x-api-key` | Yes | Your `WEBHOOK_API_KEY` |

### Body

```json
{
  "exportId": "tris",
  "products": [
    {
      "code": "SKU-001",
      "name": "Wireless Bluetooth Headphones",
      "description": "Over-ear noise cancelling headphones with 30h battery",
      "brand": "SoundMax",
      "tags": ["audio", "wireless"]
    },
    {
      "code": "SKU-002",
      "name": "USB-C Charging Cable 2m",
      "description": "Braided nylon fast-charging cable"
    }
  ]
}
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `exportId` | string | Yes | ID of an existing export whose category set should be used |
| `products` | array | Yes | Products to categorize (max **300** per request) |
| `products[].code` | string | Yes | Unique product identifier (used to match results) |
| `products[].name` | string | Yes | Product name -- primary text for AI classification |
| `products[].description` | string | No | Product description -- strongly recommended for accuracy |
| `products[].brand` | string | No | Brand name |
| `products[].tags` | array | No | Tags or keywords |
| `products[].price` | number | No | Price (helps disambiguate categories) |
| `products[].child_products` | array | No | Variants -- AI reads for context but only categorizes the parent |

You can include **any additional fields** on each product object. The AI receives the full object, so more context means better categorization. Only `code` and `name` are strictly required.

---

## Response

### `200 OK`

```json
{
  "results": [
    {
      "code": "SKU-001",
      "categoryId": "683a1f2e4b5c6d7e8f901234",
      "categoryName": "Electronics / Audio"
    },
    {
      "code": "SKU-002",
      "categoryId": "683a1f2e4b5c6d7e8f905678",
      "categoryName": "Accessories / Cables"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `results` | array | One entry per categorized product |
| `results[].code` | string | The `code` from the request |
| `results[].categoryId` | string | MongoDB `_id` of the matched category |
| `results[].categoryName` | string | Human-readable category label |

> Products the AI cannot confidently categorize may be assigned to a fallback category (typically "Ostalo" / "Other") if one exists in your category set.

### Error Responses

| Status | When |
|--------|------|
| `400` | Missing `exportId`, missing/empty `products`, product missing `code` or `name`, or more than 300 products |
| `401` | Missing or invalid `x-api-key` |
| `500` | No categories found for the given `exportId`, or an AI processing error |

---

## How It Works

```
1. You send products + exportId
2. API fetches categories from MongoDB for that exportId
3. Products are sent to Gemini 2.5 Flash in batches of 30
4. AI maps each product to the best-matching category
5. Results returned synchronously (nothing persisted)
```

---

## Examples

### curl

```bash
curl -X POST https://your-server.com/api/export/webhooks/categorize \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-webhook-api-key" \
  -d '{
    "exportId": "tris",
    "products": [
      { "code": "P1", "name": "Red Running Shoes", "description": "Lightweight mesh running shoes" },
      { "code": "P2", "name": "Stainless Steel Water Bottle 750ml" },
      { "code": "P3", "name": "Organic Green Tea 100g", "brand": "TeaHouse", "tags": ["organic", "tea"] }
    ]
  }'
```

### JavaScript (fetch)

```javascript
const response = await fetch('https://your-server.com/api/export/webhooks/categorize', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'your-webhook-api-key',
  },
  body: JSON.stringify({
    exportId: 'tris',
    products: [
      { code: 'P1', name: 'Red Running Shoes', description: 'Lightweight running shoes' },
      { code: 'P2', name: 'Stainless Steel Water Bottle 750ml' },
    ],
  }),
});

const { results } = await response.json();
// results = [{ code: 'P1', categoryId: '...', categoryName: '...' }, ...]
```

### Python (requests)

```python
import requests

resp = requests.post(
    "https://your-server.com/api/export/webhooks/categorize",
    headers={"x-api-key": "your-webhook-api-key"},
    json={
        "exportId": "tris",
        "products": [
            {"code": "P1", "name": "Red Running Shoes", "description": "Lightweight running shoes"},
            {"code": "P2", "name": "Stainless Steel Water Bottle 750ml"},
        ],
    },
)

results = resp.json()["results"]
```

---

## Prerequisites

1. **An export with categories** -- create an export via `POST /api/export/exports` and add categories via `POST /api/export/categories` or `POST /api/export/categories/import`. The `exportId` is the `_id` of that export document.

2. **A valid `WEBHOOK_API_KEY`** -- set in the server environment and passed via `x-api-key` header.

---

## Limits

| Constraint | Value |
|------------|-------|
| Max products per request | 300 |
| Internal batch size | 30 products per AI call |
| Rate limiting | None (each request costs Gemini API tokens) |

For larger datasets, split into multiple requests of up to 300 products each.
