# Exports API

An **export** is a named grouping (a category set + AI-categorization toggle +
role/user visibility) that other features hang off of — categories belong to an
export, and the AI-categorization pipeline runs per export.

Base URL: **`https://api.time-4-action.com`** · Mounted at `/api/export/exports`.

> Not to be confused with **Custom Exports** (`/api/export/custom-export`), which
> are the downloadable CSV/JSON/XML configurations. See
> [Custom Exports](custom-exports.md).

---

## Export document

```jsonc
{
  "_id": "664f1a2b3c4d5e6f7a8b9c0d",
  "name": "Tris",
  "description": "",
  "aiCategorizationEnabled": false,
  "roles": [],
  "users": []
}
```

All responses are wrapped in `{ "success": boolean, … }`. Uncaught errors return
`500 { "success": false, "message": "<error>" }`.

> **Note:** deletes here are **hard** deletes, and there is no uniqueness
> constraint on `name`. An invalid ObjectId is treated as *not found* (`404`),
> not a `400`.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/export/exports` | List all exports |
| `POST` | `/api/export/exports` | Create an export |
| `GET` | `/api/export/exports/:id` | Get one export |
| `GET` | `/api/export/exports/:id/ai-status` | Latest AI-categorization run status |
| `PUT` | `/api/export/exports/:id` | Update an export |
| `DELETE` | `/api/export/exports/:id` | Delete an export (hard) |

---

### List all exports

```http
GET /api/export/exports
```

`200 → { "success": true, "data": [ <export>, … ] }`

### Create an export

```http
POST /api/export/exports
Content-Type: application/json
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `name` | string | **Yes** (non-blank) | — |
| `description` | string | No | `""` |
| `aiCategorizationEnabled` | boolean | No | `false` |
| `roles` | array | No | `[]` |
| `users` | array | No | `[]` |

`201 → { "success": true, "data": { … } }` ·
`400 { "success": false, "message": "name is required." }` if `name` is missing/blank.

### Get one export

```http
GET /api/export/exports/:id
```

`200 → { "success": true, "data": <export> }` ·
`404 { "success": false, "message": "Export with id <id> not found." }`.

### AI-categorization status

```http
GET /api/export/exports/:id/ai-status
```

Returns the **latest** AI-categorization run for this export (from
`ai_categorization_runs`), or `null` if it has never run. Poll this while a run is
in progress.

```json
{
  "success": true,
  "run": {
    "exportId": "664f1a2b3c4d5e6f7a8b9c0d",
    "status": "running",
    "error": null,
    "total": 120,
    "processed": 60,
    "categorized": 54,
    "batch": 2,
    "totalBatches": 4,
    "startedAt": "2026-07-10T10:00:00.000Z",
    "finishedAt": null,
    "updatedAt": "2026-07-10T10:01:30.000Z"
  }
}
```

`status` is `running` while batching, `done` on completion (including the
"nothing to do / up-to-date" case), or `failed` (no categories defined, a batch
error with nothing written, or an orchestrator throw — see `error`).

### Update an export

```http
PUT /api/export/exports/:id
Content-Type: application/json
```

Partial update — send any subset of `name`, `description`,
`aiCategorizationEnabled`, `roles`, `users`. Only provided fields are `$set`.

`200 → { "success": true, "data": <updatedExport> }` ·
`404 { "success": false, "message": "Export not found." }`.

### Delete an export

```http
DELETE /api/export/exports/:id
```

**Hard delete.** `200 → { "success": true, "deleted": 1 }` ·
`404 { "success": false, "message": "Export not found." }` when nothing matched.

---

## Related

- [Categories](categories.md) — the category set an export categorizes into.
- [AI Categorization](ai-categorization.md) — synchronous categorization endpoint.
- [Webhooks → AI Categorization](webhooks.md#ai-categorization) — background run
  triggered per export (`aiCategorizationEnabled: true`).
