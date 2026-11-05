# External Integration — "Own Sources" Design Document

> Companion to [`shopify_integration.md`](./shopify_integration.md) (the outbound push) and its
> progress tracker [`shopify_integration_progress.md`](./shopify_integration_progress.md) (see §5 there).
> This document specifies, in detail, the **inbound** half: how a portal user registers **their own
> supplier feeds** (other brands they resell) so those products flow through the *existing* Shopify push.
> Status: **built** (t4a-partner-portal-api `src/services/external/`). This is the original design
> from 2026-06-10, kept for its reasoning; the code and the API repo's `docs/` are current.

---

## 0. TL;DR

- **Goal:** the portal already pushes **Patrik** to a user's Shopify store. Let the same user also push **other brands they resell** (e.g. **Point-7**) by registering each brand's product **feed** under `integrations/` → **Own Sources**.
- **The expensive half is already built.** The Shopify push (`shopifySync.service.js`) is brand-agnostic: it pushes whatever normalized list `buildScope()` returns. Adding an inbound source touches the engine in exactly **one place** (a `scope.type` branch in `buildScope`). Nothing downstream of the normalized list changes.
- **Contract-first, validate-never-parse.** A feed is **strictly-formatted JSON** validated against a published JSON Schema. Valid → ingested; invalid → **the whole import is rejected** with a precise error report and the catalogue is left untouched. The portal does **no** column-mapping, guessing, or normalization. *"If you want the integration, you follow the format."*
- **Separate collection.** Ingested products live in a new **`external_products`** collection (feed registry in **`own_sources`**) — never mixed into Patrik's `products`. Physical isolation means the PNV prune can never clobber a feed, and dropping a brand is one `deleteMany`.
- **Owner-scoped.** Every ingested row carries `ownerSub` + `feedId`. A user only ever sees / exports / pushes their own feeds (plus Patrik, if entitled).
- **Tags carry through.** The contract lets a feed supply `tags[]` and hierarchical `categoryPaths[]` (the same `"A / B"` → `["A", "A / B"]` expansion Patrik uses), so Shopify tagging stays consistent across brands.

---

## 1. Goals & Non-Goals

### Goals
1. A self-serve **Own Sources** area where a portal user adds/edits/removes their own brand feeds.
2. Pull each feed from a **stable URL on a schedule**, validate it, and ingest it into an isolated collection.
3. Make ingested products **first-class inputs to the existing Shopify push** — stock, price, content, images, **tags** — with zero new push code.
4. Keep the portal **dumb on parsing**: the feed must already be in the canonical shape; the portal validates, it does not transform.
5. Strict **multi-tenant isolation**: a user's feeds are invisible to other users and to the shared Patrik catalogue.

### Non-Goals (initially)
- No column-mapping / CSV / XML ingest UI. **JSON-only**, one published schema. (CSV can be added later by the feed publisher converting on *their* side.)
- No markup/margin engine. The feed states the **price to list**; the portal does not compute margin.
- No delta-feed protocol. Each import is a **full snapshot** (present = upsert, absent = removed). A delta mode is a later optimization.
- No file-drop/SFTP/email ingest initially — **pullable URL only** (an upload fallback is a later add).
- No write-back to the supplier. One-way: supplier → portal → Shopify.

---

## 2. How it fits the existing architecture

```
   INBOUND (this doc — new)                         OUTBOUND (built — shopify_integration.md)
 ┌───────────────────────────────┐
 │ Patrik  → PNV pipeline ────────┼──► products  ──────────┐
 │                                │   (collection)          │
 │ Point-7 → Own Source (JSON) ───┼──► external_products ───┤   buildScope(scope)
 │ Brand C → Own Source (JSON) ───┼──► external_products ───┤   ├─ export_config → applyFilters(products)
 └───────────────────────────────┘                         │   └─ own_source    → readExternalScope(feedId)
                                                            │            │
                                                            │            ▼  (same { products, items } shape)
                                                            └──►  match → shopify_product_map → delta →
                                                                  create / price / content / images / publish
                                                                  → user's Shopify store
```

**The single integration point** is `buildScope()` in `t4a-partner-portal-api/src/services/shopify/shopifySync.service.js:132`. Today it reads `products` and runs `applyFilters`. It will branch on the connection's **scope type** and, for an Own Source, read `external_products` for that feed — returning the **identical** `{ products, items }` contract. Everything after `buildScope` (matching, `shopify_product_map`, `priceHash`/`contentHash` delta, the per-shop queue, Phase B create, Phase C price/content, Phase D images/publish, the auto-triggers) is untouched because it operates on the normalized list, not on Mongo.

**Key reuse decision: store `external_products` in the *internal product shape*.** Because the canonical feed already mirrors the parent/`child_products`/`pricelist` model, the importer stores each product as a document shaped like a `products` row (parent + embedded `child_products[]` + `pricelist[]`). Then:
- `getPriceFromPriority(variant, pricelistPriority)` works unchanged.
- `resolvePushPrice(...)` (VAT mode + future-date guard) works unchanged.
- `resolveTagsArray(product, config)` works with one small branch (see §7).
- `buildScope`'s item-building loop (`child_products` → one row per SKU, barcode = `ean_code`) works unchanged.

So the importer's real job is: **fetch → validate → map canonical JSON 1:1 onto the internal shape → upsert → sweep.**

---

## 3. The feed contract (the product)

A feed is one JSON document = the **complete current catalogue of one brand**. The portal publishes this schema; suppliers conform.

### 3.1 Example feed

```json
{
  "schemaVersion": "1.0",
  "brand": "Point-7",
  "currency": "EUR",
  "generatedAt": "2026-06-10T08:00:00Z",
  "products": [
    {
      "externalId": "P7-AC-X",
      "name": "AC-X Slalom Sail",
      "descriptionHtml": "<p>Cam-induced slalom sail…</p>",
      "vendor": "Point-7",
      "productType": "Sails",
      "status": "active",
      "tags": ["2026", "slalom", "race"],
      "categoryPaths": ["Sails / Slalom", "Race / Slalom"],
      "images": [
        { "src": "https://cdn.point-7.com/acx/hero.jpg", "alt": "AC-X" },
        { "src": "https://cdn.point-7.com/acx/detail.jpg" }
      ],
      "variants": [
        {
          "sku": "P7-ACX-58",
          "barcode": "4012345678901",
          "option1": "5.8",
          "stock": 12,
          "price": { "amount": 699.00, "vat": 22, "taxMode": "gross" },
          "image": "https://cdn.point-7.com/acx/58.jpg"
        },
        {
          "sku": "P7-ACX-62",
          "barcode": "4012345678902",
          "option1": "6.2",
          "stock": 4,
          "price": { "amount": 729.00, "vat": 22, "taxMode": "gross" }
        }
      ]
    }
  ]
}
```

### 3.2 Field reference

**Envelope**

| Field | Req | Type | Notes |
|---|---|---|---|
| `schemaVersion` | ✅ | string enum | Must match a version the portal supports (`"1.0"`). Mismatch → reject. |
| `brand` | ✅ | string | Becomes the Shopify `vendor` default and a UI label. |
| `currency` | ✅ | ISO-4217 | Must match the store/connection currency (warn on mismatch). |
| `generatedAt` | ✅ | ISO-8601 UTC | Staleness check; rejected if absurdly old/future is a config option. |
| `products` | ✅ | array | The full snapshot. Empty array is **valid** but treated cautiously (see §6.4 wipe-guard). |

**Product (parent)**

| Field | Req | Type | Maps to internal | Notes |
|---|---|---|---|---|
| `externalId` | ✅ | string | `code` (parent) / grouping key | Stable id of the parent in the supplier's system. Unique within a feed. |
| `name` | ✅ | string | `product_name` | |
| `descriptionHtml` | ➖ | string (HTML) | `detailed_description` | Sanitized at ingest (allow-list). |
| `vendor` | ➖ | string | Shopify `vendor` | Defaults to `brand`. |
| `productType` | ➖ | string | `categories[0]` / Shopify `type` | |
| `status` | ➖ | enum `active`\|`draft` | `published` | Default `active`. |
| `tags` | ➖ | string[] | → `resolveTagsArray` (§7) | Flat tags, pushed as-is. |
| `categoryPaths` | ➖ | string[] | → expanded tags (§7) | `"A / B"` paths; hierarchically expanded like Patrik's AI categories. |
| `images` | ➖ | `{src, alt?}[]` | `images[]` | `src` must be a public https URL Shopify can fetch. `alt` defaults to `name`. |
| `variants` | ✅ | array (≥1) | `child_products[]` | A single-variant product is fine; see no-variant note. |

**Variant**

| Field | Req | Type | Maps to internal | Notes |
|---|---|---|---|---|
| `sku` | ✅ | string | `code` (variant) | **Identity key.** Globally unique within the feed. Drives Shopify SKU→variant matching. |
| `barcode` | ➖ | string | `ean_code` | Barcode fallback for matching. |
| `option1` | ➖ | string | `size` | The variant option value (e.g. sail size). Falls back to SKU for sizeless. |
| `stock` | ✅ | int ≥0 | `stock_amount` | Pushed to the chosen Shopify location. |
| `price` | ✅ | object | `pricelist[]` (one entry) | See below. |
| `image` | ➖ | https URL | variant `images[0]` | Variant-linked image. |

**Price object** — *resolves the entire VAT/markup ambiguity at the contract level:*

| Field | Req | Type | Notes |
|---|---|---|---|
| `amount` | ✅ | number ≥0 | The price the supplier wants **listed** (not cost). Markup is the supplier's job. |
| `vat` | ✅ | number | VAT rate %, mirrors `pricelist[].vat`. |
| `taxMode` | ✅ | enum `gross`\|`net` | How `amount` is expressed. Normalized to the portal's NET convention at ingest (see §3.3). |

### 3.3 Price normalization (ingest-side, deterministic)

The portal's internal `pricelist[].price` is **NET** (the existing exports treat "Price" as net; "Price with VAT" = net × (1+vat/100) — see `customExport.service.js:112-115`). So at ingest the importer normalizes:

- `taxMode: "net"`  → `pricelist.price = amount`
- `taxMode: "gross"` → `pricelist.price = amount / (1 + vat/100)`

Then the **existing** `resolvePushPrice` applies the *connection's* VAT push mode (`inclusive`/`exclusive`) on top — exactly as it does for Patrik. One pricelist entry is synthesized per variant:

```js
pricelist: [{ name: `${brand} Feed`, valid_from: generatedAt, price: <net>, vat }]
```

The connection's `pricelistPriority` should include `"<brand> Feed"` (auto-added when a feed is linked to a connection). Future-dated guard (Q5) is a no-op here since the feed carries current prices, but the machinery still applies.

### 3.4 What the contract deliberately removes

| Old hard problem (column-map design) | Resolved by the contract |
|---|---|
| Per-supplier column mapping | One schema; supplier conforms. |
| Wholesale vs retail / markup math | `price.amount` is the listed price; supplier bakes margin in. |
| Gross/net ambiguity | `taxMode` is explicit; normalized deterministically. |
| Encoding / malformed-cell handling | Invalid JSON or schema violation → reject whole import. |
| Variant grouping heuristics | `externalId` groups; `sku` identifies. Stated, not guessed. |

---

## 4. Data model (two new collections)

### 4.1 `own_sources` — the feed registry (config)

One document per registered feed. This is what the UI manages.

```js
{
  _id,
  ownerSub: "auth0|abc",            // OWNER — isolation key
  feedId: "feed_point7_a1b2",       // stable public id (also used as `source` tag)
  brand: "Point-7",
  status: "active",                 // active | paused | error
  feed: {
    url: "https://point-7.com/feeds/t4a.json",
    authHeaderName: "X-Api-Key",    // optional; value stored encrypted
    authTokenEnc: "<aes-gcm>",      // optional, encrypted at rest (reuse crypto.service)
  },
  schedule: {                       // PORTAL-DRIVEN (not n8n) — see §8.2
    enabled: true,
    frequency: "every_hours",       // every_hours | daily | weekly
    everyHours: 6,                  // when frequency = every_hours
    timeOfDay: "03:00",             // when daily/weekly (HH:mm in `timezone`)
    weekday: 1,                     // when weekly (0=Sun … 6=Sat)
    timezone: "Europe/Ljubljana"
  },
  nextRunAt: ISODate,               // persisted; recomputed after each run (restart-safe)
  lockedUntil: null,                // claim-lock for the scheduler (§8.2)
  runningBy: null,                  // instance/worker id holding the lock
  options: {
    defaultStatus: "active",        // status for products missing `status`
    removalPolicy: "delist",        // delist | zero_stock | keep  (see §6.3)
    maxStalenessHours: 48,          // reject feed older than this (generatedAt)
    allowEmptyFeed: false           // wipe-guard (see §6.4)
  },
  health: {
    lastFetchAt, lastValidatedAt, lastImportAt,
    lastResult: "ok" | "invalid" | "fetch_error",
    lastError: { code, message, issues: [...] },   // truncated validation report
    counts: { products, variants, created, updated, removed }
  },
  createdAt, updatedAt
}
```

**Indexes:** unique `{ ownerSub, feedId }`; unique `{ feedId }`; lookup `{ ownerSub }`.

### 4.2 `external_products` — the ingested catalogue (data)

One document **per parent product**, in the **internal `products` shape** so the push reuses everything. Plus a small control header.

```js
{
  _id,
  ownerSub: "auth0|abc",            // isolation
  feedId: "feed_point7_a1b2",       // which feed  (== `source`)
  source: "own:feed_point7_a1b2",   // explicit source tag (mirrors Patrik's implicit source)
  importRunId: "imp_...",           // which import wrote this row
  externalId: "P7-AC-X",

  // ── internal product shape (consumed by buildScope / resolvePushPrice / resolveTagsArray) ──
  code: "P7-AC-X",                  // parent code
  token: "p7-ac-x",                 // handle (slugified externalId or name)
  product_name: "AC-X Slalom Sail",
  detailed_description: "<p>…</p>",
  short_description: "",
  vendor: "Point-7",
  categories: ["Sails"],            // from productType (+ categoryPaths, see §7)
  images: ["https://…/hero.jpg", "https://…/detail.jpg"],
  published: true,
  active: true,
  stock_amount: 0,                  // parent; variants carry stock
  ean_code: null,
  child_products: [
    {
      code: "P7-ACX-58", ean_code: "4012345678901", size: "5.8",
      stock_amount: 12, published: true,
      images: ["https://…/58.jpg"],
      pricelist: [{ name: "Point-7 Feed", valid_from: "...", price: 573.0, vat: 22 }]
    }
  ],
  pricelist: [],                    // parent; variants carry pricing

  // ── resolved-at-ingest helpers ──
  tags: ["2026","slalom","race","Sails","Sails / Slalom","Race","Race / Slalom"], // §7
  contentHash, imageHash,           // optional ingest-side change hints (push still has its own)
  importedAt
}
```

**Indexes:** unique `{ feedId, externalId }`; lookup `{ ownerSub, feedId }`; match `{ feedId, "child_products.code": 1 }`; `{ ownerSub }`.

> **Why a separate collection and not a `source` field on `products`:** physical isolation. The PNV prune (`processPnvProductExport` soft-deletes products absent from the CSV) operates on `products` and would otherwise have to *remember* to exclude every feed on every run. With a separate collection that mistake is impossible, and removing a brand is `deleteMany({ feedId })`.

---

## 5. The validator (validate-never-parse)

A single module, e.g. `src/services/external/feedValidator.service.js`.

- **Schema:** ship a JSON Schema (Draft 2020-12) at `t4a-partner-portal-api/src/services/external/schema/own-source.v1.json`. Validate with **Ajv** (`ajv` + `ajv-formats`), compiled once at startup, `allErrors: true`, `additionalProperties: false` at every level (extra fields are an error — the contract is closed).
- **Two-stage:** (1) JSON parse — malformed JSON → `INVALID_JSON`. (2) Schema validate → collect **all** Ajv errors.
- **Beyond-schema invariants** (checked in code, reported the same way):
  - `schemaVersion` is a supported version.
  - SKUs unique across the whole feed; `externalId` unique across the whole feed.
  - every `images[].src` / variant `image` is `https://` (Shopify can't fetch `http`/data URLs).
  - `currency` matches the linked connection's currency (warning, not hard error — config).
  - `generatedAt` within `maxStalenessHours`.
- **Output:** `{ ok: true, normalized } | { ok: false, issues: [{ path, message, value? }] }`. The `issues` array is what the **"Test feed"** UI renders verbatim. `path` uses JSON Pointer (`/products/3/variants/0/price/amount`).
- **All-or-nothing:** a single issue fails the **entire** import. The catalogue is never partially written.

---

## 6. The importer (fetch → validate → snapshot upsert → sweep → trigger)

Module: `src/services/external/externalImport.service.js`. Orchestrated like the Shopify sync (background, per-feed serialized).

### 6.1 Flow

1. **Load** the `own_sources` doc; bail if paused.
2. **Fetch** `feed.url` (attach the optional auth header). Timeout + size cap. Network/4xx/5xx → `health.lastResult = "fetch_error"`, record, **stop** (don't touch catalogue).
3. **Validate** (§5). Invalid → `health.lastResult = "invalid"`, store `issues`, **stop**.
4. **Wipe-guard** (§6.4).
5. **Map** each feed product → internal shape (§4.2); normalize price (§3.3); resolve tags (§7).
6. **Snapshot upsert** under `importRunId`:
   - upsert by `{ feedId, externalId }` (replace the mapped fields, bump `importedAt`, set `importRunId`);
   - **sweep**: anything in `external_products` for this `feedId` whose `importRunId !== current` was absent from the feed → apply **removal policy** (§6.3).
7. **Record** `health.counts` (created/updated/removed) + timestamps + `lastResult: "ok"`.
8. **Trigger the push** (fire-and-forget): kick the existing Shopify reconcile for connections whose scope is this feed (§8.3). The feed change propagates to the user's store automatically.

### 6.2 Serialization & rate

Reuse the spirit of `shopifyQueue.service.js`: **one import per `feedId` at a time** (a re-trigger while running is rejected/queued). Imports are cheap (one fetch + Mongo bulk) so no external worker is needed.

### 6.3 Removal policy (`options.removalPolicy`)

When a SKU/product drops out of the feed:
- **`delist`** (default): mark `published: false` / `active: false` on the external row. The next Shopify push unpublishes it (Phase C/publish path) — listing hidden, not deleted.
- **`zero_stock`**: keep it active but set `stock_amount: 0` → push zeroes the inventory (item stays listed but out of stock).
- **`keep`**: leave the last-known row as-is (no removal). For feeds that legitimately omit temporarily-unavailable items.

This is a per-feed business decision, surfaced in the UI.

### 6.4 Wipe-guard

A feed that suddenly returns `products: []` (or far fewer than last time) is usually a supplier-side outage, not a real "delete everything." Guard:
- if `products.length === 0` and `options.allowEmptyFeed === false` → treat as `fetch_error` (skip, alert), do **not** sweep.
- optional ratio guard: if this import would remove > N% of the prior catalogue, mark `needs_review` and hold the sweep pending confirmation in the UI. (Phase-2 nicety.)

---

## 7. Tags & categories (the bit to preserve)

Today the Shopify push tags via `resolveTagsArray(product, config)` (`customExport.service.js:970`), which:
- if the export config has an `aiExportId`, returns the product's **AI categories** for that export, **hierarchically expanded** by `expandCategoryToTags` (`"Sails / Slalom"` → `["Sails", "Sails / Slalom"]`);
- else falls back to `product.categories` (flat, **not** expanded);
- (the `tags` CSV field additionally appends `new`/`recommended` flags — `customExport.service.js:57`).

Feed tags are **resolved at ingest** and stored on the external row, so a feed with no AI categorization set still tags consistently with Patrik:

```js
// at ingest, per external product:
const expanded = [...new Set((feedProduct.categoryPaths || []).flatMap(expandCategoryToTags))];
doc.tags = [...new Set([...(feedProduct.tags || []), ...expanded])];
doc.categories = feedProduct.productType ? [feedProduct.productType] : [];
```

Then a **branch** in `resolveTagsArray` makes the push use the pre-resolved tags for external products, leaving Patrik's path identical:

```js
const resolveTagsArray = (product, config) => {
    const aiTags = /* …AI categories for config.filters.aiExportId, hierarchically expanded… */;
    // Categorized → the AI categories REPLACE the source's own taxonomy (Patrik and feeds alike).
    if (aiTags.length > 0) return aiTags;
    // Not categorized → the source's own: an external feed's ingest-time tags…
    if (Array.isArray(product.tags) && product.source) return product.tags;
    return product.categories || [];      // …or Patrik's PNV categories
};
```

Net: a feed can ship **flat tags** (`["2026","race"]`, pushed verbatim) **and** **hierarchical category paths** (`["Sails / Slalom"]`, expanded to the same `" / "` tag set Patrik produces) — Shopify tagging stays uniform across brands. `expandCategoryToTags` is exported and reused, so there's a single definition of the hierarchy rule.

### 7.1 AI categorization for feeds (built)

A feed can be AI-categorized, against **one or several** category sets. The setting lives **on the feed** — `own_sources.aiCategorization = { enabled, exportIds[] }`, in the Own Sources feed editor — so a feed pushed to several stores is categorized once and identically everywhere. `executeRun` reads it and calls `ensureFeedCategorized(feedId, setId)` for **every** set the feed maintains, immediately before `buildExternalScope` reads the rows. Results are written to `external_products.ai_categories[]` in the Patrik shape (one entry per set) plus the `contentHash` the decision was made against.

**Two-level choice.** The feed decides *which sets exist*; a Shopify source's `aiExportId` decides *which one of them supplies that store's tags* — so two stores can push the same feed under different taxonomies without either of them re-categorizing anything. A scope naming a set the feed no longer maintains falls back to the feed's first set, so a store can never tag from a set that isn't being kept up to date. (For a Patrik export `aiExportId` still means "categorize against this" — same field, different level.)

- **On/off is the whole contract.** On → the feed's products are categorized against each chosen set, appear on `/categories` under each, and the selected one's categories become the Shopify tags. Off → none of that; the stored categories are left in place so re-enabling doesn't pay the AI cost again.
- **Replaced, not merged.** A categorized product is tagged with its AI categories *alone*; the supplier's `tags[]` and expanded `categoryPaths[]` are dropped, so a store carries one taxonomy instead of two. This is the same rule Patrik products follow. A product with no category for the selected set (not categorized yet, or the run failed) keeps the supplier's tags rather than being stripped bare.
- **Incremental.** Only rows that are new, or whose `contentHash` moved since their entry was written, are re-sent — an unchanged feed re-import costs no AI call. `manual: true` entries (partner overrides from the Categories page) are never re-categorized.
- **`productType` is untouched** — `buildProductSetInput` still uses `categories[0]`, i.e. the feed's own `productType`.
- Feed products appear in `/categories` alongside Patrik's with a source badge and a source filter, for coverage review and manual override.

**Feed doc addition:** `aiCategorization: { enabled: false, exportIds: [] }` — normalized on read by `readAiCategorization` (defaults a feed registered before this existed; also reads the original single-`exportId` form as a one-element list). Enabling with no sets is stored as OFF; ids are de-duplicated. Indexed `{ 'aiCategorization.exportIds', 'aiCategorization.enabled' }` (multikey) for the Categories-page lookup.

> **Future "tags setup" parity.** When the CSV-export tag controls (leaf-vs-full, prefix, include-flags) get promoted into the Shopify connection config, the same per-connection tag options apply to external feeds by passing them through to the ingest-time resolution above — one tag policy, two sources.

---

## 8. Backend surface

### 8.1 New routes — `src/routes/externalRoutes.js`, mounted at `/api/export/external`

Auth: Auth0 JWT (owner-checked), mirroring `shopifyController` ownership checks.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/external/sources` | List the caller's feeds (`own_sources`, owner-scoped, secrets stripped). |
| `POST` | `/external/sources` | Register a feed (`{ brand, url, authHeaderName?, authToken?, schedule, options }`). |
| `GET` | `/external/sources/:feedId` | One feed + health + last `issues`. |
| `PUT` | `/external/sources/:feedId` | Update config (owner-checked). |
| `DELETE` | `/external/sources/:feedId` | Remove feed **and** `deleteMany({ feedId })` in `external_products`; unlink from any connection. |
| `POST` | `/external/sources/:feedId/test` | **Fetch + validate only** (no write). Returns `{ ok, counts, issues }` for the "Test feed" UI. |
| `POST` | `/external/sources/:feedId/import` | Trigger an import now (202 + background; `409` if one is running). |
| `GET` | `/external/sources/:feedId/activity` | Import history / counts / last result. |

### 8.2 Scheduling — **portal-driven** (new internal scheduler)

The cadence is configured **per feed in the portal UI** (§9.2) and the **portal runs it itself** — the user does not wire up n8n. This is a deliberate departure from the existing "no internal cron scheduler" rule (every other job is n8n-triggered), justified because Own Sources is **self-serve**: a user must be able to set "every 6 hours" / "daily at 03:00" when adding a feed and have it just happen.

**Component:** `src/services/external/externalScheduler.service.js`, started once from `index.js` after the DB connects (next to `ensureShopifyIndexes()`).

**Mechanism — in-process tick + persisted `nextRunAt` (no extra infra):**
1. A timer fires every ~60 s (`setInterval`). Cheap; one indexed query.
2. Each tick **atomically claims** due feeds so a run can't double-fire (and stays correct if the API ever scales to >1 instance):
   ```js
   // claim: due, enabled, active, not already locked
   const claimed = await db.collection('own_sources').findOneAndUpdate(
     { 'schedule.enabled': true, status: 'active',
       nextRunAt: { $lte: now },
       $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
     { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS), runningBy: INSTANCE_ID } },
     { sort: { nextRunAt: 1 }, returnDocument: 'after' }
   );
   ```
   Loop until no feed is claimed. The atomic `findOneAndUpdate` is the lock — no external broker, no leader election.
3. For each claimed feed: run the importer (§6, still per-`feedId` serialized), then **recompute and persist `nextRunAt`** from `schedule` (in `schedule.timezone`) and clear the lock (`lockedUntil = null`). On crash, the stale `lockedUntil` expires and the feed is reclaimed next tick — no lost schedule.
4. `nextRunAt` is persisted, so a process restart resumes exactly where it left off (no drift, no double-run).

**`nextRunAt` computation** (small pure helper, unit-tested): `every_hours` → `lastRun + everyHours`; `daily` → next `timeOfDay` in `timezone`; `weekly` → next `weekday` at `timeOfDay`. Recomputed from the **scheduled** time (not actual finish) so cadence doesn't drift. Editing the schedule in the UI recomputes `nextRunAt` immediately.

**Manual + external triggers still exist:** the UI's **"Import now"** (`POST …/sources/:feedId/import`, §8.1) is unaffected. An optional `POST /api/export/webhooks/sync/external` (`webhookApiKey`-protected) is kept **only** as an escape hatch for an external nudge/back-fill — it is **not** the scheduling mechanism. On completion each import triggers the Shopify reconcile for its linked connections, so the full chain is **portal scheduler → import → Shopify push**, no new push code and no n8n.

> **Multi-instance note:** the claim-lock makes the scheduler safe under horizontal scaling, but every instance would still *tick*. That's fine (the lock dedupes the work). If you prefer a single ticker, gate `setInterval` behind an env flag (`EXTERNAL_SCHEDULER=on`) on one instance. Today the API is single-instance, so the default just works.

### 8.3 Linking a feed to a Shopify connection (the `scope.type` branch)

Extend the connection config (`shopify_connections.config`) so scope is explicit:

```js
config.scope =
  { type: 'export_config', exportConfigId }   // today (Patrik) — keep as default/back-compat
  { type: 'own_source',    feedId }           // new — push this feed to this store
```

Back-compat: a connection with the legacy `config.exportConfigId` and no `config.scope` is treated as `{ type:'export_config', exportConfigId }`.

Then `buildScope()` (`shopifySync.service.js:132`) branches:

```js
async function buildScope(config) {
  const scope = config.scope
    ?? (config.exportConfigId ? { type: 'export_config', exportConfigId: config.exportConfigId } : null);
  if (scope?.type === 'own_source') return buildExternalScope(scope.feedId);   // reads external_products
  // …existing export_config path: read `products` + applyFilters… (unchanged)
}
```

`buildExternalScope(feedId)` reads `external_products` for the feed (published/active only) and returns the **same** `{ products, items }` shape — the item loop is identical to the existing one (one row per `child_products` SKU, barcode = `ean_code`). Because the docs are already in the internal shape, `getPriceFromPriority` / `resolvePushPrice` / `resolveTagsArray` all just work.

> A connection still has **one** scope. Pushing Patrik *and* Point-7 to the *same* store = either two connections to that store (already supported — multiple connections per account) or, later, a multi-scope connection (`scopes: []`). Start with one-scope-per-connection; it needs no engine change.

### 8.4 Reused / shared

`crypto.service` (encrypt the feed auth token, same as Shopify tokens), `shopifyConnection.service` (link/unlink scope), the per-shop queue, `shopify_product_map` (source-agnostic — keyed by SKU), `shopify_sync_jobs` (run history), `expandCategoryToTags` / `getPriceFromPriority` / `applyFilters` exports from `customExport.service`.

---

## 9. UI

Lives in `t4a-partner-portal-ui`, under the existing **integrations** hub (sibling of the Shopify page; cf. `integrations/shopify/page.js`).

### 9.1 Navigation

`integrations/` index gains a second card/tab: **Own sources** (`integrations/own-sources/`). The Shopify card stays as-is.

### 9.2 Pages / components

**`OwnSourcesPage` (list).** Server-fetches `GET /external/sources`. Renders one row per feed:
- brand, feed URL (truncated), **health pill** (`OK` green / `Invalid` red / `Fetch error` amber / `Paused` grey),
- last import time + counts (`412 products · 1,038 variants`),
- linked store (or "not linked"),
- actions: **Test**, **Import now**, **Edit**, **Remove**.
- Top-right: **"Add source"**.

**`AddEditSource` (modal/drawer).** Fields:
- **Brand** (label), **Feed URL**, optional **Auth header name + token** (token write-only; shown as `••••` once saved),
- **Schedule** — a friendly picker the **portal** runs (no n8n): toggle *Enabled*, choose *Frequency* (**Every N hours** / **Daily** / **Weekly**), then the dependent field (N hours, or time-of-day + weekday) and **timezone**. Show a live **"Next run: Wed 03:00 CET"** computed from the selection.
- **Options**: `defaultStatus`, **removal policy** (radio: *Delist* / *Zero stock* / *Keep*), `maxStalenessHours`, `allowEmptyFeed`.
- Primary action **Test & Save**: calls `/test` first; only enables Save on `ok` (or on explicit "save anyway" for fetch errors).

**`TestFeedResult` (the onboarding centerpiece).** Calls `POST /external/sources/:feedId/test`. Two states:
- ✅ *"Valid — 412 products / 1,038 variants, generated 2h ago."* + a small **sample preview** (first 3 products: name, variant count, price, tags) so the user *sees* what will be pushed.
- ❌ A scrollable **issues list** rendered from `issues[]`: `products[3].variants[0].price.amount — expected number, got "699,00"`. Each row shows the JSON Pointer path, the message, and the offending value. This is the entire debugging surface a supplier needs — copy/paste it to them.

**`SourceActivity` (history).** `GET …/activity`: table of imports (time, trigger, result, created/updated/removed, error). Mirrors the Shopify activity panel for familiarity.

**Linking to a store.** In the existing **Shopify ConnectionPanel**, the scope selector (today: pick an export config) gains a second option group: **"Own source"** → pick one of the user's feeds. Saving sets `config.scope = { type:'own_source', feedId }` and auto-adds the `"<brand> Feed"` pricelist to `pricelistPriority`.

### 9.3 Proxies (Next API)

Thin bearer-attaching proxies under `nextapi/export/external/*` mirroring the Shopify ones: `sources`, `sources/[feedId]`, `sources/[feedId]/test`, `sources/[feedId]/import`, `sources/[feedId]/activity`. Each attaches the Auth0 token and forwards to `EXPORT_API_URL`.

### 9.4 Spec hand-off for suppliers

A static **"Feed format"** help panel (and a downloadable `own-source.v1.json` schema + the example feed) linked from Add Source. This is what a user forwards to their supplier — the whole integration spec is one schema + one example.

---

## 10. Build sequence (thin vertical slices)

**Slice 1 — contract + validator + collections.** Publish `own-source.v1.json`; build `feedValidator`; create `own_sources` + `external_products` with indexes. Unit-validate the example feed. *No UI, no push yet.*

**Slice 2 — importer + manual trigger.** `externalImport.service` (fetch → validate → snapshot upsert → sweep). One hard-coded Point-7 feed, `POST …/import`. Verify `external_products` fills and re-imports idempotently; verify removal policy.

**Slice 3 — push branch.** Add `config.scope` + the `buildScope` branch + `buildExternalScope`. Link a dev Shopify connection to the Point-7 feed; run a sync; verify stock/price/content/**tags**/images land in the store. *This is the proof the engine reuse works.*

**Slice 4 — Own Sources UI.** List / Add-Edit / **Test feed** / activity; scope selector in ConnectionPanel; proxies. The self-serve experience.

**Slice 5 — portal scheduler.** `externalScheduler.service` (tick + Mongo claim-lock + persisted `nextRunAt`), started from `index.js`; the UI schedule picker writes `schedule` and the live "Next run". Verify a feed runs on its own cadence, survives a restart, and doesn't double-fire. Hands-off, no n8n.

**Slice 6 — hardening.** Wipe-guard ratio review, staleness alerts, currency mismatch surfacing, generic schema-version negotiation, multi-scope connection (optional).

---

## 11. Cross-cutting concerns

- **Multi-tenancy / isolation.** Every `own_sources` and `external_products` doc carries `ownerSub`; every read/list/import is owner-scoped; a connection can only link a feed the same owner owns. The shared Patrik `products` collection is never touched by this feature.
- **Security.** Feed auth token encrypted at rest (`crypto.service`, like Shopify tokens), never logged, never returned by the API (write-only). Validate feed `images[].src` are https. Cap fetch size/time. Owner-checks on every route (mirror `shopifyController`).
- **Idempotency / safety.** Imports are snapshot + sweep under an `importRunId` → re-running is safe and convergent. Invalid/erroring feeds **never** mutate the catalogue (validate-before-write). The wipe-guard prevents an upstream outage from emptying a store.
- **Delta / cost.** Ingest is cheap (one fetch + bulk write). The push reuses the existing `priceHash`/`contentHash`/`imageHash` gating, so a no-change feed import results in near-zero Shopify calls.
- **Observability.** `health` on `own_sources` + import history give per-feed status; reuse `analytics.service.monitorFunction` around fetch/validate/import for timing.

---

## 12. Open decisions (settle before/while building)

| # | Decision | Recommendation |
|---|---|---|
| E1 | `taxMode` default if a feed omits it | Make it **required** (no default) — avoids silent gross/net errors. |
| E2 | Removal policy default | **`delist`** — safest (hide, don't delete; reversible). |
| E3 | One scope per connection vs multi-scope | Start **one** (two connections to one store if needed); add `scopes[]` later only if users ask. |
| E4 | Empty-feed handling | **Wipe-guard on** by default (`allowEmptyFeed:false`). |
| E5 | Schema versioning | Support exactly the versions you ship; reject unknown `schemaVersion` with a clear message rather than best-effort. |
| E6 | Currency mismatch | Warn + allow (config), since a store may price-convert; don't hard-block. |
| E7 | Upload fallback (no pullable URL) | Defer; design the importer around a `fetch(url)` seam so a file-upload source is a later drop-in. |

---

## 13. Verdict

Cheaper than it feels, because the costly half (the Shopify push) is already built and brand-blind. The entire feature is **a closed JSON contract + a validator + a snapshot importer + two collections + one `buildScope` branch + a self-serve UI** — with **tags, price, stock, content, and images all reusing the existing engine**. The contract-first stance ("validate, never parse") is what keeps it maintenance-free as more brands are added: each new supplier is a config row and a conforming feed, not new code.
