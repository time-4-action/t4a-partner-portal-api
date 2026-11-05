# Shopify Integration — Progress & Plan

> Companion to [`shopify_integration.md`](./shopify_integration.md) (the design doc).
> Sibling initiative (planned): [`external_integration.md`](./external_integration.md) — **Own Sources** (ingest other brands' feeds into the same push).
> This file tracks **what is built**, **what remains**, and **how I recommend doing the rest**.
> Last updated: **2026-08-20** (price rounding — see §8; multi-location fulfilment §7; price factor + always-current prices §6; Own Sources §5).

---

## 0. TL;DR

- **Control plane (OAuth + connection lifecycle): DONE and verified** — a live store can connect end-to-end.
- **Data plane — Phase A (stock-only sync): DONE.** "Sync now" runs a real, rate-limited, throttle-aware inventory push: in-scope SKUs from the connection's export config (published-only) → SKU→variant match (barcode fallback) → persist map → `inventorySetQuantities` to the chosen location → real run history + counts + live "needs attention" report.
- **Data plane — Phase C (price + description push): DONE.** In `portal_authoritative` ownership, each sync also pushes variant **prices** (`productVariantsBulkUpdate`, VAT mode + future-date guard) and product **content** (`productUpdate`: title/description/tags) for matched products, delta-gated by `priceHash`/`contentHash`. Verified live (`userErrors: []`).
- **Pricing panel now loads REAL pricelists** (`GET /shopify/pricelists`) instead of the mock template — mirrors how `/export` derives them.
- **Data plane — Phase B (product create): DONE.** When `syncNewProducts` is on (and ownership isn't stock-only), unmatched products are created in the store (`productCreate` + `productVariantsBulkCreate`) with title/description/tags/price/barcode/SKU and **starting inventory set at the location during create**; partially-matched parents get only their missing variants added (no duplicate product). Verified live (2 products / 3 variants created + cleaned up).
- **Data plane — Phase D auto-triggers: DONE.** Sync is no longer manual-only — it now fires automatically: a **delta push at the end of every PNV catalogue sync**, a **scheduled full reconcile** endpoint for n8n (`POST /webhooks/sync/shopify`), and an **initial push** the first time a connection becomes sync-ready.
- **Data plane — Phase D images: DONE.** When `syncImages` is on (portal_authoritative), the parent gallery is pushed via `productUpdate(media:)` — only to products with no media yet (no duplicates / no clobbering), delta-gated by `imageHash`. Verified live.
- **Fixed: syncing to a newly chosen location.** `inventorySetQuantities` silently no-ops at a location where the item isn't stocked; the engine now uses `inventoryActivate` (which creates the inventory level + sets available) for items not yet stocked there, tracked per-row via `stockLocationId`.
- **Distribution:** Public / unlisted (one app, many partner stores).
- **All planned functionality (A stock, B create, C price/content, D images + auto-triggers) is built and live-verified — ~99%.** What's left is refinement, not core features (see §2).

---

## 1. What is DONE ✅

### 1.1 OAuth / connection backend — "control plane"
Committed on `dev`:
- **API** — commit `b0d0b41` (`feat(shopify): add OAuth/connection backend (control plane)`)
- **UI** — commit `d6e9999` (`feat(shopify): wire connect/disconnect/config to real OAuth backend`)
- _(Not yet pushed to remote `dev` at time of writing.)_

**API repo (`t4a-partner-portal-api`)** — new `src/services/shopify/`:
| File | Responsibility |
|---|---|
| `crypto.service.js` | AES-256-GCM token encryption at rest; signed `state` nonce (CSRF, bound to Auth0 `sub`); OAuth-callback HMAC + webhook-body HMAC verification; timing-safe compare |
| `shopifyApi.service.js` | `exchangeCodeForToken`, `adminClient`, `registerWebhooks` (uninstall + 3 GDPR topics, idempotent), `listLocations`, `getShopInfo`. Admin API `2026-04` |
| `shopifyConnection.service.js` | `shopify_connections` CRUD, `ensureIndexes` (also **pre-indexes** `shopify_product_map` + `shopify_sync_jobs` ahead of the data plane), config whitelist update, `markUninstalledByShop`, `toPublic` (strips token) |
| `shopifyOAuth.service.js` | `normalizeShopDomain`, `buildInstallUrl` (signed state + redirect), `handleCallback` (verify → exchange → upsert → register webhooks) |
| `controllers/shopifyController.js` | `connect`, `callback`, `status`, `updateConfig` (owner-checked), `disconnect` (owner-checked), `webhook` (HMAC-verified, dispatch by topic, always 200) |
| `routes/shopifyRoutes.js` | mounts the surface under `/api/export/shopify` |
| `app.js` / `index.js` | capture `req.rawBody` for webhook HMAC; run `ensureShopifyIndexes()` at startup |

**UI repo (`t4a-partner-portal-ui`)**:
- `nextapi/export/shopify/*` thin proxies (`connect`, `status`, `connection/[id]`, `connection/[id]/config`) — attach the Auth0 bearer, forward to `EXPORT_API_URL`.
- `ShopifyIntegrationPage.js` — `connect()` launches real OAuth; `disconnect()` + `saveConfig()` hit the real API; seeds from real `connection` / `connected` / `locations`; `?shopify=connected|error` result banner.
- `integrations/shopify/page.js` — server-fetches `/shopify/status` and passes real props.

### 1.2 Endpoints live now (design §10)
| Method | Path | Status |
|---|---|---|
| `GET` | `/shopify/connect?shop=` | ✅ done |
| `GET` | `/shopify/callback` | ✅ done (HMAC + state secured) |
| `GET` | `/shopify/status` | ✅ done (connection + locations) |
| `PUT` | `/shopify/connection/:id/config` | ✅ done |
| `DELETE` | `/shopify/connection/:id` | ✅ done |
| `POST` | `/shopify/webhooks` | ✅ done (uninstall + GDPR) |
| `POST` | `/shopify/connection/:id/sync` | ✅ done (Phase A — stock-only; 202 + background run) |
| `GET` | `/shopify/connection/:id/activity` | ✅ done (recent runs + counts + unmatched report) |

### 1.3 Security must-dos (design §5.4) — all satisfied
- ✅ Tokens encrypted at rest (AES-256-GCM), never logged.
- ✅ OAuth `state` signed + bound to user (CSRF).
- ✅ OAuth callback HMAC verified.
- ✅ Webhook HMAC verified against raw body.
- ✅ Least-privilege scopes (`read/write_products`, `read/write_inventory`, `read_locations` — **no protected customer data**, which keeps review light).
- ✅ Mandatory GDPR webhooks registered (`shop/redact`, `customers/redact`, `customers/data_request`) + `app/uninstalled` handling.

### 1.4 Distribution model (design §11 Q1/Q2) — decided
- **Public / unlisted** app: one app, unlimited partner installs via the same OAuth link.
- Backend is already multi-tenant: connections keyed by `ownerSub + shopDomain`, per-shop tokens + webhooks. **No code change needed for multi-partner** — only the Partner-dashboard distribution setting (done).

### 1.4.1 Multiple stores per account ✅ NEW
A single portal user can now connect **any number of Shopify stores** (not just one). The data model was already multi-store (`shopify_connections` unique on `(ownerSub, shopDomain)`; per-connection token/config/location/product-map; auto-triggers already fan out to all). This added the missing list surface + UI:
- **API**: `GET /shopify/connections` (lightweight list of all the user's stores, no Shopify calls) + `GET /shopify/connection/:id/detail` (one store's live locations/channels/flags — the per-store equivalent of `status`). `listConnectionsForUser` added to the connection service; the live-locations/publications logic was extracted to a shared `loadLiveShopData` used by both `status` (legacy single) and `connectionDetail`.
- **UI**: `ShopifyIntegrationPage` is now an orchestrator (brand header + **store switcher** pills + "Connect store" + shared banner) over an extracted **`ConnectionPanel`** (all per-store management, keyed by connection id so switching remounts cleanly; lazy-loads its own `/detail` + `/activity`) and **`ConnectStore`** (the connect/“connect another” screen). `page.js` server-fetches `/connections` (array) instead of single `/status`. New proxies: `nextapi/.../connections` and `nextapi/.../connection/[id]/detail`. Legacy `/status` retained for back-compat but unused by the page.

### 1.5 Already existed before this work (reusable, design §2)
Product source of truth (`products` + `child_products`), stock/price enrichment, PNV pipeline + webhook trigger, Shopify field mapping (`customExport.service.js`), `getPriceFromPriority`, per-export access model, Auth0, n8n scheduling.

---

## 1.6 Data plane — Phase A (stock-only sync) ✅ NEW

The safest, highest-value slice (plan §3.1 Phase A) is built end-to-end. It touches **inventory quantities only** — never product content — so it can't damage a partner's listing and sidesteps price/VAT (Q4/Q5) entirely.

**API repo** — new files under `src/services/shopify/`:
| File | Responsibility |
|---|---|
| `shopifyGraphql.service.js` | GraphQL Admin client (`2026-04`). Owns throttle handling: reads `extensions.cost.throttleStatus`, retries `THROTTLED` using Shopify's restore rate, exponential backoff on `429`/5xx/network, typed errors. |
| `shopifyQueue.service.js` | Per-shop **serialization** (two runs for one store never overlap) + bounded-concurrency batch map. In-process (single API instance; matches the existing no-internal-scheduler design). |
| `shopifyMatch.service.js` | SKU→variant matching via `productVariants(query:)` — exact-unique SKU match, barcode fallback, duplicate-in-store flagged as unmatched. Paginated, batched, search-term escaped. |
| `shopifyProductMap.service.js` | `shopify_product_map` writes (authoritative once written), bulk match upsert, push-state set, state-count aggregate, delete-on-disconnect. |
| `shopifySyncJobs.service.js` | `shopify_sync_jobs` as **one row per run** (run-grained, not per-variant — avoids catalogue×runs bloat). Lifecycle, recent runs, latest run, stale-run reaping. |
| `shopifySync.service.js` | Orchestrator: load connection+config → build published-only inventory items (reuses `applyFilters`) → match unmapped → push `inventorySetQuantities @idempotent` to the chosen location (batched, throttle-aware) → record map state + run counts + unmatched. Runs in the background, serialized per shop. |

- **Controller/routes**: `sync` (`POST …/sync`, owner-checked, **202 + background run**, rejects overlapping runs with `409 SYNC_BUSY`) and `activity` (`GET …/activity` → `{ jobs, counts, unmatched }`).
- **`customExport.service.js`**: now exports `applyFilters` + `getPriceFromPriority` for reuse (Phase A uses `applyFilters`; price resolution is wired for Phase C).
- **Idempotency**: each inventory batch carries a stable `@idempotent` key (required as of Admin API `2026-04`), reused across throttle-retries so a retried push is deduplicated, not double-applied.
- **Stale-map self-heal**: if a push reports the Shopify target no longer exists (merchant deleted the product → `INVALID_INVENTORY_ITEM` / "could not be found"), that SKU's map row is **dropped** (not retried forever) and reported as needs-attention; the next sync re-matches it — re-creating the listing if it returns, or reporting it unmatched if it's gone. Applies to stock (Phase A) and price/content (Phase C).

### 1.6.1 Auth hardening — expiring offline tokens (2026-04 enforcement) ✅
Shopify **stopped accepting legacy non-expiring access tokens** for the Admin API as of 2026-04-01 (REST *and* GraphQL return `403 "Non-expiring access tokens are no longer accepted"`). This bit the first live test: locations failed to load (REST 403 → UI silently fell back to the demo locations, so a phantom location got saved) and the sync 403'd.
- **Token exchange** now sends `expiring=1` → Shopify returns a ~60-min access token **+ a ~90-day refresh token** (`shopifyApi.exchangeCodeForToken`, new `refreshAccessToken`).
- **`shopify_connections`** stores `refreshTokenEnc` (encrypted), `tokenExpiresAt`, `refreshTokenExpiresAt`.
- **`shopifyToken.service.getValidAccessToken`** returns a token guaranteed fresh: refreshes ~2 min before expiry, persists the rotated pair, and **serializes refreshes per connection** (a new token retires the old one, so concurrent refreshes would clobber each other). Used by both `status` (locations) and `sync`.
- **Legacy connections** (no refresh token) can't be renewed → `REAUTH_REQUIRED`; `status` returns `needsReconnect: true` and the UI shows a **"Reconnect needed"** banner. **Existing connections made before this fix must reconnect once** to mint a refreshable token.
- **Locations** now load via **GraphQL `locations`** (not legacy REST), and the UI shows **only real store locations** for a live connection (never the demo set) so a non-existent location can't be selected.

**UI repo**:
- New proxies `nextapi/export/shopify/connection/[id]/sync` (POST) and `…/activity` (GET).
- `ShopifyIntegrationPage.js`: `syncNow()` starts a real run then polls `/activity` until it leaves `running`; `refreshActivity()` re-fetches; sync-activity table/counts and the needs-attention report are seeded from `/activity`. The three `MOCK_*` constants remain **only** as a demo fallback when there's no real connection id.

---

## 1.7 Data plane — Phase C (price + description push) ✅ NEW

Runs **only in `portal_authoritative` ownership** (design §9) — the partner opts up from the safe stock-only default. On each sync, after the stock push, the engine pushes managed content for **matched** products (unmatched still wait for Phase B create):

- **Price** (`syncPrices`): `productVariantsBulkUpdate` per product, prices resolved by `resolvePushPrice` → reuses `getPriceFromPriority` with the connection's pricelist priority, then applies **Q5 future-date guard** (drop `valid_from > now`) and **Q4 VAT mode** (`pricelist.price` is NET; `inclusive` → ×(1+vat/100), `exclusive` → as-is).
- **Content** (`syncDescriptions`): `productUpdate` per product — `title` ← `product_name`, `descriptionHtml` ← `detailed_description`/`short_description`, `tags` ← `resolveTagsArray` (export-config aware).
- **Delta**: per-variant `priceHash` + per-product `contentHash` on the map rows; unchanged products skip the API call. A failed product is reported and its hash is **not** advanced, so the next run retries.
- **Counts**: `pricesPushed` / `contentPushed` added to the run record and surfaced in the activity detail.
- Verified live against the dev store: `productVariantsBulkUpdate` and `productUpdate` both return `userErrors: []` (validated the **runtime input fields**, not just the query AST — the lesson from `ignoreCompareQuantity`).

### 1.7.1 Pricing panel — real pricelists (was mock) ✅
The pricing panel previously seeded its priority list from a hard-coded `MOCK_CONNECTION` template (fake names like "Outlet Spring 2026"). Now it loads **real** pricelists, the same way `/export` does:
- **API**: `GET /shopify/pricelists` → `customExport.getDistinctPricelists()` aggregates distinct `{name, vat, valid_from}` across the active catalogue (flattens parent + `child_products[].pricelist`).
- **UI**: `page.js` fetches it → `ShopifyIntegrationPage` merges the catalogue pricelists with the connection's stored priority/enabled state (stored order kept, new names appended newest-first, vanished names dropped); `vat`/`valid_from` shown from the catalogue. `saveConfig` persists only `{name, enabled, priority}` (vat/valid_from re-derived on load). Demo template remains a fallback only when the catalogue returns none.

---

## 1.8 Data plane — Phase B (product create) ✅ NEW

When `syncNewProducts` is enabled and `ownership !== 'stock_only'`, `pushNewProducts` (in `shopifySync.service.js`) turns unmatched products into real listings — before the stock push, so created variants don't need a separate inventory call:
- **Creatable** = unmatched SKUs with reason "No SKU / barcode match in store" only (never duplicates / ambiguous / untracked).
- **New parent** → `productCreate` (title ← `product_name`, descriptionHtml, vendor `Patrik International`, productType ← `categories[0]`, status `ACTIVE`, tags ← `resolveTagsArray`, `productOptions: [{name:"Size", values}]`) then `productVariantsBulkCreate` with `REMOVE_STANDALONE_VARIANT`.
- **Partially-matched parent** (some variants already mapped) → `productVariantsBulkCreate` adds **only the missing variants** to the existing product (`DEFAULT` strategy) — no duplicate product.
- Each variant: Option1 = `size` (falls back to SKU for sizeless), `price` via `resolvePushPrice` (VAT mode + future-date guard), `barcode` ← `ean_code`, `inventoryItem:{sku,tracked:true}`, and **`inventoryQuantities:[{locationId, availableQuantity}]`** (activates the item at the location AND sets starting stock).
- **No-variant parents** (Q10): created with the default `Title`/`Default Title` variant.
- Returned variant ids → new `shopify_product_map` rows (marked `synced`); created SKUs drop off the needs-attention report. Counts: `createdProducts` / `createdVariants`, surfaced in the activity detail.
- **Verified live** on the dev store: 2 products / 3 variants created (variant + no-variant), price/barcode/Size/inventory all correct, then deleted.

---

## 1.9 Data plane — Phase D auto-triggers ✅ NEW

Sync is now automatic, not manual-only (design §8.1). `shopifySync.syncAllConnections({trigger})` fans a sync out across every sync-ready store (`connectionService.listActiveSyncable()` = active + token + exportConfigId + location), kicking each off in the background (serialized per shop), skipping busy / re-auth / not-ready stores without throwing. Three triggers call it:
- **PNV-end delta push** (`trigger: 'pnv'`) — fired fire-and-forget at the end of `runPnvProductSync()` in `webhookController.triggerPnvSync`, so a catalogue refresh propagates to all stores ("near-live").
- **n8n reconcile** (`trigger: 'reconcile'`) — `POST /api/export/webhooks/sync/shopify` (webhookApiKey-protected, alongside the existing n8n triggers); point a nightly n8n schedule at it.
- **Initial push** (`trigger: 'initial'`) — in `updateConfig`, the first time a connection becomes sync-ready and has never synced, so the partner doesn't have to click "Sync now" for the first run. `SYNC_BUSY` guards re-saves.

The `trigger` is recorded on each run (shown in the activity detail). Note: "delta" here still runs the full engine per store — content/price are `contentHash`/`priceHash`-gated, stock is pushed each run; true per-product change-detection is a later optimization.

---

## 1.10 Phase D images + the location fix ✅ NEW

- **Image sync** — `productCreateMedia` is deprecated on 2026-04; uses `productUpdate(product, media: [CreateMediaInput!])` (`{originalSource, alt, mediaContentType: IMAGE}`). Standalone `pushImages` step gated on `syncImages` + ownership ≠ stock_only, with **mode-specific scope**:
  - **`create_then_handoff`** → images pushed **only for products created in this run** (creation-time). Existing products are never re-touched, so a later catalogue image change **stays intact** in Shopify — the "handoff".
  - **`portal_authoritative`** → any matched product with **no media yet** (a `product.media(first:1)` check) gets the parent gallery; products that already have media are skipped (never duplicates / clobbers).
  - Freshly-created products are added to the match map so they get their gallery the same run. Delta-gated by a per-product `imageHash`; `counts.imagesPushed` in the activity detail. Verified live (26 images pushed, 0 failures).
- **Activity "Type" column** now reflects what the run actually did (`Create` / `Images` / `Content` / `Stock`) instead of always "Inventory".

### 1.10.1 Variant images + sales-channel publishing ✅ NEW
- **Variant images (linked)** — created products are now built with **`productSet` (`synchronous: true`)**, which sets the gallery + each variant's own `file` so a variant's image is **linked to that variant** (productCreate+bulkCreate can't — variant media is async/non-ready at create). price/barcode/sku/inventory are set inline. Verified live (each variant shows its own image). Partial-match (adding variants to an existing product) still uses `productVariantsBulkCreate`.
- **Gallery order is managed too (2026-06-10)** — a re-added image lands at the **end** of the gallery (and merchants can drag-sort), which broke the catalogue's image order. In `portal_authoritative`, `reorderGallery` now compares our media's gallery positions (by stamped alt) against the catalogue order each sync and, on drift, fires `productReorderMedia` (zero-based moves, async job) to put our media back in catalogue order at the front; merchant-added media keeps its relative order after ours. No-op when already in order. Verified live: moved image #1 to last → one sync restored the exact order, variant links untouched.
- **Variant-image relink for existing products (2026-06-10)** — the old "unlinked fallback" is gone: `pushImages` now runs a **`linkVariantImages` pass** after the gallery reconcile. For every matched variant whose own image (`variant.images[0]`) is present as product media (by the stamped alt) but not linked to that variant, it appends the media via `productVariantAppendMedia` (detaching any *other* portal-managed media still linked first; merchant media untouched). Freshly-added media is polled briefly until `READY` (async processing); a variant that misses the window is picked up next run. This covers both halves of the same hole: media pushed onto an already-existing matched product (gallery-only before), and a media **deleted in Shopify taking its variant link with it** (the re-added copy is a new media id, so the link must be restored too). Authoritative relinks every run; create_then_handoff only at its one-time fill. **FAILED media cleanup**: a media node stuck in `FAILED` still carries our alt and would mask the image as "present" forever — the reconcile now drops those (`productDeleteMedia`) so the image is re-attempted. New run count `variantImagesLinked` (shown in activity detail). Verified live: unlinked variant on an Own-Source product relinked in one sync; second sync links 0 (idempotent); full-store audit clean.
- **Re-create deleted products in one run** — a **pre-flight existence check** (`nodes(ids:)`) at sync start drops mappings whose Shopify product was deleted, so those SKUs flow into the normal match→create path **the same run** instead of erroring at push and forcing a second sync. Reactive stale-handling remains a backstop.
- **Re-add deleted images (portal_authoritative)** — images are a managed field. Every image we add carries **`alt = its source URL`**, the reliable key for which of our images are present (Shopify rehosts to its CDN, so the URL is otherwise unrecoverable). Each sync compares our desired set to the media present (by alt) and **re-adds any missing** — whether one image was deleted or all — without duplicating the ones still there. New catalogue images are added too. create_then_handoff keeps the media-less guard (fill-once, then frozen). Verified live: delete the *middle* of 3 images → only that one is re-added (no duplicate).
- **Sales-channel publishing** — created products were ACTIVE but not published anywhere. Added: `read_publications`/`write_publications` scopes (**requires reconnect**), `GET` publications via the status endpoint (`publications` + `publishingEnabled` flag, gated on the granted scope), a per-connection `publicationIds` config, and a **"Sales channels"** UI section (toggles per channel, or a reconnect prompt when the scope is missing). Validated against 2026-04. Publish behaviour by mode:
  - **`create_then_handoff`** → publish at creation only (`publishablePublish` in `pushNewProducts`).
  - **`portal_authoritative`** → channels are a **managed field**: `pushPublications` keeps every matched product in sync with the selected channels on each sync — publishes to the chosen ones and **unpublishes from the rest** — delta-gated by a per-product `publishHash`, so it only fires when the selection changes. No-op when no channels are selected (won't hide the catalogue).
- **Location-change fix** — `inventorySetQuantities` with `name:"available"` **silently no-ops** for an item not yet stocked at the target location (returns no error, creates no inventory level) — so switching a connection to a new location left inventory blank there. The stock push now partitions by a per-row `stockLocationId`: items already stocked at the current location use the fast batched `inventorySetQuantities`; items not stocked there are sent through `inventoryActivate` (creates the level + sets available, `@idempotent` required on 2026-04), then tagged with `stockLocationId`. Phase-B-created variants are tagged at creation. First sync after a location change activates per-item, then settles back to fast batches.

---

## 2. What is NOT done — refinements only (core is complete)

All planned features (A/B/C/D) are built and live-verified. What remains are optimizations / nice-to-haves, not functional gaps:

1. **True per-product delta** — the auto-triggers run the full engine per store (content/price are hash-gated; stock is pushed every run). A real "only touch products whose source fields changed" pass would cut API volume further.
2. **Image *removals*** — missing/new images are reconciled by alt and variant images are (re)linked (§1.10.1), but an image **removed from the catalogue** isn't deleted from Shopify (additive only — a stale image lingers until removed manually).
3. **Multi-location** (Q9) — one location per connection; switching now works (above), but simultaneous multi-location isn't supported.
4. **UI "Resolve" buttons** in the needs-attention table are still cosmetic.

### 2.2 Reused across phases (shared infrastructure)
The matching engine, per-shop rate-limited queue, `shopify_product_map` (+ `priceHash`/`contentHash` delta + stale self-heal), run/job model + reporting, GraphQL throttle client, and price resolution (`getPriceFromPriority` + VAT/future-date) are all phase-agnostic — Phase D adds operations on top, not new infrastructure.

### 2.3 Open questions — now resolved in code (design §11)
- Q3 — products per partner: **resolved** — the connection's chosen `custom-export` config (its filters + field rules) is the scope source.
- Q4 — VAT mode: **resolved** — per-connection `priceVatMode`; `pricelist.price` treated as NET, `inclusive` pushes gross, `exclusive` pushes net. Surfaced in the pricing panel.
- Q5 — future-dated prices: **resolved** — per-connection `futureDatedGuard` (default on) drops `valid_from > now` before resolving.
- Q8 — images: still open (Phase D) — push PNV URLs (cheap) vs re-upload binaries.
- Q9 — multi-location: single `shopifyLocationId` (one location); multi-location still out of scope.
- Q10 — variant option model: still to confirm in **Phase B** (Option1 = "Size", no-variant parents) — only matters when creating products.

---

## 3. How I recommend doing the rest

### 3.1 Sequence (smallest safe slice first)
I recommend building the sync engine in **thin vertical slices**, each shippable and testable on a dev store, rather than building all of §8 at once.

**Phase A — Stock-only sync (the safest, highest-value slice).**
Matches the default `ownership: "stock_only"` config. It touches **only inventory quantities** — never product content — so it can't damage a partner's listings, and it sidesteps the entire price/VAT ambiguity (Q4/Q5) for now.
1. `POST /shopify/connection/:id/sync` → create a `shopify_sync_jobs` row, run it.
2. Pull the connection's products (from its chosen `custom-export` config).
3. Match each variant by SKU/barcode → `shopify_product_map` (read existing, record new matches; **do not create products** in this phase — unmatched → "needs attention").
4. Push `inventorySetQuantities` to the stored `shopifyLocationId`.
5. Write real job status + counts; replace `MOCK_SYNC_JOBS` / `MOCK_UNMATCHED` / `MOCK_COUNTS`.
6. Add the **rate-limited queue from the start** (§8.5) — retrofitting it later is painful.

> **Why stock-only first:** it's the recommended default (§9), the most-wanted feature ("live stock"), and it has the smallest blast radius. A wrong stock number self-heals on the next sync; a wrong price or an overwritten listing is a support incident.

**Phase B — Product create (`syncNewProducts`).**
`productCreate` + `productVariantsBulkCreate` for unmatched items, record returned IDs in `shopify_product_map`. This is where Q10 (Option1 = "Size", no-variant parents) gets resolved.

**Phase C — Price + description updates (`portal_authoritative` content).**
`productVariantsBulkUpdate` (price) + `productUpdate` (content). **Gate this on resolving Q4/Q5 first** — pick the VAT rule and the future-date guard before pushing a single price. Add delta detection (§8.4) here so content updates only fire on real changes.

**Phase D — Images + triggers.**
Optional image media (Q8), then wire the automatic triggers (§8.1): delta push at end of PNV sync, nightly reconcile via n8n.

### 3.2 Technical recommendations
- **Use the GraphQL Admin API** for the push (design already prefers it) — `inventorySetQuantities`, `productVariantsBulkUpdate`, bulk ops — fewer calls, better cost control than REST. Keep the existing REST `adminClient` only for the lightweight lifecycle calls it already does.
- **Queue lives per shop**, with a concurrency cap and backoff keyed off Shopify's `throttleStatus`. Start simple (an in-process queue driven by `shopify_sync_jobs`); only reach for a dedicated worker/broker if volume demands it.
- **`shopify_product_map` is authoritative once written** (§7) — re-match only unmapped items; never re-match on every sync.
- **Decide Q4 (VAT) before Phase C.** Wrong VAT = wrong prices in real partner stores. Surface the chosen mode clearly in the UI.
- **Keep webhook registration non-fatal** (already true) so localhost/tunnel dev doesn't block installs.
- **Test on two dev stores as two portal users** to keep proving the multi-tenant path each phase.

### 3.3 Before production (deployment checklist)
- Public **HTTPS** host for the API (no `localhost`); set `SHOPIFY_API_BASE_URL`, dashboard **App URL**, and **Redirect URL** all to that same host (same-host rule).
- Confirm the unlisted-public review requirement for the current scope set in the Partner dashboard.
- Privacy policy URL + app-listing basics filled (required even for unlisted).
- Rotate/secure `SHOPIFY_TOKEN_ENC_KEY` and `SHOPIFY_STATE_SECRET` (env or secrets manager, Q7) — and **never** rotate the enc key without a token-re-encryption migration (it makes stored tokens undecryptable).

---

## 3.4 App URL entry point + approval readiness ✅ NEW

For a distributed (unlisted/listed) app, Shopify loads the configured **App URL** — with a signed query (`shop`, `hmac`, `host`, `timestamp`, `session`) — whenever a merchant opens the app from their admin. Previously the App URL pointed at the Auth0-gated portal page, which ignored the params and showed a login wall (a guaranteed review failure on a fresh test store).

**Decided:** **unlisted + non-embedded**, **portal-first**. Added a dedicated App-URL handler so the entry point behaves:
- **`GET /shopify/entry`** (`shopifyController.entry`, no JWT) — verifies the query HMAC (`verifyOAuthHmac`), normalizes `shop`, then redirects into the portal: **already connected** → open the portal on that store (`?shop=`); **not connected** → open the connect form with the domain prefilled (`?connect=1&shop=`), where the partner signs in (Auth0) and approves the install (binding the store to their `ownerSub`). Never renders a raw gated page. Invalid HMAC → `400`.
- **`shopifyConnection.findByShopDomain(shop)`** — most-recent active connection for a shop (drives the connected/not-connected branch).
- **UI** — the portal page now reads `?shop=` / `?connect=1`: prefills `ConnectStore`'s domain (`connectPrefill` → `initialDomain`) or selects the matching store; strips the Shopify params after.

**Partner Dashboard config (documented in `example.env`):** App URL = `{SHOPIFY_API_BASE_URL}/shopify/entry`; Allowed redirection URL(s) = `…/shopify/callback`; **Embed app in Shopify admin = OFF**; privacy-policy URL + name/icon filled.

**Approval checklist — status:** App-URL handler + HMAC ✅ · OAuth callback HMAC ✅ · signed state ✅ · webhook HMAC ✅ · GDPR + `app/uninstalled` webhooks ✅ · expiring-token refresh ✅ · least-privilege scopes (no protected customer data) ✅ · non-embedded (no App Bridge needed) ✅. **Remaining (ops, not code):** set the dashboard App URL/redirect/embedded-off, public HTTPS host (no `localhost`), privacy policy + listing basics. Note: a cold open binds to a portal account via Auth0 login — acceptable for unlisted B2B; a *listed* app would want smoother account-linking.

### 3.4.1 Smoother connect handoff (auth-first guided resume) ✅ NEW
**Decided:** approved-partners-only (the app pushes Patrik's catalogue, so connectors must be provisioned), auth-first, OAuth auto-launched on resume. The cold-open flow is now a guided handoff rather than dropping the partner on the settings page:
- **Resume card (`ResumeConnect`)** — when the portal is opened with `?shop=<domain>` for a store that isn't connected (Shopify App URL → `/entry` → portal), it renders a focused *"Connecting your store → time-4-action-dev"* card and **auto-launches OAuth after ~1.2 s** (visible spinner, **Cancel** drops to the manual form with the domain prefilled). A matched (already-connected) shop selects that store instead; a bare `?connect=1` opens the manual form.
- **`returnTo` now carries intent through login** — the middleware (`proxy.js`) redirects an unauthenticated hit on a protected route to `/auth/login?returnTo=<full path+query>`, so `?connect=1&shop=` survives and the partner lands straight on the resume card. (Previously `withPageAuthRequired` in the `(protected)` layout handled the redirect, but in the App Router it can't see the query string — it dropped the params and sent the user to the base URL after login, breaking auto-connect. The layout is now a simple session-check fallback.)
- **Tailored "request access" screen** — `proxy.js` now forwards the pending `shop` into the `/unauthorized` redirect (`?reason=shopify&shop=`); `/unauthorized` detects it and shows a Shopify-branded *"your account needs Shopify access for `time-4-action-dev`"* card (names the store + signed-in email, Request-access → `/contact`, Switch-account → logout) instead of the generic wall. Once an admin grants the `export` role, reopening the app resumes automatically.

Net cold-open experience (provisioned partner): open app → (login if needed) → focused card → Shopify consent → connected — no domain typing, no redundant "Connect" click. Not-yet-enabled partner → a clear, store-aware request-access screen instead of a dead end.

### 3.4.2 Disconnect ↔ uninstall symmetry ✅ NEW
The two teardown directions now stay in step:
- **Portal disconnect → removes the app in Shopify.** `disconnect` now calls `shopifyApi.uninstallApp` (`DELETE /admin/api/<ver>/api_permissions/current.json`, Shopify's "app uninstalls itself" — revokes the token, removes the app card, fires `app/uninstalled`) **before** deleting our record + product map. Best-effort: if the token is already dead, we still drop our record.
- **Shopify uninstall → removes it from the portal.** Already wired via the `app/uninstalled` webhook → `markUninstalledByShop` (now also clears `refreshTokenEnc` and returns the affected ids) → the handler drops their product maps; `status: 'uninstalled'` hides the store from the portal list. The connection ROW is kept so a reinstall reuses it and **preserves the partner's config**.
- **Gotcha (why "vice versa" looked broken):** the `app/uninstalled` webhook only arrives if `${SHOPIFY_API_BASE_URL}/shopify/webhooks` is **publicly reachable** — Shopify can't POST to `localhost`. In dev, point `SHOPIFY_API_BASE_URL` at a public HTTPS tunnel (ngrok/cloudflared); prod (`api.time-4-action.com`) works as-is.
- **Backstop — lazy uninstall detection (webhook-independent).** Because the webhook can be missed (localhost dev, or any delivery failure), the portal no longer relies on it alone: when `loadLiveShopData` loads a store's live data and Shopify rejects the token with **401** (revoked — what an uninstall does), the controller mirrors the webhook — `markUninstalledByShop` + drop the product map — and returns `uninstalled: true`; the UI removes the store from the switcher with an "uninstalled in Shopify" notice. `shopifyGraphql` now carries the HTTP status on its `SHOPIFY_AUTH` error so 401 (revoked → uninstall) is distinguished from 403 (scope). A merely-expired refresh token still flips to `error` (reconnect prompt), not uninstalled. Caveat: detection fires when a store's `/detail` is loaded (i.e. on select / when it's the auto-selected store) — an unselected stale store lingers until clicked or until the webhook lands.

---

## 4. Status at a glance

| Layer | Item | Status |
|---|---|---|
| Control plane | OAuth install + callback | ✅ |
| Control plane | Token encryption / state / HMAC | ✅ |
| Control plane | Connection CRUD + config | ✅ |
| Control plane | Webhooks (uninstall + GDPR) | ✅ |
| Control plane | Status / locations | ✅ |
| Control plane | UI wiring (connect/disconnect/config) | ✅ |
| Distribution | Public/unlisted, multi-partner | ✅ decided |
| Data plane (A) | `sync` endpoint (stock-only, 202 + background) | ✅ |
| Data plane (A) | Matching (SKU→barcode) + `shopify_product_map` | ✅ |
| Data plane (A) | Inventory push (`inventorySetQuantities @idempotent`) | ✅ |
| Data plane (A) | Rate-limited per-shop queue + GraphQL throttle client | ✅ |
| Data plane (A) | Real job runs / counts / needs-attention (kill `MOCK_*`) | ✅ |
| Data plane (C) | Price push (`productVariantsBulkUpdate`, VAT + future-date guard) | ✅ |
| Data plane (C) | Description/content push (`productUpdate`) | ✅ |
| Data plane (C) | Delta detection (`priceHash` / `contentHash`) | ✅ |
| Data plane (C) | Pricing panel loads real catalogue pricelists (kill mock) | ✅ |
| Data plane (B) | Product create (`syncNewProducts`, new + partial-match) | ✅ |
| Data plane (B) | Starting inventory set at creation; no-variant parents (Q10) | ✅ |
| Data plane (D) | Auto triggers (PNV delta, n8n reconcile, initial-on-ready) | ✅ |
| Data plane (D) | Images (`syncImages` → `productUpdate(media:)`, media-less only) | ✅ |
| Resilience | Location-change fix (`inventoryActivate` + `stockLocationId`) | ✅ |

**Status: feature-complete.** All planned data-plane work (A/B/C/D) is built and live-verified. Remaining items (§2) are refinements — true per-product delta, image re-push on change, multi-location, the cosmetic "Resolve" buttons. n8n setup for nightly reconcile: point a schedule at `POST /api/export/webhooks/sync/shopify` (with the `x-api-key` it already uses for `/sync/pnv`).

---

## 5. Planned next: Own Sources (external supplier feeds → same push) 🟡 DESIGNED, NOT BUILT

> Full design (UI + backend, in detail): **[`external_integration.md`](./external_integration.md)**.

The Shopify push is **brand-agnostic** — it pushes whatever normalized product list `buildScope()` returns; it doesn't care where the products came from. That makes a second, *inbound* initiative cheap: let a portal user register **their own supplier feeds** (other brands they resell — e.g. **Point-7** alongside Patrik) so those products flow through the **same** matching → map → delta → create/price/content/image push into their store. The expensive half (egress) is already done.

**Design pillars (decided):**
1. **Contract-first, validate-never-parse.** The feed is **strictly-formatted JSON** against a published schema. The portal validates and either ingests or **rejects the whole import** with an error report — it does **no** column-mapping/normalization. "If you want the integration, you follow the format." This kills per-supplier code, markup math (price is stated in the feed), and parsing edge-cases.
2. **Separate collection.** Ingested products live in a **new `external_products` collection** (config/registry in **`own_sources`**), never in Patrik's `products`. Physical isolation → the PNV prune can't clobber feeds and vice-versa; dropping a brand is `deleteMany({ feedId })`.
3. **Owner-scoped (multi-tenant).** Ingested rows carry `ownerSub` + `feedId`; a user only ever sees/pushes their own feeds (+ Patrik if entitled).
4. **One read-side branch, nothing else moves.** `buildScope()` (`shopifySync.service.js:132`) gains a `scope.type` switch: `export_config` → `applyFilters` over `products` (today); `own_source` → read `external_products` for that feed. Both emit the **same** `{ products, items }` shape → matching, `shopify_product_map`, delta, queue, create/price/content/images, auto-triggers all stay byte-for-byte unchanged.

**Tags carry through (the specific thing to preserve).** Today the Shopify push tags via `resolveTagsArray(product, config)` → AI categories expanded hierarchically by `expandCategoryToTags` (the `"Sails / Slalom"` → `["Sails", "Sails / Slalom"]` `" / "` behaviour) with a `categories[]` fallback, plus `new`/`recommended` flags (`customExport.service.js:57,970`). External feeds have no `ai_categories`/`exportId`, so the contract lets a feed supply **`tags[]`** (pushed as-is) and **`categoryPaths[]`** (expanded with the same `" / "` hierarchy at ingest). `resolveTagsArray` gets a small branch: external products use their **pre-resolved `tags`**; Patrik keeps the AI-category path. → tagging stays consistent across both sources. (See `external_integration.md` §"Tags & categories".)

**Scheduling is portal-driven, not n8n.** Each feed's cadence ("every 6h", "daily 03:00") is set **in the UI when configuring the source**, and the portal runs it via a **new in-process scheduler** (tick + atomic Mongo claim-lock + persisted `nextRunAt`, restart-safe). This is a deliberate break from the API's "no internal cron scheduler" rule, justified by self-serve UX. "Import now" stays manual; an `x-api-key` webhook is kept only as an optional back-fill escape hatch.

**Net new surface:** two collections (`own_sources`, `external_products`) + a validate-and-snapshot **importer** + a **portal scheduler** + a self-serve **"Own sources"** UI under `integrations/` (add feed URL, "Test feed" validation, **schedule picker**, health, link feed → store) + one `scope.type` branch. Everything downstream of the normalized list is reused.

| Layer | Item | Status |
|---|---|---|
| Contract | Published JSON Schema + example feed | 🟡 designed |
| Ingest | `own_sources` registry + `external_products` data collections | 🟡 designed |
| Ingest | Validate-whole / reject-whole importer (snapshot upsert + sweep) | 🟡 designed |
| Ingest | **Portal-driven** per-feed schedule (new in-process scheduler + Mongo claim-lock; configured in the UI, NOT n8n) | 🟡 designed |
| Push | `buildScope()` `scope.type` branch (`export_config` \| `own_source`) | 🟡 designed |
| Push | Tags: `resolveTagsArray` external branch (`tags[]` + `categoryPaths[]`) | 🟡 designed |
| UI | "Own sources" page (list / add-edit / Test feed / health / history) | 🟡 designed |
| Cross-cutting | Owner-scoping (`ownerSub` + `feedId`) on every ingested row | 🟡 designed |

---

## 6. Price factor + always-current prices ✅ BUILT (2026-08-08)

Two related changes to the pricing path. Both are **backwards compatible** — a connection that has never seen either setting pushes exactly the prices it pushed before.

### 6.1 Price factor (`priceFactor`)

A multiplier applied to every price the push sends, for a store selling the catalogue in **another currency** or at a **fixed uplift** (e.g. `11.4`).

- **Where:** per-source (`scopes[].priceFactor`), falling back to the connection-level `config.priceFactor` — the same pattern as `priceVatMode`. Added to `SCOPE_CONFIG_KEYS`, so each source pushed to the same store can carry its own factor.
- **Precision:** the factor keeps up to **6 decimals** (an exchange rate needs them); only the **resulting price** is rounded, once, to the 2 dp Shopify stores. Rounding goes through `toMoneyString()`, which fixes `toFixed(2)`'s binary-float half-rounding bug (`1.005` → `1.01`, not `1.00`) — a multiplier makes those halves far more common.
- **Sanitizing:** `normalizePriceFactor()` (new `src/services/shopify/priceFactor.util.js`, shared by the sync engine and the connection service) coerces anything missing / zero / negative / non-numeric to `1`, accepts a comma decimal (`"11,4"`), and caps at 1 000 000. The value is normalized **on write** too, so what's stored is what the partner sees.
- **Applies to:** every price the engine sends — Phase C updates (`resolvePushPrice`) *and* the create phase (`buildProductSetInput` / `buildCreateVariantInput`).
- **Order:** net → VAT mode → factor. Multiplication commutes, so VAT-inclusive and VAT-exclusive stores both scale correctly.
- **UI:** a "Price factor" field in the per-source **Pricing** panel (Configure modal), with a live worked example (`100.00` → the pushed figure), a "Reset to 1" affordance, and the factor shown on the source summary line (`· prices ×11.4`) so an uplift is visible without opening the source.

### 6.2 Prices stay current after handoff

Phase C used to run in `portal_authoritative` **only** — so in `create_then_handoff` a price was set once at creation and then never again, and a store could sell at a stale price indefinitely.

Phase C now also runs in `create_then_handoff` with a new `pricesOnly` flag, gated on the source's **Prices** toggle:

| Mode | Stock | Price | Title / description / tags / option name / channels |
|---|---|---|---|
| `stock_only` | ✅ | — | — |
| `create_then_handoff` | ✅ | ✅ (when Prices is on) | set at creation, **never touched again** |
| `portal_authoritative` | ✅ | ✅ | ✅ |

Price is treated like stock: a live field, drift-corrected against the **live store** each run, so a price edited in Shopify is brought back in line. The handoff still protects everything the merchant actually customizes. Tombstoned rows (`deleted_in_store`) are skipped as before — a deleted handoff product is never resurrected by the price push.

**Files:** `shopify/priceFactor.util.js` (new), `shopify/shopifySync.service.js`, `shopify/shopifyConnection.service.js`, UI `components/ShopifyIntegrationPage.js`.

### 6.3 Fix: connection-level `syncTags` was unsaveable

`syncTags` (split out of `syncDescriptions` when tags got their own toggle) was never added to the `updateConnectionConfig` whitelist, and the UI never sent it in the connection-level config block — so turning **Tags** off only stuck per-source. A source that didn't set its own `syncTags` fell back through `resolveScopeConfig` to a connection-level value that could never be written, landing on the engine default (`cfg.syncTags !== false` → ON).

Fixed at all three points: added to the `allowed` whitelist, added to `DEFAULT_CONFIG` (`true`, matching the engine default), and now sent by the UI's `saveConfig`. Existing connections are unaffected — an absent `syncTags` still reads as ON.

---

## 7. Multi-location fulfilment ✅ BUILT (2026-08-16)

**The bug.** A pushed variant was only ever *activated* at the one location its source syncs to. Shopify won't let any other location fulfil an item whose inventory isn't active there, so an order routed elsewhere showed **"Location doesn't fulfill this variant"** and the merchant couldn't pick that location at all. Every created product had it.

**The fix.** A new step, `stockAtAllLocations` (`shopifySync.service.js`), runs after the stock push in each scope and activates every item this run touched — freshly-created *and* already-mapped — at **every** active location via `inventoryBulkToggleActivation`.

**Applies to existing products too, in every ownership mode** — `stock_only`, `create_then_handoff` and `portal_authoritative` alike. It runs over every mapped item in scope plus anything created that run. Fulfilment isn't a "managed field" the handoff protects; a product that can't be fulfilled is broken in all three modes.

**Stock is not spread, and existing stock is never overwritten.** Other locations are activated at quantity 0; the real number is still only ever written at the scope's own location (`inventorySetQuantities` / `inventoryActivate`, unchanged). Three things guarantee a location that already holds stock is untouched:

1. `inventoryActivate`/`inventoryBulkToggleActivation` activate an item *"by creating an InventoryLevel"* — a level exists **iff** the item is stocked there. So `InventoryItem.inventoryLevels` is exactly the set of already-active locations, and `missing = allLocationIds − active` can only ever contain locations with no level at all.
2. A location in `missing` has no level, so there is no quantity to overwrite — the 0 is a brand-new level's starting value, not a write over anything.
3. The mutation is only ever sent `activate: true`. Nothing in this path can deactivate a location or remove stock.

Details:

- **Location set** — `listLocations` now also returns `fulfillmentServiceId`; locations owned by a third-party fulfilment service (3PL / SFN) are excluded, because their inventory belongs to that service and an app can't activate items there. Read once per run, shared by all scopes.
- **Delta-gated** — a map row records `allLocationsKey` (sha1 of the sorted location-id set) once spread, so a steady-state run makes **zero** calls. Adding a location in Shopify changes the key and the next run picks it up; the key is only written on success, so a failure retries.
- **Never activates twice** — activating an already-active location is a `userError` that would reject the whole call, so rows with a stale key get one batched `inventoryLevels` lookup first and only the genuinely missing locations are toggled.
- **Query cost** — the levels lookup is built per run with `first` sized to the shop's location count and the batch size derived from it (`levelsPlan`), keeping it under Shopify's 1000-point per-query ceiling. A static `first: 50` × 50 items would not have fit. `first` is sized off the **total** location count, not the activatable subset: an item can already be stocked at a location we skip (a 3PL), and a truncated level list would make a stocked location look un-stocked.
- **First-run backlog** — the very first run after this change has to spread the whole existing catalogue (one mutation per item). Capped at `MAX_SPREAD_PER_RUN = 1000` per run with a log line for the remainder; **newly-created items go first**, so a fresh listing is never the one deferred.
- **Reporting** — `counts.locationsActivated` on the run; per-item failures are sampled (10) plus a summary line, so one stubborn location can't bury a run's real errors.
- **Escape hatch** — `config.stockAllLocations: false` turns it off per connection/source (no UI; default on). Single-location stores skip the step entirely.

**Files:** `shopify/shopifySync.service.js`, `shopify/shopifyGraphql.service.js` (`listLocations` + `fulfillmentService`), `shopify/shopifyProductMap.service.js` (`allLocationsKey`), `shopify/shopifySyncJobs.service.js` (`locationsActivated`).

**Verified offline** (stubbed `executeRun`, three scenarios): existing mapped item → sets qty at its own location, looks up levels, activates only the missing location, skips the 3PL one, records the key, and re-runs with no calls; created product → `productSet` at its location then activation at the other in the **same run**; `portal_authoritative` item already stocked at a second location (5 units) → that location is **not** in the toggle payload and keeps its 5, only the genuinely unstocked third location is activated (at 0), and the scope's own location gets the catalogue quantity. The harness throws if a `activate: false` or an already-stocked location is ever sent. Not yet live-tested.

---

## 8. Price rounding ✅ BUILT (2026-08-20)

A partner asked for prices that **always end in 9** (2031.99 → 2039). Rather than a one-off "…9" switch, this is a general **rounding rule** — the second price transform, sitting beside `priceFactor` in the same per-source config. The ask is one preset of it; charm endings, nearest-5 and whole-number rounding come along free. **Backwards compatible**: a connection that has never seen the setting pushes exactly the prices it pushed before.

### 8.1 The rule (`priceRounding`)

```js
priceRounding: { enabled: false, mode: 'up' | 'down' | 'nearest', step: 10, offset: 9, alwaysAdvance: false }
```

> `result` = (the multiple of `step` nearest to `amount − offset`, per `mode`) + `offset`, with `offset ∈ [0, step)`.

One primitive, not a menu of tricks. `offset` is the ending to land on:

| Rule | mode | step | offset |
|---|---|---|---|
| Whole number, up | `up` | 1 | 0 |
| Nearest 0.05 | `nearest` | 0.05 | 0 |
| Nearest 5 | `nearest` | 5 | 0 |
| Ends in .95 / .99 | `up` | 1 | 0.95 / 0.99 |
| **Ends in 9** | `up` | **10** | **9** |

`alwaysAdvance` (up/down only) moves a price that **already sits on the ending** one step further — 2039.00 → 2049. **Default off**, and deliberately not part of any preset: it raises prices nobody asked to raise, and since the rule reads the *source* price it ratchets across source edits (edit the source to 2049 and the store goes to 2059). It never ratchets *within* syncing — rounding never reads the live Shopify price. It is a separate checkbox so a partner opts in explicitly.

- **Where:** per-source (`scopes[].priceRounding`), falling back to connection-level `config.priceRounding` — same pattern as `priceFactor`, and added to `SCOPE_CONFIG_KEYS`.
- **Precision:** all arithmetic is **integer cents** — there is no `x / step` anywhere. The input is `price × factor` and can arrive as `2039.0000000000002`; one float division on that spuriously jumps a whole step. The amount is quantized first (the same `toPrecision(12)` trick `toMoneyString` uses), then the grid decision is made on integers. `%` is taken the long way (`((d % s) + s) % s`) because `d` goes negative for a cheap price under a coarse rule.
- **Order:** net → VAT mode → **factor → rounding** → `toMoneyString`. Never the reverse: a factor is a unit conversion, so rounding first and converting after destroys the ending (2039 × 11.4 = 23244.60).
- **VAT:** the rule rounds *the price actually sent*. Under `inclusive` that is the gross shelf price (what the partner means); under `exclusive` it is the net, and the shopper's post-tax price won't carry the ending. The panel says which, live. Deliberately **not** solved by rounding the gross and backing out the net — Shopify stores 2 dp, so the gross wouldn't land on the ending anyway and the net would carry an ugly tail.
- **Sanitizing:** `normalizePriceRounding()` (new `src/services/shopify/priceRounding.util.js`, shared by the sync engine and the connection service) always returns a **complete, fixed-key-order** object. Both matter: `resolveScopeConfig` falls back whole-value, so a partial rule would push with another source's numbers; and the portal's unsaved-changes check is a `JSON.stringify` comparison, which a shuffled key order breaks. A rule that doesn't make sense is **disabled, not repaired** — an unknown `mode`, or a `step` of 0 or above the cap, leaves prices untouched rather than silently re-pricing a catalogue in a direction nobody chose. Normalized on write at both levels.
- **Safety:** `step` is capped at **1000**, which *is* the blast radius — the invariant is that a rule never moves a price by more than one step. `applyPriceRounding` is the identity for a disabled rule, a non-finite or ≤ 0 amount, and a result that would land ≤ 0 (a `down` rule on a cheap item), so it is called unconditionally with no branch at the call site. Deliberately **no** "don't more than double the price" rail — that would apply the rule to some items and not others. Instead the panel shows three worked prices (cheap / mid / expensive) so a silly rule is visible before saving.
- **Applies to:** every price the engine sends — Phase C updates *and* the create phase, in both `portal_authoritative` and `create_then_handoff` (`pricesOnly`), for Patrik exports and Own Source feeds alike (the engine is brand-blind below `resolvePushPrice`).
- **Drift:** nothing extra needed. The candidate price is recomputed from source + config every run, so changing the rule differs from the live price → drift → re-push; the `sha1(price)` fallback hash differs too.

### 8.2 Refactor: `resolvePriceOpts`

`buildProductSetInput` had reached **11 positional parameters** and `resolvePushPrice` 6, with the same four-line config read duplicated in Phase C and the create phase. A twelfth argument was worse than fixing it, so the pricing settings now travel as one sanitized bundle:

```js
resolvePriceOpts(cfg) → { pricelistPriority, vatMode, futureGuard, factor, rounding }

resolvePushPrice(variant, priceOpts, nowMs)                                          // 6 → 3
buildCreateVariantInput(plan, v, locationId, priceOpts, nowMs, variantOptionName)    // 9 → 6
buildProductSetInput(plan, exportConfig, locationId, priceOpts, nowMs, wantTags, …)  // 11 → 8
```

It is now the single place a source's pricing is read, so the next price transform costs one field instead of three call-site edits.

### 8.3 UI

A "Round prices" toggle in the per-source **Pricing** panel, directly **below** the price factor — the panel order mirrors the apply order. Behind it: a preset picker, a "Custom…" mode with direction / step / **ends in** pickers, the `alwaysAdvance` checkbox, and the three-price worked example.

Step and ending are `<select>`s, not text fields, on purpose: free-text would need transient `stepText` / `offsetText` state reset in four separate places (the same plumbing `factorText` already needs), and every realistic rule uses one of ~8 step values. The rails are enforced by construction instead. `src/lib/priceRounding.js` is a **literal port** of the API util — it has to be, because `saveConfig` marks the form clean optimistically, so a client/server normalizer disagreement would show a saved form that changes on reload. The rule also appears on the source summary line (`· rounds up to …9`) so it is visible without opening the source.

**Files:** `shopify/priceRounding.util.js` (new), `shopify/shopifySync.service.js`, `shopify/shopifyConnection.service.js`, UI `lib/priceRounding.js` (new), UI `components/ShopifyIntegrationPage.js`.

**Verified offline:** 40 assertions over the rule (the four `{up,10,9}` cases with and without `alwaysAdvance`, the `nearest` tie at 2034, every preset, float-hostile inputs including `2039.0000000000002`, every rejection path, key-order stability, and a swept check that no rule ever moves a price further than one step); the engine's real `resolvePushPrice` end-to-end over a stubbed config (net → gross → ×11.4 → 2489.00, legacy config unchanged, broken rule ignored); and a 27 456-case comparison confirming the UI mirror and the API util agree **exactly** on every rule/amount combination. UI lints clean and builds. **Not yet live-tested against a store.**

## 10. Sources API for Recharge Hub ✅ BUILT (2026-09-22)

Recharge Hub (the Recharge store's own embedded app) wanted one admin for its staff without a
second development of this page. Two embedded Shopify apps cannot share a screen (session
tokens are per `client_id`), so this portal keeps its own install on the store and exposes what
this page does as a **versioned API** (`/api/v1`, design `t4a-partner-portal-api/docs/sources-api.md`),
keyed by a per-store API key the partner mints here under **API access**. Recharge Hub's
*Sources* area is a generic UI over it: the portal describes each source kind's settings as
typed fields, so a new setting here needs no change there.

**Engine changes:** scopes carry a stable `id` + optional `name` + `enabled`
(`reconcileScopeIdentity` keeps them across a whitelist save; the UI now carries them too); a
disabled scope does not run; `startStockSync` takes `scopeIds` and the job records which scopes
it covered. **Verified** by `scripts/sources-api-smoke.js` (every endpoint and refusal, identity
survival, a per-source run through the real engine against a throwaway Mongo). Not live-tested
against a real store yet — the first real key will be Recharge's.

## 9. Compare-at price + existing-sale policy ✅ BUILT (2026-09-19)

Until now the engine pushed `price` only, `compareAtPrice` was never sent, and the drift check read `price` only — so in `portal_authoritative` a merchant's in-store sale (compare-at + lowered price) was flattened every run, and a partner had no way to show a struck-through "was" price from a second pricelist. Three per-source settings fix both, all with connection-level fallback (`SCOPE_CONFIG_KEYS`, `DEFAULT_CONFIG`, the `allowed` whitelist, normalized on write at both levels):

| Key | Values | Default |
|---|---|---|
| `compareAtPricelist` | pricelist name or `null` | `null` = **off** |
| `priceFields` | `price_and_compare_at` · `price_only` · `compare_at_only` | `price_and_compare_at` |
| `existingSalePolicy` | `overwrite` · `leave` · `price_only` · `compare_at_only` | `overwrite` |

**Shopify facts this rests on.** `compareAtPrice` is variant-level and cosmetic: the storefront strikes it through next to `price` only when it is *higher*; the customer always pays `price`. `ProductVariantsBulkInput`, `productSet` variants and `productVariantsBulkCreate` all accept it; `null` clears it. **Automatic (cart) discounts are a separate mechanism that stacks on top of `price` — deliberately out of scope** (no `read_discounts`); the panel says so.

### 9.1 Resolution (`resolvePushCompareAt`)

The compare-at goes through the **same pipeline as the price** — future-dated guard → VAT mode → factor → rounding → `toMoneyString` — so both numbers are always in the same units. It looks the list up **by name directly**, *not* via `getPriceFromPriority`: that helper falls back to `pricelist[0]` when nothing matches, which here would strike through the wrong list's price. It returns the raw amount; the **floor check** (`compareAt > sell price`, else `null`) is the caller's, because the floor is the pushed price on most paths but the **live** price when the source doesn't push `price` at all (`compare_at_only` — the store keeps selling at whatever it has). Rounding can collapse the two onto the same shelf price (2031 → 2039, 2035 → 2039 → no sale); the panel's helper text says the compare-at must end up higher.

### 9.2 Semantics, locked

1. **Feature off (`compareAtPricelist: null`) → payload identical to before.** `{ id, price }`, no `compareAtPrice` key, ever. Every existing connection behaves exactly as it did.
2. **Feature on + compare-at unresolvable** for a variant (list missing on it, future-dated, not above the floor) → `compareAtPrice: null` is sent. The portal owns the field; a stale sale is cleared, not left half-true.
3. `priceFields` only matters with a list — `wantC = !!list && fields !== 'price_only'`, `wantP = fields !== 'compare_at_only'`. The stored value is kept when the list is unset so picking one later restores it; the UI hides the selector until a list is chosen.
4. `existingSalePolicy` is shown whenever prices sync, **with or without** a compare-at list — "don't stomp the merchant's sale" is useful on its own.
5. **Create paths** (`buildProductSetInput`, `buildCreateVariantInput` via `resolveCreatePrices`) send the compare-at when resolvable, omit the key when not, and *always* send a price — even under `compare_at_only`, a new variant needs one. No live sale can exist on a variant being born, so the policy doesn't apply there.
6. **Live fetch fails + policy ≠ `overwrite` → the price step is skipped this run** (logged + an `errors[]` row). Every non-overwrite policy exists to protect something only visible in the live data; guessing from the hash gate would overwrite exactly what the partner asked to keep. `overwrite` keeps the old hash-gate fallback.
7. Applies wherever prices are pushed today: `portal_authoritative`, and `create_then_handoff` with `syncPrices` (`pricesOnly`).

### 9.3 Telling the portal's compare-at from the merchant's

The trap: from the live value alone, a compare-at the portal pushed and one the merchant typed look identical. Without a fix, `leave` would freeze every variant after the portal's own first compare-at push. So the map row now carries **`lastCompareAt`** — the value the portal last pushed (`null` when it cleared it; `undefined` on rows that never had compare-at managed). Set on Phase C push (`bulkSetHashes`) and at creation. A merchant-made sale is then:

```
hasSale = live.compareAtPrice != null
       && money(live.compareAtPrice) !== money(row.lastCompareAt ?? candidateCompareAt)
```

Rows from before this feature fall back to comparing with what the portal *would* push now. A merchant lowering `price` alone, without a compare-at, is undetectable — documented, not solved. `leave` also means: the merchant removes their sale → the next run takes the variant back.

Policy matrix, applied per variant only when `hasSale` (`applySalePolicy`):

| policy | pushes price | pushes compare-at | counted as |
|---|---|---|---|
| `overwrite` | as configured | as configured | — |
| `leave` | no | no | `salesLeft` |
| `price_only` | as configured | **no** | — |
| `compare_at_only` | **no** | as configured | — |

If the policy leaves nothing to push (e.g. `price_only` policy on a `compare_at_only` source) the variant is skipped and counted as `salesLeft`.

### 9.4 Drift + hash

`VARIANT_PRICE_QUERY` now reads `compareAtPrice` too; `fetchLivePrices` returns `{ price, compareAtPrice }`. Drift = price differs (if pushed) **or** compare-at differs (if pushed), compared as 2-dp strings / null. The payload carries only the fields being pushed (`{ id, price?, compareAtPrice? }`); the mutation is unchanged. The fallback hash is now `sha1(JSON([price|'-', compareAt|'null'|'-']))` (`priceHashInput`), distinguishing "not managed" from "managed and cleared" — legacy `sha1(price)` rows differ once and re-push a single time, only on the fetch-failure path. New counters: `compareAtPushed`, `salesLeft` (activity row + run detail).

### 9.5 UI

In the per-source **Pricing** panel, below the future-dated guard: a **Compare-at pricelist** picker (off / any pricelist; amber note when it is also the first enabled priority list, since then nothing shows as a sale), a **Fields the portal maintains** segmented control (shown once a list is picked), and **When a variant is already on sale in Shopify** (always shown). Both selectors reuse the VAT-mode radio styling and show the selected option's hint inline. `src/lib/comparePrice.js` is a **literal port** of the API util for the same optimistic-save reason as `priceRounding.js`. The source summary line shows `· compare-at: RRP 2026` and `· merchant sales: leave it alone` when non-default.

**Files:** `shopify/comparePrice.util.js` (new), `shopify/shopifySync.service.js`, `shopify/shopifyConnection.service.js`, `shopify/shopifyProductMap.service.js` (`lastCompareAt`), `shopify/shopifySyncJobs.service.js` (counters), `controllers/shopifyController.js` (activity summary), UI `lib/comparePrice.js` (new), UI `components/ShopifyIntegrationPage.js`. Scratch: `scripts/scratch-compare-at.js`.

**Verified offline** (`node scripts/scratch-compare-at.js`, 65 assertions): normalizers, `wantedFields`, the full policy matrix, hash distinctness, the resolver through VAT / factor / future guard / rounding collapse, the create path, and the real `pushPortalAuthoritative` Phase C loop over a stubbed store and map — legacy payload byte-identical, overwrite / leave / price_only / compare_at_only per variant, own-compare-at-is-not-a-sale via `lastCompareAt`, clear-on-unresolvable, live price as the floor under `compare_at_only`, fetch-failure skip vs hash-gate. UI lints clean. **Not yet live-tested against a store.**
