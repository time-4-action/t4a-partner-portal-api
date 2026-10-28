# Environment variables

Every variable the service reads from `process.env` in `src/` or `index.js`. `test/envDoc.test.js` greps the
source for `process.env.NAME` and fails when a name is missing here, so a new variable has to be documented
in the same change. Deployment, env-file loading and the Docker run are in `deployment.md`.

"Required" means the feature named in the last column does not work without it. Variables not marked
"at startup" are read lazily, so a missing one shows up on the first request that needs it.

## Server

| Variable | Required | Default | What breaks without it |
|---|---|---|---|
| `NODE_ENV` | No | unset | `development` also loads `.env.development` over `.env`. Anything else behaves as production. |
| `PORT` | No | `3000` | The server listens on 3000. |
| `DATA_PATH` | No | `cwd()` | `.env` and the PNV download are read from the working directory. Docker uses `/data`. |
| `APP_NAME` | No | `Automation API` | Only labels `/api/export/health` and the analytics events. |
| `MONGO_URI` | Yes, at startup | none | The service cannot connect to MongoDB and exits. |
| `MONGO_DB_NAME` | Yes, at startup | none | Same. |
| `ANTHROPIC_API_KEY` | Yes, at startup | none | The AI service refuses to load (categorization and the Sources API `/ai/*` routes). |
| `WEBHOOK_API_KEY` | Yes | none | `/api/export/webhooks/*` cannot be authenticated. |
| `PARTNER_ADMIN_TOKEN` | Yes for t4a-admin | none | `/api/admin/*` refuses every call. |
| `AUTH0_ISSUER_BASE_URL` | Yes for the portal UI | none | JWT login for the portal UI API fails. |
| `AUTH0_AUDIENCE` | Yes for the portal UI | none | Same. |

## Schedulers

| Variable | Required | Default | What breaks without it |
|---|---|---|---|
| `PRODUCTS_DOWNLOAD_SCHEDULE` | No | unset (off) | Without a 5-field cron the PNV refresh (sync, categorization, Shopify push) never runs by itself. Only the webhook triggers work. |
| `EXTERNAL_SCHEDULER` | No | on | `off` stops the Own Source feed ticker. Set it on all but one instance when scaling out. |

## PNV and Metakocka

| Variable | Required | Default | What breaks without it |
|---|---|---|---|
| `PNV_BASE_URL` | For the PNV sync | none | The PNV catalogue cannot be downloaded. |
| `PNV_EXPORT_PRODUCTS_URL` | For the PNV sync | none | Same. |
| `PNV_USER` | For the PNV sync | none | PNV login fails. |
| `PNV_PASS` | For the PNV sync | none | PNV login fails. |
| `PNV_GROUP` | For the PNV sync | none | PNV login fails. |
| `PNV_USER_ID` | For the PNV sync | none | PNV login fails. |
| `METAKOCKA_ID` | For stock and prices | none | Stock and price enrichment cannot call Metakocka. |
| `METAKOCKA_KEY` | For stock and prices | none | Same. |

## Shopify

The Shopify app is the portal's own install. Recharge Hub is a separate Shopify app with its own keys and does
not read these.

| Variable | Required | Default | What breaks without it |
|---|---|---|---|
| `SHOPIFY_API_KEY` | Yes for OAuth connect | none | Starting an install throws `SHOPIFY_API_KEY must be set`. Also the client id for token exchange. |
| `SHOPIFY_API_SECRET` | Yes for OAuth connect | none | Install callbacks and webhooks cannot be verified (HMAC), and token exchange fails. |
| `SHOPIFY_SCOPES` | No | `read_products,write_products,read_inventory,write_inventory,read_locations,read_publications,write_publications` | Comma list requested at install. Narrowing it removes features (publishing needs the publication scopes). |
| `SHOPIFY_STATE_SECRET` | Yes for OAuth connect | none | Signing the OAuth `state` throws `SHOPIFY_STATE_SECRET must be set`. |
| `SHOPIFY_TOKEN_ENC_KEY` | Yes | none | 64 hex characters. Store access tokens cannot be encrypted or read, so no push and no Sources API call works. |
| `SHOPIFY_API_BASE_URL` | Yes for OAuth connect | none | Origin of this API, used to build the OAuth redirect (`/shopify/callback`) and the webhook address. Without it Shopify is sent to `undefined/...`. |
| `SHOPIFY_API_VERSION` | No | `2026-04` | Admin API version of every call the portal makes. See below. |
| `SHOPIFY_PORTAL_RETURN_URL` | No, set it in production | `/` | Where the browser goes after an install, and the `portalUrl` the Sources API returns. Unset or relative, the redirect stays on this origin and `portalUrl` is left out of the reply (Recharge Hub requires an absolute URL, so a relative one is never sent). Set it to the absolute portal page, for example `https://portal.example/integrations/shopify`. |
| `SHOPIFY_PORTAL_WELCOME_URL` | No | `<origin of SHOPIFY_PORTAL_RETURN_URL>/shopify-welcome` | The public post-install welcome page. Without both variables the redirect is the relative `/shopify-welcome`. |
| `SHOPIFY_PORTAL_PRERELEASE_RETURN_URL` | No | `SHOPIFY_PORTAL_RETURN_URL` with `/integrations/shopify` swapped for `/integrations/shopify-prerelease` | Where a store connected from the Prerelease page lands. |

### Admin API version: portal `2026-04`, Recharge Hub `2026-07`

Intentional. The two are separate Shopify installs, each pinned to the version its own queries were verified
against, and they never exchange Shopify payloads: the Sources API (`/api/v1`) is the portal's own JSON
contract, versioned independently of Shopify. Move the portal's default only as its own change, after
re-running the push paths against the newer version.
