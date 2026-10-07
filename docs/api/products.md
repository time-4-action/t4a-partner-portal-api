# Products API

Read access to the synced product catalogue: list, search, and look up single
products, plus AI-category management used by the categorization pipeline.

Base URL: **`https://api.time-4-action.com`**

> **Mount points.** The product router is mounted at both `/api/product` and
> `/api/export/product` — the two are equivalent. This page uses `/api/product`.

---

## Published-only vs. full catalogue

By default these endpoints return the **public** view: only published & active
parents, and each parent's `child_products` narrowed to its published variants.
Unannounced products never leak to anonymous callers.

A caller that presents a valid **`x-api-key`** matching `WEBHOOK_API_KEY` unlocks
the **full catalogue** — including unpublished and inactive parents *and*
variants — on the list, search, and single-product endpoints.

```
x-api-key: <WEBHOOK_API_KEY>
```

The check is non-blocking (`detectApiKey`): an absent or wrong key simply falls
back to the published-only view rather than erroring. See
[Authentication](authentication.md#webhook-key).

---

## Endpoints overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/product` | Optional key | List all products |
| `GET` | `/api/product/search` | Optional key | Search by name / code / EAN |
| `GET` | `/api/product/:code` | Optional key | Single product by code or token |
| `GET` | `/api/product/tsv/:exportId` | Public | Products as TSV (name + AI category) |
| `GET` | `/api/product/with-ai-categories` | Public | Products with AI category for an export |
| `PUT` | `/api/product/:id/ai-category` | Public | Set a product's AI category |
| `DELETE` | `/api/product/:id/ai-category/:exportId` | Public | Remove a product's AI category |
| `DELETE` | `/api/product/ai-categories/export/:exportId` | Public | Clear all AI categories for an export |

> "Optional key" = published-only unless a valid `x-api-key` is supplied.

---

## List all products

```http
GET /api/product
```

Returns every published product (full parent documents). With a valid
`x-api-key`, returns **all** products including unpublished/inactive.

### Response `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "_id": "664f1a2b3c4d5e6f7a8b9c0d",
      "code": "PSW26",
      "ean_code": "3830000000001",
      "product_name": "Patrik S-Wave 2026",
      "published": true,
      "active": true,
      "stock_amount": 12,
      "images": ["https://.../psw26.jpg"],
      "pricelist": [{ "name": "RRP 2026", "price": 199.0 }],
      "ai_categories": [{ "exportId": "tris", "categoryId": "…", "categoryName": "…" }],
      "child_products": [ { "code": "PSW26-75", "published": true, "…": "…" } ]
    }
  ]
}
```

Errors: `500 { "success": false, "message": "Product data is not available." }`.

---

## Search products

```http
GET /api/product/search?q=<query>&cat=<exportId>
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `q` | string | Yes | Search text — **min 2 characters** (trimmed) |
| `cat` | string | No | `exportId` to resolve each result's AI category label |

**Matching order:**

1. Exact `code` / `ean_code` match on a parent → single result.
2. Exact `code` / `ean_code` match on a child variant → that variant.
3. Otherwise a regex search over `product_name`, `code`, `ean_code` (parents and
   children). Multi-word queries require **all** words to match the name.
   Descriptions are intentionally excluded to avoid false positives.

With a valid `x-api-key`, the search spans the full catalogue and returns
unpublished parents and variants too; otherwise only published ones.

### Response `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "code": "PSW26-75",
      "ean_code": "3830000000018",
      "product_name": "Patrik S-Wave 2026 / 75",
      "image": "https://.../psw26.jpg",
      "category": "Windsurf / Boards"
    }
  ]
}
```

`category` is present only when `cat` is supplied (it is `null` if the product has
no AI category for that export).

Errors: `400` if `q` is missing or shorter than 2 characters · `500` on failure.

---

## Get a single product

```http
GET /api/product/:code
```

`:code` is matched against the parent's `code` or `token`, or any child's `code`
or `token`. Published-only by default; full access with a valid `x-api-key`.

### Response `200 OK`

```json
{ "success": true, "data": { "_id": "…", "code": "PSW26", "child_products": [ … ], "…": "…" } }
```

Errors: `404 { "success": false, "message": "Product with code PSW26 not found." }` · `500`.

---

## Products as TSV

```http
GET /api/product/tsv/:exportId
```

Returns a tab-separated file (`Naziv<TAB>Kategorija`) of every product's name and
its AI category label for the given `exportId`. Intended for spreadsheet review.

- `Content-Type: text/tab-separated-values`
- `Content-Disposition: attachment; filename="products.tsv"`

---

## AI category management

These endpoints back the AI-categorization review UI. They operate on the
`products.ai_categories[]` array, keyed by `exportId`.

### Products with AI categories for an export

```http
GET /api/product/with-ai-categories?exportId=<exportId>
```

`exportId` (query) is **required** (`400` if missing). Returns one row per active
product with its resolved category for that export:

```json
{
  "success": true,
  "data": [
    { "_id": "…", "code": "PSW26", "token": "…", "product_name": "Patrik S-Wave 2026",
      "aiCategory": { "exportId": "tris", "categoryId": "…", "categoryName": "…" } }
  ]
}
```

`aiCategory` is `null` when the product has no category for that export.

### Set a product's AI category

```http
PUT /api/product/:id/ai-category
Content-Type: application/json
```

`:id` is the product's MongoDB `_id`. Body:

| Field | Type | Required |
|-------|------|----------|
| `exportId` | string | Yes |
| `categoryId` | string | Yes |
| `categoryName` | string | Yes |

Replaces any existing entry for that `exportId` (pull-then-push). Returns
`{ success: true, data: { _id, code, ai_categories } }`. `400` if a field is
missing · `404` if the product isn't found.

### Remove a product's AI category

```http
DELETE /api/product/:id/ai-category/:exportId
```

Pulls the entry for `:exportId` from the product's `ai_categories`. Returns the
updated projection. `404` if the product isn't found.

### Clear all AI categories for an export

```http
DELETE /api/product/ai-categories/export/:exportId
```

Removes the `:exportId` entry from **every** product that has one.

```json
{ "success": true, "modified": 137 }
```

---

## Examples

```bash
# Public (published only)
curl "https://api.time-4-action.com/api/product/search?q=wave"

# Full catalogue (incl. unpublished/inactive)
curl "https://api.time-4-action.com/api/product" \
  -H "x-api-key: $WEBHOOK_API_KEY"

curl "https://api.time-4-action.com/api/product/PSW26" \
  -H "x-api-key: $WEBHOOK_API_KEY"
```
