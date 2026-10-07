# Categories API

Categories are the labels an [export](exports.md) categorizes products into. Each
category belongs to an export via a plain-string `exportId`.

Base URL: **`https://api.time-4-action.com`** · Mounted at `/api/export/categories`.

---

## Category document

```json
{ "_id": "683a1f2e4b5c6d7e8f901234", "exportId": "tris", "label": "Windsurf / Boards" }
```

- `exportId` is stored as a **raw string** (no ObjectId cast) and is compared as a
  string against `products.ai_categories[].exportId` during categorization.
- **No uniqueness** is enforced — duplicate labels are possible.
- Deletes are **hard** deletes.

All responses are wrapped in `{ "success": boolean, … }`; uncaught errors return
`500 { "success": false, "message": "<error>" }`.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/export/categories` | List all categories |
| `GET` | `/api/export/categories/by-export/:exportId` | List categories for one export |
| `POST` | `/api/export/categories` | Create a category |
| `POST` | `/api/export/categories/import` | Bulk-insert categories |
| `PUT` | `/api/export/categories/:id` | Rename a category |
| `DELETE` | `/api/export/categories/by-export/:exportId` | Delete all categories for an export |
| `DELETE` | `/api/export/categories/:id` | Delete one category |

---

### List all / by export

```http
GET /api/export/categories
GET /api/export/categories/by-export/:exportId
```

`by-export` filters on `exportId` and sorts by `label` ascending.

`200 → { "success": true, "data": [ <category>, … ] }`

### Create a category

```http
POST /api/export/categories
Content-Type: application/json
```

| Field | Type | Required |
|-------|------|----------|
| `exportId` | string | Yes |
| `label` | string | Yes (trimmed) |

`201 → { "success": true, "data": { "_id", "exportId", "label" } }` ·
`400 { "success": false, "message": "exportId and label are required." }`.

### Bulk import

```http
POST /api/export/categories/import
Content-Type: application/json
```

```json
{
  "exportId": "tris",
  "categories": [ { "label": "Boards" }, { "label": "Sails" }, { "label": "Ostalo" } ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `exportId` | string | Yes | |
| `categories` | array | Yes | Non-empty; each item needs a non-blank `label` |

Items without a usable `label` are dropped; labels are trimmed. Does **not**
dedupe against existing categories.

`201 → { "success": true, "inserted": 3 }` ·
`400` if `exportId` is missing or `categories` is not a non-empty array
(`"exportId and a non-empty categories array are required."`) ·
`400 "No valid category labels found."` if no item has a usable label.

### Rename a category

```http
PUT /api/export/categories/:id
Content-Type: application/json
```

Body: `{ "label": "New label" }` (required, trimmed).

`200 → { "success": true, "data": <updatedCategory> }` ·
`400 "label is required."` · `404 "Category not found."`.

### Delete

```http
DELETE /api/export/categories/:id
DELETE /api/export/categories/by-export/:exportId
```

- `/:id` — deletes one. `200 → { "success": true, "deleted": 1 }` · `404` if
  nothing matched.
- `/by-export/:exportId` — deletes **all** for that export. Always
  `200 → { "success": true, "deleted": <count> }` (no `404`, even when 0).
