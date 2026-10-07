# API Keys & Access Management

Each [custom export](custom-exports.md) can be shared two ways:

- **API keys** — machine credentials scoped to that one export, used to download
  its CSV/JSON/XML programmatically.
- **Access grants** — other Auth0 users (by email) who may view/download the
  export in the dashboard.

Base URL: **`https://api.time-4-action.com`** · sub-resources of
`/api/export/custom-export/:id`.

---

## Authorization

**All** endpoints on this page require the full owner chain:

```
JWT (Auth0)  +  export role  +  access to :id  +  owner of :id
```

Only the export **owner** can manage its keys and access list. Errors use the
shared Custom Exports envelope:

```json
{ "success": false, "error": "<message>", "code": "<CODE>" }
```

| Code | Status |
|------|--------|
| `INVALID_ID` | 400 |
| `VALIDATION_ERROR` | 400 |
| `NOT_FOUND` | 404 |
| `DUPLICATE_ACCESS` | 409 |
| `SERVER_ERROR` | 500 |

---

## API Keys

### List keys

```http
GET /api/export/custom-export/:id/keys
```

```json
{
  "success": true,
  "data": [
    {
      "keyId": "b6f1…",
      "name": "n8n downloader",
      "keyPrefix": "pk_65c4a1",
      "createdAt": "2026-07-01T09:00:00.000Z",
      "createdBy": "auth0|abc",
      "lastUsedAt": "2026-07-09T14:22:00.000Z",
      "isActive": true
    }
  ]
}
```

The key hash is never returned, and the raw key is not retrievable here.

### Create a key

```http
POST /api/export/custom-export/:id/keys
Content-Type: application/json
```

Body: `{ "name": "n8n downloader" }` — optional label (defaults to `"API Key"`).

```json
{
  "success": true,
  "warning": "Save this key — it will not be shown again.",
  "data": {
    "keyId": "b6f1…",
    "name": "n8n downloader",
    "keyPrefix": "pk_65c4a1",
    "rawKey": "pk_65c4a1_9f3c…<64 hex>",
    "createdAt": "…",
    "createdBy": "auth0|abc",
    "lastUsedAt": null,
    "isActive": true
  }
}
```

> ⚠️ **`rawKey` is shown only once, on this response.** Only its SHA-256 hash is
> stored — it can never be retrieved again. The format is
> `pk_<exportId6>_<64 hex chars>`.

Use the returned key against the [download endpoints](custom-exports.md#download-endpoints)
via `X-Api-Key`. See [Authentication → Export API Keys](authentication.md#export-api-keys).

### Revoke a key

```http
DELETE /api/export/custom-export/:id/keys/:keyId
```

Soft-deletes the key (`isActive: false`).
`200 → { "success": true, "message": "API key revoked" }` ·
`404 NOT_FOUND` if the key/config isn't matched.

---

## Access Grants

### List access

```http
GET /api/export/custom-export/:id/access
```

```json
{
  "success": true,
  "data": [
    { "email": "partner@example.com", "sub": null, "grantedAt": "…", "grantedBy": "auth0|abc" }
  ]
}
```

`sub` stays `null` until the grantee first accesses the export (then it is
lazily filled from their token).

### Grant access

```http
POST /api/export/custom-export/:id/access
Content-Type: application/json
```

Body: `{ "email": "partner@example.com" }` (required; normalized to trimmed
lowercase).

`201 → { "success": true, "data": { "email", "sub": null, "grantedAt", "grantedBy" } }` ·
`400 VALIDATION_ERROR` if email missing/blank · `409 DUPLICATE_ACCESS` if already
granted.

### Revoke access

```http
DELETE /api/export/custom-export/:id/access/:email
```

`:email` is URL-encoded. `200 → { "success": true, "message": "Access revoked" }`.
Revoking a non-existent email still returns `200` as long as the config exists.
