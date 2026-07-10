# Shopify Integration API

Connects a partner's Shopify store to the portal and keeps it in sync (stock,
product creation, pricing/content, images). Supports **multiple stores per
account** via a store switcher.

Base URL: **`https://api.time-4-action.com`** · Mounted at `/api/export/shopify`.

---

## Auth model for this surface

| Group | Auth |
|-------|------|
| Connection management | JWT + `export` role (ownership re-checked per connection in the controller) |
| OAuth `entry` / `callback` / `callback-custom` | **No JWT** — secured by Shopify OAuth HMAC + a signed `state` nonce; respond with **302 redirects**, not JSON |
| Legacy "Shopify Deprecated" connect (`connect-custom`, `connect-custom-oauth`) | JWT + `export` role + **`beta`** tier |
| `POST /webhooks` | **No JWT** — Shopify HMAC over the raw body |

Errors use a `code`-mapped envelope: `NOT_FOUND`→404, `FORBIDDEN`→403,
`INVALID_ID`/`VALIDATION_ERROR`/`BAD_REQUEST`→400, `SYNC_BUSY`/`NOT_ACTIVE`→409,
`REAUTH_REQUIRED`→401, `SERVER_ERROR`→500.

---

## Endpoints overview

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/entry` | HMAC | Shopify App URL — merchant opens the app from their admin |
| `GET` | `/connect` | JWT+role | Start public-app OAuth; returns authorize URL |
| `GET` | `/callback` | HMAC+state | Public-app OAuth redirect target |
| `POST` | `/connect-custom` | JWT+role+beta | Connect via pasted custom-app Admin API token (deprecated) |
| `POST` | `/connect-custom-oauth` | JWT+role+beta | Bring-your-own OAuth app; returns their authorize URL (deprecated) |
| `GET` | `/callback-custom` | state+HMAC | BYO-OAuth-app redirect target |
| `POST` | `/connection/claim` | JWT+role | Bind a Shopify-initiated pending install to the partner |
| `POST` | `/connection/decline` | JWT+role | Decline + self-uninstall a pending install |
| `GET` | `/status` | JWT+role | Legacy single-store status (+ live locations) |
| `GET` | `/connections` | JWT+role | List all connected stores (switcher) |
| `GET` | `/pricelists` | JWT+role | Distinct pricelist names across the catalogue |
| `GET` | `/connection/:id/detail` | JWT+role | One store + live shop data |
| `GET` | `/connection/:id/reconnect-custom` | JWT+role | Re-OAuth a BYO-app store from stored creds |
| `PUT` | `/connection/:id/config` | JWT+role | Update sync config / location |
| `POST` | `/connection/:id/sync` | JWT+role | Manual "Sync now" (stock) |
| `POST` | `/connection/:id/recreate` | JWT+role | (Un)queue deleted-in-store products for recreation |
| `GET` | `/connection/:id/activity` | JWT+role | Recent runs + map counts + unmatched |
| `DELETE` | `/connection/:id` | JWT+role | Disconnect + uninstall |
| `POST` | `/webhooks` | HMAC | Shopify webhook receiver (uninstall, GDPR) |

---

## OAuth

### `GET /entry`
The app's **App URL**. Shopify loads it (query signed with `hmac`; params
`shop`, `host`, `timestamp`, `session`) when a merchant opens the app. Redirects
(**302**) either back into the portal (already connected) or straight to the
Shopify grant URL. `400` on bad HMAC / shop; on error → `302 …?shopify=error&reason=entry_failed`.

### `GET /connect`
Started by a signed-in portal user. `?shop=<domain>` required.
`200 → { "success": true, "url": "<authorize URL>", "shop": "<domain>" }`. The UI
redirects the browser to `url`.

### `GET /callback`
Public-app OAuth redirect target (`code`, `shop`, `hmac`, `state`, `timestamp`).
Verifies HMAC + signed `state`, persists the connection, then **302**:
- Pending Shopify-initiated install → welcome page `…?shop=<shop>&claim=<claimToken>`
- Normal install → `<returnUrl>?shopify=connected&shop=<shop>` (`&webhooks=partial`
  if some webhook registrations failed)

On failure → `302 <returnUrl>?shopify=error&reason=<code>`.

### Legacy "Shopify Deprecated" connect (beta tier)
- `POST /connect-custom` — body `{ shop, accessToken }` (Admin API token, `shpat_…`).
  `200 → { success, connection }` (`authMethod: 'custom_app'`).
- `POST /connect-custom-oauth` — body `{ shop, clientId, clientSecret }`; returns
  `{ success, url, shop }`; the install completes at `/callback-custom`.
- `GET /callback-custom` — BYO-app redirect target; verifies signed `state` +
  that app's own HMAC; **302** to the prerelease return URL.

---

## Claim / decline

Shopify-initiated installs land as **pending** and must be claimed by an approved
partner.

- `POST /connection/claim` — body `{ shop, claimToken }`. Binds the pending
  install and activates it (idempotent). `200 → { success, connection }`.
- `POST /connection/decline` — body `{ shop, claimToken }`. Self-uninstalls the
  app from Shopify and deletes the pending row (idempotent).
  `200 → { success: true }`.

Both take the one-time `claimToken` from the welcome URL; missing fields → `400 BAD_REQUEST`.

---

## Connection management

Ownership is enforced per connection: a connection not owned by the caller →
`403 FORBIDDEN`; unknown id → `404 NOT_FOUND`.

### `GET /status`
Legacy single-store view for the current user.

```json
{ "success": true, "connected": true, "connection": { … }, "locations": [ … ],
  "publications": [ … ], "publishingEnabled": true, "needsReconnect": false }
```

When not connected: `{ success:true, connected:false, connection:null, locations:[], needsReconnect:false }`.
May include `"uninstalled": true` if a lazy uninstall was detected.

### `GET /connections`
Lightweight list (no Shopify calls) powering the store switcher:
`{ "success": true, "connections": [ … ] }`.

### `GET /pricelists`
Distinct pricelist names across the catalogue (seeds the pricing panel):
`{ "success": true, "pricelists": [ … ] }`.

### `GET /connection/:id/detail`
One owned connection + live shop data:
`{ success, connection, locations, publications, publishingEnabled, needsReconnect }`.

### `GET /connection/:id/reconnect-custom`
Re-runs OAuth for a BYO-app (`custom_oauth`) store using stored credentials.
`200 → { success, url }`. `400 BAD_REQUEST` if the connection isn't `custom_oauth`
or credentials are missing.

### `PUT /connection/:id/config`
Updates sync config / location. Body is an arbitrary config object (e.g. source
selection, `shopifyLocationId`, ownership/pricing settings); empty `{}` allowed.
Never triggers a sync. `200 → { success, data: <updatedConnection> }`.

### `POST /connection/:id/sync`
Manual stock-only "Sync now"; starts a background run under the per-shop queue
lock. `202 → { success, job }` where `job` is an activity row
(`{ id, type, status, attempts, time, label, detail, trigger, startedAt, finishedAt, counts, scopes, error, errors }`).
`409 SYNC_BUSY` if a run is already in progress; `400 NO_LOCATION` / `NO_EXPORT_CONFIG`;
`401 REAUTH_REQUIRED`.

### `POST /connection/:id/recreate`
(Un)queues deleted-in-store handoff products for recreation on the next sync.
Body `{ parentCodes: string[], cancel?: boolean }` (`parentCodes` required,
non-empty; `cancel: true` undoes a queued recreation).
`200 → { success, flagged, deletedInStore: [ … ] }`.

### `GET /connection/:id/activity`
Recent runs + aggregate map counts + latest unmatched list + deleted-in-store
groups. `?limit=` (default 20, clamped 1–100).

```json
{
  "success": true,
  "jobs": [ /* activity rows */ ],
  "counts": { "synced": 0, "pending": 0, "error": 0 },
  "unmatched": [ /* SKUs not matched in the latest run */ ],
  "deletedInStore": [ { "parentCode": "…", "skus": [ … ], "deletedInStoreAt": "…", "recreateRequested": false } ]
}
```

### `DELETE /connection/:id`
Uninstalls the app from Shopify (skipped for `custom_app`) and deletes the
record, product map, and sync history. `200 → { success, message: "Disconnected" }`.
A self-uninstall failure is swallowed (local records are still removed).

---

## Webhooks

### `POST /webhooks`
Single receiver for all Shopify topics, dispatched by `X-Shopify-Topic` and
verified via `X-Shopify-Hmac-Sha256` over the **raw** request body (shared app
secret, with per-connection app-secret fallback for `custom_oauth`).

Handled topics: `app/uninstalled`, `shop/redact`, `customers/redact`,
`customers/data_request` (GDPR). Always `200 → { "received": true }` on a valid
HMAC (handler errors are logged, not retried). Invalid HMAC →
`401 { "message": "Invalid webhook HMAC" }`.
