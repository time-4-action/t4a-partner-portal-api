# Own Sources (External Feeds) API

"Own Sources" lets a partner register an **external supplier JSON feed** and
ingest it into the same catalogue/Shopify push as the internal PNV products. Each
feed is owned by the partner who created it.

Base URL: **`https://api.time-4-action.com`** · Mounted at `/api/export/external`.

---

## Authorization

All endpoints require **JWT + `export` role**. Ownership is enforced **per feed**:
a feed not owned by the caller's `sub` → `403 FORBIDDEN`; an unknown `feedId` →
`404 NOT_FOUND`.

Error envelope: `{ "success": false, "error": "<msg>", "code": "<CODE>" }` with
`VALIDATION_ERROR`/`INVALID_ID`→400, `NOT_FOUND`→404, `FORBIDDEN`→403,
`SYNC_BUSY`→409, `SERVER_ERROR`→500.

> **Secrets are write-only.** `feed.authToken` is stored encrypted and never
> returned. The public feed shape exposes only `feed: { url, authHeaderName, hasAuthToken }`.

---

## The feed contract

Feeds must serve JSON matching the fixed **`own-source.v1`** schema
(`schemaVersion 1.0`). Field mapping / format are **not** configurable — `brand`
is the label and the generated `feedId` is the scope key. Validate a feed before
(or after) saving with the `test` endpoints.

### Public feed object

```jsonc
{
  "_id": "…",
  "ownerSub": "auth0|abc",
  "ownerEmail": "partner@example.com",
  "feedId": "point7",
  "brand": "Point-7",
  "status": "active",              // active | paused | error
  "feed": { "url": "https://…/feed.json", "authHeaderName": "X-Api-Key", "hasAuthToken": true },
  "schedule": { "enabled": true, "frequency": "every_hours", "everyHours": 6,
                "timeOfDay": "03:00", "weekday": 1, "timezone": "Europe/Ljubljana" },
  "nextRunAt": "2026-07-10T03:00:00.000Z",
  "options": { "defaultStatus": "active", "removalPolicy": "delist",
               "maxStalenessHours": 48, "allowEmptyFeed": false },
  "health": { "lastFetchAt": "…", "lastValidatedAt": "…", "lastImportAt": "…",
              "lastResult": "ok", "lastError": null,
              "counts": { "products": 0, "variants": 0, "created": 0, "updated": 0, "removed": 0 } },
  "createdAt": "…", "updatedAt": "…"
}
```

---

## Endpoints overview

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/sources` | List the caller's feeds |
| `POST` | `/sources` | Register a feed |
| `GET` | `/sources/:feedId` | Get one feed |
| `PUT` | `/sources/:feedId` | Update a feed |
| `DELETE` | `/sources/:feedId` | Remove a feed + its products |
| `POST` | `/test` | Validate an arbitrary URL (no save) |
| `POST` | `/sources/:feedId/test` | Validate a stored feed |
| `POST` | `/sources/:feedId/import` | Trigger an import now |
| `GET` | `/sources/:feedId/activity` | Import history + health |
| `GET` | `/sources/:feedId/products` | The feed's imported products |

All paths are prefixed `/api/export/external`.

---

### Register a feed

```http
POST /api/export/external/sources
Content-Type: application/json
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `brand` | string | **Yes** | Non-empty; the display label |
| `url` | string | **Yes** | Must match `^https?://` |
| `authHeaderName` | string \| null | No | Header name for feed auth |
| `authToken` | string | No | Write-only; stored encrypted |
| `schedule` | object | No | `enabled`, `frequency` (`every_hours`\|`daily`\|`weekly`), `everyHours`≥1, `timeOfDay` `H:MM`, `weekday` 0–6 (0=Sun), `timezone` |
| `options` | object | No | `defaultStatus` (`active`\|`draft`), `removalPolicy` (`delist`\|`zero_stock`\|`keep`), `maxStalenessHours`>0, `allowEmptyFeed` |

Schedule defaults: `{ enabled:false, frequency:"every_hours", everyHours:6, timeOfDay:"03:00", weekday:1, timezone:"Europe/Ljubljana" }`.
Options defaults: `{ defaultStatus:"active", removalPolicy:"delist", maxStalenessHours:48, allowEmptyFeed:false }`.

`201 → { "success": true, "source": <publicFeed> }` · `400 VALIDATION_ERROR` if
`brand` is missing or `url` is invalid.

### Update a feed

```http
PUT /api/export/external/sources/:feedId
```

Whitelisted partial patch: `brand`, `status` (`active`\|`paused`), `feed`
(`feed.url`, `feed.authHeaderName`, `feed.authToken` — send `""` to clear the
stored token), `options`, `schedule` (changing it recomputes `nextRunAt`).
`200 → { "success": true, "source": <publicFeed> }`.

### Remove a feed

```http
DELETE /api/export/external/sources/:feedId
```

Deletes the feed, its imported products, and unlinks it from any Shopify
connections.
`200 → { "success": true, "removedProducts": <n>, "unlinkedConnections": <n> }`.

### Validate (test)

```http
POST /api/export/external/test              # arbitrary URL, body { url, authHeaderName?, authToken? }
POST /api/export/external/sources/:feedId/test   # stored feed, no body
```

Fetches and validates without persisting anything:

```json
{
  "success": true,
  "ok": true,
  "counts": { "products": 42, "variants": 130 },
  "generatedAt": "…",
  "issues": [ { "path": "products[3].price", "message": "…", "value": null } ],
  "warnings": [ … ],
  "sample": [ { "name": "…", "variants": 3, "price": 19.9, "tags": [ … ] } ]
}
```

A fetch failure still returns `200` with `ok:false` and a `fetchError` field.
`400 VALIDATION_ERROR` if `url` is missing/invalid (arbitrary-URL variant).

### Import now

```http
POST /api/export/external/sources/:feedId/import
```

Fire-and-forget; the run records its own outcome. `202 → { "success": true,
"message": "Import started" }` · `409 SYNC_BUSY` if an import is already running
for that feed.

### Activity & products

```http
GET /api/export/external/sources/:feedId/activity
GET /api/export/external/sources/:feedId/products
```

- **activity** → `{ success, health: { … }, runs: [ { id, trigger, result, counts, error, time } ] }` (last 20).
- **products** → `{ success, count, products: [ <internalProduct> ] }` (includes delisted).

---

## Related

- Admin-triggered imports (bearer-gated, no ownership check): see
  [Admin API → Catalogue Sync](admin.md#catalogue-sync-apiadminsystem).
- Scheduled imports run via the in-app external scheduler (`EXTERNAL_SCHEDULER`).
