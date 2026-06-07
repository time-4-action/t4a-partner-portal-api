# Shopify Integration — Design Document

> Status: **Draft / proposal**
> Scope: Let each partner connect their own Shopify store to the T4A Partner Portal and receive automated, near-live syncs of stock, new products, prices, descriptions, and images — driven from the existing PNV → Metakocka → MongoDB pipeline.

---

## 1. Goals & Non-Goals

### Goals
- A partner connects their Shopify store **once**, via OAuth, with no manual API-key handling on their side.
- The portal **pushes** product data into that store automatically:
  - Live(ish) **stock/inventory** updates.
  - **New product** creation.
  - **Price** updates.
  - **Description / field** updates.
  - **Image** sync.
- Multiple partners, each with an independent store and independent product selection (reuse existing per-export access model).
- Resilient to Shopify rate limits, partial failures, and store uninstalls.

### Non-Goals (initially)
- Pulling orders/sales back from Shopify (one-way push only, for now).
- Editing the partner's theme, checkout, or apps.
- Real-time millisecond sync. "Near-live" = seconds-to-minutes after a source change.
- Two-way conflict resolution beyond a simple ownership rule (see §8).

---

## 2. Current Building Blocks (what we already have)

| Capability | Where | Reuse |
|---|---|---|
| Product data in Mongo | `products` collection | Source of truth for catalog |
| Stock + price enrichment | `services/metakocka/*` | Stock/price values |
| PNV sync pipeline | `services/pnv/*`, webhook `POST /webhooks/sync/pnv` | Sync trigger point |
| Shopify field mapping | `services/customExport.service.js` (`FIELD_MAPPINGS`, shopify preset) | Field transform logic |
| Per-export access / API keys | `export_configs`, access middleware | Partner scoping |
| Auth (portal users) | Auth0 | Identify which partner is connecting |
| Scheduling | n8n (external) | Recurring/full reconcile jobs |

**Estimated groundwork already done: ~50–60%.** The new work is the Shopify-side connection + push layer, plus mapping/state tracking.

---

## 3. High-Level Architecture

```
                       ┌─────────────────────────────────────────────┐
                       │            T4A Partner Portal API            │
                       │                                              │
  PNV CSV ──► PNV sync ─► products (Mongo) ──► Sync Engine ──► Queue ─┼──► Shopify Admin API (per shop)
  Metakocka ─► stock/price          ▲              │                  │
                                    │              ▼                  │
                                    │      shopify_connections        │
                                    │      shopify_product_map        │
                                    │      shopify_sync_jobs          │
                       │            └──────────────┘                  │
                       │                                              │
   Next.js UI ─────────► /shopify/connect (OAuth)                    │
   (partner clicks      /shopify/status                              │
    "Connect Shopify")  /shopify/disconnect                         │
                       └─────────────────────────────────────────────┘
                                    ▲
                                    │ webhooks (app/uninstalled, etc.)
                                    └──────────────── Shopify
```

Two planes:
1. **Control plane** — OAuth connect/disconnect, status, configuration (which products, which Shopify location).
2. **Data plane** — the sync engine that turns Mongo product state into Shopify Admin API calls, through a per-shop rate-limited queue.

---

## 4. OAuth & App Model

### 4.1 App type decision
- **Custom/partner-built app via OAuth (recommended start).** You register one app in your Shopify Partner account. Each partner installs it into their store through the standard OAuth grant. No Shopify App Store review needed if distributed as a custom/unlisted app to known partners.
- **Public app (App Store)** — only if you want self-serve discovery by strangers. Requires Shopify review (slow, strict). **Defer.**

### 4.2 Required scopes (least privilege)
```
read_products, write_products
read_inventory, write_inventory
read_locations
read_product_listings   (if using publications)
```
Add image scopes are covered by `write_products`. Request only what each phase needs.

### 4.3 OAuth flow (Authorization Code grant)
```
1. Partner (logged into portal via Auth0) clicks "Connect Shopify".
2. UI asks for their myshopify domain  → e.g. partner-store.myshopify.com
3. API redirects to:
   https://{shop}/admin/oauth/authorize
     ?client_id=APP_KEY
     &scope=...
     &redirect_uri=https://portal/api/export/shopify/callback
     &state=<signed nonce bound to Auth0 sub>
4. Partner approves on Shopify.
5. Shopify redirects to callback with ?code&shop&state&hmac.
6. API verifies hmac + state, exchanges code for a permanent access token:
   POST https://{shop}/admin/oauth/access_token
7. API stores token in shopify_connections, keyed to the Auth0 sub.
8. API registers mandatory webhooks (app/uninstalled, shop/redact, etc.).
```

### 4.4 Security must-dos
- **Verify HMAC** on the OAuth callback and on every incoming Shopify webhook.
- **`state` nonce** signed + bound to the portal user (Auth0 `sub`) to prevent CSRF / shop hijack.
- **Encrypt access tokens at rest** (e.g. AES-GCM with a key from env / secrets manager). Never log tokens.
- Validate the `shop` domain against `*.myshopify.com` regex.
- Honor GDPR mandatory webhooks (`customers/redact`, `shop/redact`, `customers/data_request`) — even if no-op, must respond 200.

---

## 5. Data Model (new Mongo collections)

### `shopify_connections`
One per connected store.
```js
{
  _id,
  ownerSub: "auth0|...",          // portal user who connected
  ownerEmail: "...",
  shopDomain: "partner.myshopify.com",
  accessTokenEnc: "<encrypted>",  // never plaintext
  scopes: ["read_products", ...],
  shopifyLocationId: "gid://shopify/Location/123",  // inventory target
  status: "active" | "uninstalled" | "error",
  config: {
    exportConfigId: ObjectId | null, // which products to sync (reuse export_configs)
    syncStock: true,
    syncNewProducts: true,
    syncPrices: true,
    syncDescriptions: true,
    syncImages: false,             // off by default (expensive)
    ownership: "portal_authoritative" // see §8
  },
  installedAt, updatedAt,
  lastSyncAt, lastSyncStatus
}
```

### `shopify_product_map`
The **heart of the system.** Links one of our products/variants to its counterpart in a specific shop.
```js
{
  _id,
  connectionId: ObjectId,
  shopDomain: "...",
  productCode: "T4A internal code",        // our parent product key
  variantCode: "T4A variant sku" | null,
  shopifyProductId: "gid://shopify/Product/...",
  shopifyVariantId: "gid://shopify/ProductVariant/...",
  shopifyInventoryItemId: "gid://shopify/InventoryItem/...",
  sku: "...",                              // matching key
  lastHash: "<hash of last-pushed field set>", // for delta detection
  lastPushedAt,
  state: "synced" | "pending" | "error",
  error: null
}
```
Index: `{ connectionId: 1, sku: 1 }`, `{ connectionId: 1, productCode: 1 }`.

### `shopify_sync_jobs`
Queue / audit of work units.
```js
{
  _id,
  connectionId,
  type: "inventory" | "product_create" | "product_update" | "image",
  payloadRef: { productCode, variantCode },
  status: "queued" | "running" | "done" | "failed" | "retry",
  attempts: 0,
  nextAttemptAt,
  lastError,
  createdAt, updatedAt
}
```

---

## 6. Matching Strategy (SKU mapping)

The single biggest operational risk. Rules, in priority order:
1. **SKU match** — our `variant.code` ↔ Shopify variant `sku`. Primary key.
2. **Barcode/EAN match** — fallback on `ean_code` ↔ Shopify variant `barcode`.
3. **No match + `syncNewProducts`** → create the product in Shopify, record the new IDs in `shopify_product_map`.
4. **No match + create disabled** → log to a "needs attention" report, skip.

Once a map row exists, it is **authoritative** — future syncs use stored IDs, not re-matching. Re-match only runs for unmapped items.

Edge cases to handle explicitly:
- Duplicate SKUs in the partner's store.
- SKU changed on our side (treat as new; old map row goes stale → reconcile job).
- Variant added/removed on a parent product.

---

## 7. Sync Engine

### 7.1 Trigger points
- **Delta push** — at the end of the existing PNV sync job, enqueue jobs only for products whose relevant fields changed (compare `lastHash`). This gives the "live-ish" behavior.
- **Full reconcile** — scheduled via n8n (e.g. nightly), walks every mapped product to self-heal drift.
- **On connect** — initial full push (or initial map-only dry run + report).
- **Manual** — "Sync now" button per connection in the UI.

### 7.2 What gets pushed
| Data | Shopify API (GraphQL Admin preferred) | Notes |
|---|---|---|
| Stock | `inventorySetQuantities` / `inventoryAdjustQuantities` | Needs `inventoryItemId` + `locationId` |
| New product | `productCreate` + `productVariantsBulkCreate` | Store returned IDs immediately |
| Price | `productVariantsBulkUpdate` | Per-variant price/compare-at |
| Description/fields | `productUpdate` | Title, body_html, tags, vendor, type |
| Images | `productCreateMedia` | Upload, dedup, order — slowest |

Reuse `customExport.service.js` field mappers to build payloads — that logic already knows how to turn our product into Shopify shapes.

### 7.3 Delta detection
For each product/variant, compute a hash of the fields that are in scope for that connection (e.g. `stock|price|title|body|images`). Compare to `shopify_product_map.lastHash`. Only enqueue + push if changed. Stock-only changes never trigger a full product update.

### 7.4 Rate limiting & queue (mandatory)
- Shopify GraphQL uses a **calculated query-cost / leaky-bucket** model; REST uses a request bucket. Either way you **will** get throttled at scale.
- Per-shop **queue** with concurrency cap + exponential backoff on `429` / `THROTTLED`.
- Respect `Retry-After` (REST) and the `throttleStatus.currentlyAvailable` cost hints (GraphQL).
- Batch where possible (`productVariantsBulkUpdate`, bulk inventory).
- For very large catalogs, consider Shopify **Bulk Operations API** for initial loads.

### 7.5 Failure handling
- Each job retries N times with backoff, then → `failed` + surfaced in a per-connection error report.
- A failed product never blocks the rest of the queue.
- Uninstall webhook (`app/uninstalled`) → mark connection `uninstalled`, stop all jobs, keep map for possible reinstall.

---

## 8. Ownership / Conflict Model (decide BEFORE coding)

The central design question: **who owns the product once it's in the partner's store?**

| Mode | Behavior | Use when |
|---|---|---|
| **`portal_authoritative`** (recommended default) | Portal overwrites the fields it manages on every sync. Partner edits to those fields are lost. | You guarantee correct catalog data; partners are resellers. |
| **`stock_only`** | Portal only touches inventory quantities; never product content. | Partners curate their own listings, just want live stock. |
| **`create_then_handoff`** | Portal creates the product once, then never updates content again (only stock). | Partners customize after import. |

Recommendation: support `stock_only` and `portal_authoritative`, default to `stock_only` for safety, let the partner opt up. Store on `shopify_connections.config.ownership`.

---

## 9. API Surface (new endpoints, under `/api/export/shopify`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/shopify/connect?shop=` | Start OAuth, redirect to Shopify |
| `GET` | `/shopify/callback` | OAuth callback, exchange token, store connection |
| `GET` | `/shopify/status` | Current user's connection(s) + last sync info |
| `PUT` | `/shopify/connection/:id/config` | Set scope of sync, location, ownership mode |
| `POST` | `/shopify/connection/:id/sync` | Manual "Sync now" |
| `DELETE` | `/shopify/connection/:id` | Disconnect (revoke + delete token) |
| `POST` | `/shopify/webhooks/:topic` | Receive Shopify webhooks (hmac-verified) |

UI: a "Shopify" section on the export/settings page — Connect button, status, toggles for what to sync, location picker, error report, "Sync now".

---

## 10. Phased Roadmap

### Phase 1 — Connect + Stock (MVP) · ~2–3 weeks
- OAuth connect/callback/disconnect + encrypted token storage.
- `shopify_connections` + `shopify_product_map`.
- SKU matching + initial map build (dry-run report of matched/unmatched).
- Stock push on PNV sync (delta) + manual "Sync now".
- Rate-limited per-shop queue with retry.
- Uninstall webhook + GDPR webhooks.
- UI: Connect button, status, location picker.

### Phase 2 — New products + Price · ~2–3 weeks
- `productCreate` for unmapped items, record IDs.
- Price sync via bulk variant update.
- Full reconcile job (n8n nightly).
- Error report UI.

### Phase 3 — Descriptions/fields + Images · ~3–4 weeks
- `productUpdate` for content fields (hash-gated).
- Image upload/dedup/order.
- Ownership-mode enforcement.
- Bulk Operations API for big initial loads.

**Solo total: ~1.5–2.5 months** for the full thing; a usable stock-sync MVP in ~3 weeks.

---

## 11. Open Questions
1. Custom/unlisted app or public App Store app? (Affects review + distribution.)
2. One Shopify app for all partners, or per-partner — **one app, many installs** is correct; confirm.
3. Which products does a partner get — tie to an existing `export_configs` selection? (Reuse access model.)
4. Default ownership mode — `stock_only` vs `portal_authoritative`?
5. Where do secrets live (token encryption key, Shopify app secret) — env vs secrets manager?
6. Image hosting — push our PNV image URLs to Shopify, or re-upload binaries? (URL is cheaper.)
7. Multi-location stores — sync to one location or many?

---

## 12. Risks (honest)
- **Rate limits** at scale (many shops × many products) — the main engineering tax. Queue is non-negotiable.
- **SKU drift / mismatch** — the main *support* tax over time.
- **Image sync** — slowest, fiddliest data type.
- **Conflict expectations** — partners surprised their edits get overwritten. Mitigated by ownership mode + clear UI copy.
- **Token security** — a leak exposes partner stores. Encrypt + scope minimally.

---

## 13. Verdict
Fully doable. Nothing exotic in the stack — it's OAuth + a mapping table + a rate-limited push worker layered on the pipeline that already exists. ~50–60% of the foundation (product data, Shopify field mapping, sync trigger, per-partner access) is already in place. The new effort is concentrated in: the OAuth/connection layer, the product-ID mapping + delta state, and the rate-limited sync engine.
