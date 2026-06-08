# Shopify Integration — Design Document

> Status: **Draft / proposal** — design frozen; **front-end UI built (mock data), backend not started.**
> Scope: Let each partner connect their own Shopify store to the T4A Partner Portal and receive automated, near-live syncs of stock, new products, prices, descriptions, and images — driven from the existing PNV → Metakocka → MongoDB pipeline.

---

## 0. Implementation Status (living checklist)

| Layer | Status | Where |
|---|---|---|
| Design doc | ✅ Done | this file (in both `t4a-partner-portal-ui` and `t4a-partner-portal-api`) |
| Partner-facing UI | ✅ Built — **UI-only, mock data** | UI repo: `src/components/ShopifyIntegrationPage.js`, route `src/app/(protected)/integrations/shopify/`, nav link in `Navbar.js` |
| `nextapi` proxies (`/api/export/shopify/*`) | ⬜ Not started | UI repo: would live under `src/app/nextapi/...` |
| OAuth connect/callback | ⬜ Not started | this repo (§5) |
| Mongo collections (`shopify_connections`, `shopify_product_map`, `shopify_sync_jobs`) | ⬜ Not started | this repo (§6) |
| Sync engine + rate-limited queue | ⬜ Not started | this repo (§8) |
| Webhooks (uninstall, GDPR) | ⬜ Not started | this repo (§5.4) |

**To continue:** the UI's `connect / disconnect / syncNow / saveConfig` handlers and its `MOCK_*` constants are the seams — replace them with calls to the proxies once the backend exists. Open questions in §11 still need answers (esp. pricing/VAT and ownership default) before backend work starts.

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
- Two-way conflict resolution beyond a simple ownership rule (see §9).

---

## 2. Current Building Blocks (what we already have)

| Capability | Where | Reuse |
|---|---|---|
| Product data in Mongo | `products` collection | Source of truth for catalog |
| Stock + price enrichment | `services/metakocka/*` | Stock/price values |
| PNV sync pipeline | `services/pnv/*`, webhook `POST /webhooks/sync/pnv` | Sync trigger point |
| Shopify field mapping | `services/customExport.service.js` (`FIELD_MAPPINGS`, shopify preset) | Field transform logic |
| Price resolution from pricelists | `getPriceFromPriority()` in `customExport.service.js` | Pick one price per variant |
| Per-export access / API keys | `export_configs`, access middleware | Partner scoping |
| Auth (portal users) | Auth0 | Identify which partner is connecting |
| Scheduling | n8n (external) | Recurring/full reconcile jobs |

**Estimated groundwork already done: ~50–60%.** The new work is the Shopify-side connection + push layer, plus mapping/state tracking.

---

## 3. Source Product Data Model (IMPORTANT — read before designing the push)

A product in the `products` collection is a **parent** that usually holds a `child_products` array of **variants**. **Variants are the sellable SKUs**; the parent groups them and carries shared content (description, image gallery, categories). This maps cleanly onto Shopify's *product → variants* model.

### 3.1 Parent product (the Shopify "product")
| Field | Meaning | Shopify target |
|---|---|---|
| `code` | Internal product code | — (grouping key) |
| `token` | URL handle, e.g. `"chase-dw-x-downwind"` | product **handle** |
| `product_name` | Display name | product **title** |
| `short_description` / `detailed_description` | HTML copy | product **body_html** |
| `images[]` | Gallery URLs | product **media** |
| `categories[]` | PNV category path | tags / type |
| `ai_categories[]` | `{ exportId, categoryId, categoryName }` per export | collection/tags (per export) |
| `published`, `active`, `archived` | Status flags | publish gate |
| `stock_amount` | Often `0` — variants carry stock | — |
| `pricelist[]` | Often empty — variants carry pricing | — |

### 3.2 Variant (`child_products[]` — the Shopify "variant")
| Field | Meaning | Shopify target |
|---|---|---|
| `code` | **SKU** (primary match key) | variant **sku** |
| `ean_code` | **Barcode** (fallback match key) | variant **barcode** |
| `size` | Variant option value, e.g. `"77"` | **Option1 value** (name `"Size"`) |
| `product_name` | Variant name | — / fallback option value |
| `stock_amount` | Per-variant quantity | inventory level |
| `images[]` | Variant-specific image(s) | variant image |
| `pricelist[]` | Named price lists (see §3.3) | variant **price** (resolved) |
| `published`, `archived`, `cart`, `new`, `recomended` | Per-variant flags | publish gate / tags |
| `token` | Variant handle | — |

### 3.3 `pricelist[]` — there is **no single price field**
Each variant (or no-variant parent) holds an array of named price lists:
```json
"pricelist": [
  { "name": "RRP 2025", "valid_from": "2025-08-07T22:00:00Z", "price": 1434.43, "vat": 22 },
  { "name": "RRP 2026", "valid_from": "2025-10-31T22:00:00Z", "price": 1750,    "vat": 0  }
]
```
Implications for the push:
- A single price must be **resolved** from this array — reuse `getPriceFromPriority(variant, pricelistPriority)`, where `pricelistPriority` comes from the connection config.
- **VAT differs per list** (`22` vs `0`). The chosen list determines whether the number is tax-inclusive. The push must apply a consistent rule (e.g. "push tax-inclusive price + let Shopify treat prices as tax-inclusive", or strip VAT). **Decide once, per connection.** (Open question §11.)
- `valid_from` can be **future-dated** (a 2026 list seeded in 2025). `getPriceFromPriority` currently ignores dates — if partners must not see a future price early, add a `valid_from <= now` guard. (Open question §11.)

### 3.4 Publishing & edge cases
- Both parents **and** individual variants have a `published` flag. A published parent can contain unpublished variants (e.g. a size that isn't on sale yet) — those are excluded everywhere. **Exports/sync are always published-only.**
- **No-variant products:** if `child_products` is empty, the parent itself is the sellable item — use the parent's own `code`, `pricelist`, `stock_amount`.
- Stock lives on variants; the parent's `stock_amount` is frequently `0` and must **not** be used as the product total when variants exist.

### 3.5 Worked example — `Chase DW-X Downwind SUP`
- 1 parent (`code: CHASE_DW_X_DOWNWIND`, handle `chase-dw-x-downwind`) → 1 Shopify product.
- 8 variants by size (`77 … 144`). Size `133` is `published: false`, `stock_amount: 0` → **skipped**. The other 7 → Shopify variants, Option1 "Size" = `77/86/94/101/111/122/144`.
- Each variant: `sku = code` (`P02250013077`), `barcode = ean_code` (`4262434062252`), inventory = `stock_amount` (1), price resolved from its `pricelist` per the connection's priority.
- Parent gallery (5 images) → product media; each variant's own image → variant image.

---

## 4. High-Level Architecture

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
1. **Control plane** — OAuth connect/disconnect, status, configuration (which products, which Shopify location, pricelist priority, ownership).
2. **Data plane** — the sync engine that turns parent + `child_products` state into Shopify Admin API calls, through a per-shop rate-limited queue.

---

## 5. OAuth & App Model

### 5.1 App type decision
- **Custom/partner-built app via OAuth (recommended start).** You register one app in your Shopify Partner account. Each partner installs it into their store through the standard OAuth grant. No Shopify App Store review needed if distributed as a custom/unlisted app to known partners.
- **Public app (App Store)** — only if you want self-serve discovery by strangers. Requires Shopify review (slow, strict). **Defer.**

### 5.2 Required scopes (least privilege)
```
read_products, write_products
read_inventory, write_inventory
read_locations
```
Image management is covered by `write_products`. Request only what each phase needs.

### 5.3 OAuth flow (Authorization Code grant)
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

### 5.4 Security must-dos
- **Verify HMAC** on the OAuth callback and on every incoming Shopify webhook.
- **`state` nonce** signed + bound to the portal user (Auth0 `sub`) to prevent CSRF / shop hijack.
- **Encrypt access tokens at rest** (e.g. AES-GCM with a key from env / secrets manager). Never log tokens.
- Validate the `shop` domain against `*.myshopify.com` regex.
- Honor GDPR mandatory webhooks (`customers/redact`, `shop/redact`, `customers/data_request`) — even if no-op, must respond 200.

---

## 6. Data Model (new Mongo collections)

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
    exportConfigId: ObjectId | null,   // which products to sync (reuse export_configs filters)
    pricelistPriority: [ { name, enabled, priority } ], // resolve pricelist[] -> one price
    priceVatMode: "inclusive" | "exclusive", // how to treat pricelist vat (see §3.3)
    syncStock: true,
    syncNewProducts: true,
    syncPrices: true,
    syncDescriptions: true,
    syncImages: false,                 // off by default (expensive)
    ownership: "stock_only"            // see §9
  },
  installedAt, updatedAt,
  lastSyncAt, lastSyncStatus
}
```

### `shopify_product_map`
The **heart of the system.** Links one parent/variant to its counterpart in a specific shop.
```js
{
  _id,
  connectionId: ObjectId,
  shopDomain: "...",
  parentCode: "CHASE_DW_X_DOWNWIND",       // products.code
  variantCode: "P02250013077",             // child_products[].code (the SKU); null for no-variant parent
  sku: "P02250013077",                     // matching key (== variantCode, or parent.code)
  barcode: "4262434062252",                // child_products[].ean_code
  shopifyProductId: "gid://shopify/Product/...",
  shopifyVariantId: "gid://shopify/ProductVariant/...",
  shopifyInventoryItemId: "gid://shopify/InventoryItem/...",
  lastHash: "<hash of last-pushed field set>", // for delta detection
  lastPushedAt,
  state: "synced" | "pending" | "error",
  error: null
}
```
Indexes: `{ connectionId: 1, sku: 1 }`, `{ connectionId: 1, parentCode: 1 }`.

### `shopify_sync_jobs`
Queue / audit of work units.
```js
{
  _id,
  connectionId,
  type: "inventory" | "product_create" | "product_update" | "image",
  payloadRef: { parentCode, variantCode },
  status: "queued" | "running" | "done" | "failed" | "retry",
  attempts: 0,
  nextAttemptAt,
  lastError,
  createdAt, updatedAt
}
```

---

## 7. Matching Strategy (SKU mapping)

The single biggest operational risk. Rules, in priority order, applied **per variant** (`child_products[]`):
1. **SKU match** — our `child_products[].code` ↔ Shopify variant `sku`. Primary key.
2. **Barcode/EAN match** — fallback on `child_products[].ean_code` ↔ Shopify variant `barcode`.
3. **No match + `syncNewProducts`** → create the product + variants in Shopify, record the returned IDs in `shopify_product_map`.
4. **No match + create disabled** → log to a "needs attention" report, skip.

For **no-variant parents**, match on `products.code` / `products.ean_code` instead.

Once a map row exists, it is **authoritative** — future syncs use stored IDs, not re-matching. Re-match only runs for unmapped items.

Edge cases to handle explicitly:
- Duplicate SKUs in the partner's store.
- SKU changed on our side (treat as new; old map row goes stale → reconcile job).
- Variant added/removed on a parent (`child_products` grew/shrank).
- A variant flipping `published` false→true or true→false (add/remove on Shopify, or just toggle inventory).

---

## 8. Sync Engine

### 8.1 Trigger points
- **Delta push** — at the end of the existing PNV sync job, enqueue jobs only for products whose relevant fields changed (compare `lastHash`). This gives the "live-ish" behavior.
- **Full reconcile** — scheduled via n8n (e.g. nightly), walks every mapped product to self-heal drift.
- **On connect** — initial full push (or initial map-only dry run + report).
- **Manual** — "Sync now" button per connection in the UI.

### 8.2 Building the per-variant payload
For each parent, after the always-on published-only narrowing (drop unpublished parents, keep only published `child_products`):
- Resolve each variant's price via `getPriceFromPriority(variant, connection.config.pricelistPriority)`, applying `priceVatMode`.
- Map fields per §3.1/§3.2. Reuse `customExport.service.js` mappers where possible — they already know how to turn this shape into Shopify fields.

### 8.3 What gets pushed
| Data | Shopify API (GraphQL Admin preferred) | Source field |
|---|---|---|
| Stock | `inventorySetQuantities` / `inventoryAdjustQuantities` | `child_products[].stock_amount` (+ parent fallback when no variants) |
| New product | `productCreate` + `productVariantsBulkCreate` | parent + `child_products[]`; Option1 = `size` |
| Price | `productVariantsBulkUpdate` | resolved from `pricelist[]` |
| Description/fields | `productUpdate` | `product_name`, `detailed_description`, `categories`/`ai_categories` |
| Images | `productCreateMedia` | parent `images[]` + variant `images[]` |

### 8.4 Delta detection
For each variant, compute a hash of the in-scope fields (e.g. `stock|price|title|body|images`). Compare to `shopify_product_map.lastHash`. Only enqueue + push if changed. Stock-only changes never trigger a full product update.

### 8.5 Rate limiting & queue (mandatory)
- Shopify GraphQL uses a **calculated query-cost / leaky-bucket** model; REST uses a request bucket. Either way you **will** get throttled at scale.
- Per-shop **queue** with concurrency cap + exponential backoff on `429` / `THROTTLED`.
- Respect `Retry-After` (REST) and the `throttleStatus.currentlyAvailable` cost hints (GraphQL).
- Batch where possible (`productVariantsBulkUpdate`, bulk inventory).
- For very large catalogs, consider Shopify **Bulk Operations API** for initial loads.

### 8.6 Failure handling
- Each job retries N times with backoff, then → `failed` + surfaced in a per-connection error report.
- A failed product never blocks the rest of the queue.
- Uninstall webhook (`app/uninstalled`) → mark connection `uninstalled`, stop all jobs, keep map for possible reinstall.

---

## 9. Ownership / Conflict Model (decide BEFORE coding)

The central design question: **who owns the product once it's in the partner's store?**

| Mode | Behavior | Use when |
|---|---|---|
| **`portal_authoritative`** | Portal overwrites the fields it manages on every sync. Partner edits to those fields are lost. | You guarantee correct catalog data; partners are resellers. |
| **`stock_only`** (recommended default) | Portal only touches inventory quantities; never product content. | Partners curate their own listings, just want live stock. |
| **`create_then_handoff`** | Portal creates the product once, then never updates content again (only stock). | Partners customize after import. |

Recommendation: support `stock_only` and `portal_authoritative`, default to `stock_only` for safety, let the partner opt up. Store on `shopify_connections.config.ownership`.

---

## 10. API Surface (new endpoints, under `/api/export/shopify`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/shopify/connect?shop=` | Start OAuth, redirect to Shopify |
| `GET` | `/shopify/callback` | OAuth callback, exchange token, store connection |
| `GET` | `/shopify/status` | Current user's connection(s) + last sync info |
| `PUT` | `/shopify/connection/:id/config` | Set sync scope, location, pricelist priority, VAT mode, ownership |
| `POST` | `/shopify/connection/:id/sync` | Manual "Sync now" |
| `DELETE` | `/shopify/connection/:id` | Disconnect (revoke + delete token) |
| `POST` | `/shopify/webhooks/:topic` | Receive Shopify webhooks (hmac-verified) |

UI: a "Shopify" section on the export/settings page — Connect button, status, toggles for what to sync, location picker, **pricelist priority + VAT mode**, ownership mode, error report, "Sync now".

---

## 11. Open Questions
1. Custom/unlisted app or public App Store app? (Affects review + distribution.)
2. One Shopify app for all partners (correct — many installs of one app) — confirm.
3. Which products does a partner get — tie to an existing `export_configs` filter selection? (Reuse access model.)
4. **Pricing:** which pricelist priority per connection, and how to treat **VAT** (`vat: 22` vs `vat: 0`) — push tax-inclusive vs exclusive?
5. **Future-dated prices:** enforce `valid_from <= now` when resolving, or push as-is?
6. Default ownership mode — `stock_only` vs `portal_authoritative`?
7. Where do secrets live (token encryption key, Shopify app secret) — env vs secrets manager?
8. Image hosting — push our PNV image URLs to Shopify, or re-upload binaries? (URL is cheaper.)
9. Multi-location stores — sync to one location or many?
10. Variant option model — always single Option1 = "Size"? Some products have no `size`/no variants.

---

## 12. Risks (honest)
- **Rate limits** at scale (many shops × many products/variants) — the main engineering tax. Queue is non-negotiable.
- **SKU drift / mismatch** (`child_products[].code`) — the main *support* tax over time.
- **Price/VAT ambiguity** — pricelists carry different VAT and dates; a wrong rule = wrong prices in partner stores.
- **Image sync** — slowest, fiddliest data type.
- **Conflict expectations** — partners surprised their edits get overwritten. Mitigated by ownership mode + clear UI copy.
- **Token security** — a leak exposes partner stores. Encrypt + scope minimally.

---

## 13. Verdict
Fully doable. Nothing exotic in the stack — it's OAuth + a mapping table + a rate-limited push worker layered on the pipeline that already exists. ~50–60% of the foundation (product data, the parent/`child_products` shape, Shopify field mapping, pricelist resolution, sync trigger, per-partner access) is already in place. The new effort is concentrated in: the OAuth/connection layer, the parent/variant → Shopify product/variant mapping + delta state, and the rate-limited sync engine.
