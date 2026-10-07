# Recharge XML Feed

A fixed-format XML product feed for the **Recharge** platform, covering products,
variants, stock, prices, and AI-assigned Katalog categories.

Base URL: **`https://api.time-4-action.com`** · Mounted at `/api/export/recharge`.

---

## Endpoint

```http
GET /api/export/recharge/xml/all
```

- **Auth:** none — this endpoint is **public** (no JWT, no API key).
- **Params / body:** none.

### Response `200 OK`

- `Content-Type: application/xml; charset=utf-8`
- Body is the raw XML feed (not JSON, not wrapped in a `{ success }` envelope).

### Errors

`500 { "success": false, "message": "<error>" }` if feed generation throws.

---

## Example

```bash
curl https://api.time-4-action.com/api/export/recharge/xml/all -o recharge.xml
```
