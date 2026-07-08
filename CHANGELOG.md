# Changelog

All notable changes to the **Time 4 Action Partner Portal** are documented here. This is
a **unified** changelog covering both repositories:

- **API** — [`t4a-partner-portal-api`](https://github.com/time-4-action/t4a-partner-portal-api)
- **Portal** — [`t4a-partner-portal-ui`](https://github.com/time-4-action/t4a-partner-portal-ui)

The same content is rendered for partners at **`/changelog`** in the portal. The single
source of truth for both this file and that page is
[`t4a-partner-portal-ui/src/lib/changelog.js`](t4a-partner-portal-ui/src/lib/changelog.js).

The format is based on [Keep a Changelog](https://keepachangelog.com), and this project
adheres to [Semantic Versioning](https://semver.org). Each version is an annotated git
tag (`vX.Y.Z`) pushed to the repositories it touches. Early releases (`0.1.0`, `0.2.0`)
predate the portal and exist in the API only.

> **Cutting a release?** Follow `docs/RELEASING.md`.

---

## [1.1.0] — 2026-07-07 · General Availability

_Scope: API + Portal · api `c67bdda` · ui `1445b5e`_

Shopify and Own Sources leave early access and open to every export partner.

### Added
- Shopify and Own Sources graduate to full **GA** — the alpha/beta tier gate is gone; access is by the standard `export` role.
- Bring-your-own Shopify app connect flow ("Shopify Deprecated", Beta): a partner registers their own Partner-Dashboard app and installs it via OAuth.
- Rename connected stores with an inline pencil edit in the store switcher and connection header.

### Changed
- Export and source names are now unique **per account** instead of globally.
- "Shopify Prerelease" renamed to "Shopify Deprecated" and moved to `/integrations/shopify-deprecated` (old path redirects).

### Fixed
- OAuth no longer fails with `INVALID_STATE` when the typed domain differs from the canonical `.myshopify.com` domain — it binds to the HMAC-verified callback domain.

## [1.0.0] — 2026-06-16 · GA-Readiness

_Scope: API + Portal · api `7c56410` · ui `0fdab09`_

The Shopify app passes App Store review; the portal gets its public front door and admin tooling.

### Added
- Public Shopify welcome page and a shared request-access form with claim / decline wiring.
- Admin partner-activity instrumentation and an admin partners API.
- Admin controls for the catalogue scheduler (status + run-now) and free-stock handling.

### Changed
- Shopify app passes App Store review — hardened install flow and GraphQL Admin API, with an access-gated connect that breaks cleanly for non-approved partners.
- Welcome page is skipped for logged-in users and redesigned mobile-first.

## [0.6.0] — 2026-06-11 · Shopify Integration

_Scope: API + Portal · api `d3220f6` · ui `05fef95`_

The headline release: a full one-way product sync to Shopify, external feed ingest, and a Claude-powered catalogue pipeline.

### Added
- One-way Shopify product sync built in phases: OAuth connection control plane, stock-only engine (A), product create (B), price + description push (C), images + auto-triggers (D).
- Multiple connected Shopify stores per account with a store switcher.
- Own Sources: ingest external brand feeds (Point-7 and others) into the same Shopify push.
- In-app catalogue scheduler (PNV) that replaces the external n8n cron.
- Alpha / beta early-access tiers with a "join the program" screen.
- Public privacy policy page at `/privacy`.
- Product detail modal, searchable product grid, and live AI-run progress with an ETA.
- Deleted-in-store detection with a per-product "recreate on next sync" control.

### Changed
- AI categorization switched from Google Gemini to Anthropic Claude Haiku.
- The partner API now serves only published products.
- Authoritative sync mode overwrites in-store drift across price, content and publications.

### Fixed
- Self-heal stale product-map rows, relink variant images, restore gallery order, and heal FAILED media.
- GDPR `shop/redact` webhook erases all data for a shop.

## [0.5.0] — 2026-05-21 · Export Correctness

_Scope: API + Portal · api `50a71e4` · ui `98cf8e0`_

Exports become trustworthy — published-only, everywhere, in every format.

### Added
- JSON and XML downloads for the inventory preset.

### Changed
- Inventory preset simplified to SKU + Quantity only.
- The published-only filter cascades into variants and is always enforced on every export and sync.

### Fixed
- Unpublished products are excluded from `/search`.

## [0.4.0] — 2026-04-18 · Exports Mature

_Scope: API + Portal · api `3113652` · ui `8c6fc2c`_

New export formats, a public search endpoint, and a full documentation overhaul.

### Added
- Recharge XML export, inventory CSV (Shopify import) export, and an external categorization endpoint.
- Public product search endpoint (`GET /api/product/search`) with exact-code matching and an optional AI category.
- AI categorization playground tab in the portal.
- Configurable Option1 (Variant) name per export config.

### Changed
- Scheduled catalogue refresh moved from node-cron to n8n.
- Size is extracted from the product name when the CSV size field is empty (regex handles "l", "V2" and rider-tag suffixes).
- README and docs overhauled with architecture diagrams, a deployment guide and API references.

## [0.3.0] — 2026-02-07 · Partner Portal + Rebrand

_Scope: API + Portal · api `4892260` · ui `eccb9f1`_

The portal is born — Auth0 login, exports and a dashboard — alongside a full rebrand.

### Added
- Next.js partner portal with Auth0 login, a user profile, an export section and a contact page.
- Generic / custom exports, an analytics dashboard and product search by identifier.
- API endpoint protection, health checks and full documentation.

### Changed
- Project rebrand and domain migration across both the API and the portal.

## [0.2.0] — 2026-01-16 · Catalogue Intelligence

_Scope: API · api `7644f87`_

AI category identification, a warehouse view, and named price lists.

### Added
- AI category identification that runs on every products download.
- Warehouse view with price & stock, plus named price lists.
- TSV (tab-separated) export.

### Changed
- Faster service startup.

## [0.1.0] — 2026-01-13 · Product API Genesis

_Scope: API · api `881519e`_

The first commit: the PNV catalogue becomes a JSON API.

### Added
- Fetches the PNV products CSV, transforms it to JSON and serves it at `/api/product/`.
- HTML product view.
- Docker build and docker-compose.

[1.1.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v1.1.0
[1.0.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v1.0.0
[0.6.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.6.0
[0.5.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.5.0
[0.4.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.4.0
[0.3.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.3.0
[0.2.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.2.0
[0.1.0]: https://github.com/time-4-action/t4a-partner-portal-api/releases/tag/v0.1.0
