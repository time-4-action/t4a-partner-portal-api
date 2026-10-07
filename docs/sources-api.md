# Sources API (`/api/v1`)

A versioned machine contract that lets **another product** configure and run one connected
store's Shopify sources over this API, instead of that product rebuilding the Shopify
integration page. The first client is **Recharge Hub** (`recharge-si/recharge-hub`), whose
*Sources* area is a UI over exactly these endpoints; its side of the contract is
`docs/sources.md` in that repository, and the two documents describe the same wire format.

Built 2026-09-22. Verified end to end by `scripts/sources-api-smoke.js` against a throwaway
MongoDB with Shopify stubbed (see the bottom of this page).

## What it is on this side

Nothing new is stored. The API is a **translation** over what the Shopify integration already
keeps (`src/services/shopify/sourcesApi.service.js`):

| Contract word | Here |
| --- | --- |
| tenant | one `shopify_connections` document (a partner's connected store) |
| **source** | one entry of `config.scopes[]` — a catalogue export or an Own Source feed pushed to one location with its own push settings |
| source **kind** | `export_config:<exportConfigId>` or `own_source:<feedId>` — what the partner may push |
| **fields** | the scope's settings (`SCOPE_CONFIG_KEYS` + location + channels), described as typed inputs the client renders without knowing what they mean |
| **run** | one `shopify_sync_jobs` document |
| API key | `apiKeys[]` embedded on the connection, bound to its shop domain |

Three things were added to the engine to make sources addressable:

- **Scope identity.** Every scope now carries a stable `id` (`sc_…`), an optional `name` and an
  `enabled` flag (`shopifyConnection.service.js`: `newScopeId`, `reconcileScopeIdentity`,
  `ensureScopeIds`). Scopes stored before this are stamped on first read through the API. The
  portal UI re-saves scopes through a whitelist, so `updateConnectionConfig` re-attaches
  identity to incoming scopes by matching source + location (then source alone when unique);
  the UI also carries the keys through now, which keeps an id when a source is moved between
  locations.
- **A switched-off scope does not run.** `getScopeList` skips `enabled: false`; the API refuses
  to run one (409 `source_off`).
- **Per-source runs.** `startStockSync(connectionId, { trigger, scopeIds })` runs only the named
  scopes; the job records `scopeIds` at start and each scope's `id` in its `scopes[]` summary,
  so `listRunsForScope` can attribute runs to a source (legacy whole-connection runs count for
  every source).

## Authentication

```http
Authorization: Bearer sk_t4a_<64 hex>
X-Shop-Domain: <shop>.myshopify.com
```

A key is minted on the Shopify integration page (**API access**, per connected store) or via
`POST /api/export/shopify/connection/:id/keys` (JWT, owner-checked). Only its SHA-256 hash is
stored; the raw key is in the create response and nowhere else. Revoke is a soft flag.

`src/middleware/sourcesApiAuth.js`:

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 401 | `missing_key`, `invalid_key` | no bearer, or not a live key |
| 403 | `shop_required`, `shop_mismatch` | the header does not name the key's store — the check that stops a pasted key from reaching another partner's store |
| 409 | `store_not_connected` | the connection is not `active` (uninstalled, awaiting re-auth) |

## Endpoints

| Method | Path | Reply |
| --- | --- | --- |
| `GET` | `/connection` | `{ tenant: { id, name }, shop: { domain }, key: { name, createdAt } }` |
| `GET` | `/source-types` | `{ types: [{ kind, label, description, fields }] }` — the partner's exports and feeds |
| `GET` | `/sources` | `{ sources: [SourceSummary] }` |
| `POST` | `/sources` | `{ source }` (201) — body `{ kind, name, values }` |
| `GET` | `/sources/:id` | `{ source }` with `fields` + `values` |
| `PATCH` | `/sources/:id` | `{ source }` — body `{ name?, enabled?, values? }`, all partial |
| `DELETE` | `/sources/:id` | 204 |
| `POST` | `/sources/:id/runs` | `{ run }` (202); 409 `run_in_progress` / `source_off` / `store_not_connected` |
| `GET` | `/sources/:id/runs?limit=` | `{ runs }` newest first |
| `GET` | `/runs/:runId` | `{ run, log: [{ at, level, message }] }` |

Refusals: `{ error: { code, message }, errors?: [{ field, message }] }`. A 422 names the field.

### Shapes

```
SourceSummary { id, name, kind, kindLabel, enabled, destination, schedule, health, lastRun }
  destination  "<shop name> · <location name>"
  schedule     { mode: manual|automatic, description, nextRunAt }
               export_config → the PNV catalogue scheduler (PRODUCTS_DOWNLOAD_SCHEDULE)
               own_source    → the feed's own schedule, "after the feed imports"
  health       off (enabled:false) · needs_attention (reconnect needed, no location, last run
               failed, or partial with failures/errors) · never_ran · ok
Run           { id, sourceId, status, triggeredBy, queuedAt, startedAt, finishedAt, itemCount, message, downloadUrl }
  status       running→running · done→completed · partial→completed (message carries the counts) · failed→failed
  itemCount    that scope's `products` from the run summary, else counts.inScope
```

### Fields

The per-scope settings as the client sees them (`describeFields` / `valuesFor` / `applyValues`),
grouped: **Store** (`locationId`, from the live locations minus 3PL-owned ones) · **What to
sync** (`ownership`, the six `sync*` booleans) · **Pricing** (`pricelistPriority` as a
comma-separated text of names, `priceVatMode`, `priceFactor`, `futureDatedGuard`,
`compareAtPricelist` from the catalogue's distinct pricelists, `priceFields`,
`existingSalePolicy`) · **Price rounding** (`rounding_enabled|mode|step|offset|always_advance`,
one object on the scope) · **Review before publish** (`reviewNewProducts`) · **Products the portal creates** (`variantOptionName`, `titlePrefix`,
`aiExportId` from the category sets the source may use) · **Sales channels** (one boolean per
publication, `publication:<gid>`, only when the token can publish).

Values come from `resolveScopeConfig` — the same fallback the engine uses — so what the client
shows is what will push. Writes go through `updateConnectionConfig`, so the same normalizers
(`normalizePriceFactor`, `normalizePriceRounding`, compare-at) apply. A rounding rule that does
not make sense is a 422, not a silently disabled rule.

No `secret` fields exist today; the contract reserves the type (the client never echoes one).

**Tokens.** A `text` field may carry `tokens: [{ key, label, example }]` — the `{key}` fields its
value may use, each with what it comes to for one real product of the source (`example`, null when
the source has no products yet) — and `sample: { label, after }`, that product (its code, and the
text the value is put in front of) so a client can preview the result. A client with a pattern
editor offers the fields as chips; one without ignores both keys and shows a plain text field.

Only `titlePrefix` has them today. Its value is a pattern in Recharge Hub's name-pattern syntax
(`src/services/shopify/titlePattern.js`): `{field|filter:arg}` tokens, `[optional groups]` that
vanish when every token in them is empty, and the Hub's filters (`upper`, `lower`, `trim`,
`truncate`, `first`, `last`, `replace`, `prefix`, `suffix`, `default`). Fields: `vendor` (alias
`brand`; the product's own vendor, the one written to Shopify's `vendor`), `product_type`,
`category` / `subcategory` (the first and last level of the product's AI category in the set the
store tags with), `code`. So `"{vendor} -"` gives "Dakine - Seeker Vest" and "Unifiber - Surface
Vest" from one Unifiber feed, and `"{category|upper} -"` gives "WINDSURF - …". A prefix whose
tokens all come out empty adds nothing; a title that already opens with what the prefix names gets
none. An unknown field or filter, or broken syntax, is a 422 on `titlePrefix`.

## Review before publish

`reviewNewProducts` (a per-scope boolean, default off) holds a source's new products for a person
instead of putting them live. The contract with the client is Shopify tags alone; nothing about a
product under review is stored here.

- **Creation** (`pushNewProducts` → `buildProductSetInput`): a product the run creates is
  `status: DRAFT` and carries `awaiting-review` and `portal-source:<scope id>` on top of its own
  tags (even with tag sync off). It is published to the scope's channels as usual; a draft shows
  on none. A variant added to a product already in the store is not held. The run counts them
  (`counts.createdForReview`), and the run message says `N awaiting review`.
- **Every created product names its source.** Outside review mode a product the run creates is
  `ACTIVE` and carries `portal-source:<scope id>` alone (even with tag sync off), so a client can
  tell which source any new product came from — Recharge Hub's AI categorization per source
  reads it from products/create. The tag is reserved like the review ones (`isReservedTag`).
- **Later runs never write `status`** — the only `status` the engine sends is at creation — so a
  run can neither publish a draft nor unpublish an approved product.
- **Tag maintenance keeps the review tags** (`isReservedTag`): the drift check ignores them, and a
  tag write carries whichever of them the live product still has. When the live tags cannot be
  read, tags are not written that run (title/description still are), since a blind write would
  drop a draft out of the queue.
- **Approval is the client's**: Recharge Hub sets the product `ACTIVE` and removes
  `awaiting-review`; `portal-source:<id>` stays as provenance.

The portal UI shows the same switch under *Product creation* in the source modal, and carries it
through every scope save.

## Not in v1

- Cancelling a run.
- Read of the "needs attention" (unmatched SKU) list beyond what the run log carries.
- A per-source schedule: the schedule is the catalogue's or the feed's.

## Smoke test

```
docker run -d --rm --name sources-api-test-mongo -p 27099:27017 mongo:7
MONGO_URI=mongodb://localhost:27099 MONGO_DB_NAME=sources_smoke node scripts/sources-api-smoke.js
```

Seeds a store, a catalogue export and a feed, mints a key and walks every endpoint and refusal,
including the portal UI re-saving scopes without ids (identity survives) and a per-source run
through the real engine (the seeded feed has nothing in scope, so nothing is written).
