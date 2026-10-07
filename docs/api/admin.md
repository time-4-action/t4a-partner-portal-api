# Admin API (Internal)

> **Internal surface.** These endpoints are consumed **server-side** by the
> internal *t4a-admin* app — not by partners or browsers. They live outside the
> `/api/export` tree.

Base URL: **`https://api.time-4-action.com`**.

---

## Authentication

All `/api/admin/*` routes are guarded by a shared bearer token
(`PARTNER_ADMIN_TOKEN`) that never reaches a browser:

```
Authorization: Bearer <PARTNER_ADMIN_TOKEN>
```

- `401 { "message": "Unauthorized: invalid or missing bearer token." }` — bad/missing token.
- `500 { "message": "Admin token not configured on server." }` — server var unset.

No secrets (Shopify tokens, feed auth tokens, claim hashes) are ever returned.
Failures return `{ "success": false, "error": "<msg>" }` at `500`.

---

## Partners API — `/api/admin/partners`

`:sub` is an Auth0 sub (e.g. `auth0|123`), **URL-encoded** by the caller.
`/overview` is declared before `/:sub` so it isn't swallowed by the param route.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/overview` | Per-partner activity rollup |
| `GET` | `/:sub` | Full detail for one partner |
| `GET` | `/:sub/activity` | Reverse-chronological event stream |
| `GET` | `/:sub/notes` | List admin notes |
| `POST` | `/:sub/notes` | Add an admin note |
| `DELETE` | `/:sub/notes/:noteId` | Delete a note |

### Overview

```http
GET /api/admin/partners/overview?subs=auth0|a,auth0|b
```

`?subs=` is an optional comma-separated filter (omit for all).

```json
{
  "success": true,
  "partners": [
    {
      "ownerSub": "auth0|a", "email": "p@example.com",
      "shopifyConnections": { "total": 2, "active": 2, "lastSyncAt": "…", "lastSyncStatus": "ok" },
      "exports": { "configs": 3, "downloads30d": 41 },
      "feeds": { "total": 1, "active": 1, "lastImportAt": "…", "lastResult": "ok" },
      "lastActiveAt": "…", "loginCount": 12,
      "topEvents": [ { "eventType": "export_download", "count": 30 } ]
    }
  ]
}
```

### Partner detail

```http
GET /api/admin/partners/:sub
```

Returns `{ success, partner }` with `connections`, `syncJobs` (≤20), `feeds`
(secrets stripped to `feed: { url, authHeaderName }`), `exportConfigs`,
`recentDownloads` (≤20), and a `mostInteractedWith` breakdown (top events + top
exports).

### Activity stream

```http
GET /api/admin/partners/:sub/activity?limit=100
```

`?limit=` default 100, clamped 1–500. `200 → { success, events: [ <activity_log doc> ] }`.

### Notes

```http
GET    /api/admin/partners/:sub/notes
POST   /api/admin/partners/:sub/notes      # { text, authorName?, authorEmail? }
DELETE /api/admin/partners/:sub/notes/:noteId
```

- List → `{ success, notes: [ { ownerSub, text, authorName, authorEmail, createdAt, _id } ] }` (newest first).
- Add → `201 { success, note }`; `text` required (`400 { error: "text is required" }`);
  `authorName` defaults to `"Admin"`.
- Delete → `200 { success: true }`; `400 { error: "invalid note id" }` on bad
  ObjectId; `404 { error: "note not found" }`.

---

## Catalogue Sync API — `/api/admin/system`

Status + manual triggers for the in-app schedulers behind the t4a-admin
"Catalogue Sync" page.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/sync` | Unified status of all schedulers |
| `POST` | `/sync/pnv/run` | Trigger the full PNV pipeline |
| `POST` | `/sync/own-sources/:feedId/run` | Trigger one Own Source import |

### Status

```http
GET /api/admin/system/sync
```

```json
{
  "success": true,
  "pnv": { "…": "pnvScheduler state + isRunning + run history" },
  "ownSources": {
    "enabled": true,
    "feeds": [ { "feedId": "point7", "brand": "Point-7", "ownerEmail": "…", "status": "active",
                 "scheduleEnabled": true, "frequency": "every_hours", "nextRunAt": "…",
                 "isRunning": false, "health": { "lastImportAt": "…", "lastResult": "ok", "lastError": null, "counts": { … } } } ],
    "runs": [ /* up to 20 external_import_runs, newest first */ ]
  },
  "shopifyCleanup": { "intervalMs": 0, "pendingTtlMs": 0, "lastSweepAt": "…", "lastRemoved": 0 }
}
```

`ownSources.enabled` is `false` only when `EXTERNAL_SCHEDULER=off`.

### Trigger PNV pipeline

```http
POST /api/admin/system/sync/pnv/run
```

Runs PNV → AI categorization → Shopify push on demand.
`202 → { success, message: "Catalogue refresh started.", startedAt }` ·
`409 { success:false, error:"A catalogue refresh is already running.", reason }`.

### Trigger one Own Source import

```http
POST /api/admin/system/sync/own-sources/:feedId/run
```

Same path as the scheduler/webhook (fire-and-forget). **Does not** enforce feed
ownership (bearer-gated only). `202 → { success, message: "Import started for feed
<feedId>.", startedAt }` · `400 { error: "feedId is required." }` ·
`409 { error: "An import is already running for this feed." }`.
