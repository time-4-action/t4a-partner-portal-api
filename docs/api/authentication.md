# Authentication & Authorization

The API is served from **`https://api.time-4-action.com`**. Different route groups
use different auth strategies. This page is the single reference for all of them.

---

## Strategies at a glance

| Strategy | Header | Used by | Middleware |
|----------|--------|---------|------------|
| **Public** | — | Health check, static assets | none |
| **JWT (Auth0)** | `Authorization: Bearer <token>` | Dashboard / partner-facing CRUD | `auth0` + `requireExportRole` |
| **Dual Auth** | `Authorization: Bearer <token>` **or** `X-Api-Key: <key>` | Export downloads (CSV/JSON/XML) | `dualAuth` |
| **Export API Key** | `X-Api-Key: <key>` (or `{ "api_key": "<key>" }` in body) | Programmatic export downloads | `dualAuth` |
| **Webhook Key** | `x-api-key: <WEBHOOK_API_KEY>` | Webhooks, external catalogue read | `webhookApiKey` / `detectApiKey` |
| **Internal Admin** | `Authorization: Bearer <PARTNER_ADMIN_TOKEN>` | `/api/admin/*` (t4a-admin only) | `internalAdminToken` |
| **Shopify HMAC** | Shopify-signed query / body | Shopify OAuth + webhooks | verified in controller |

---

## JWT (Auth0)

Partner-facing endpoints authenticate with an Auth0-issued access token.

```
Authorization: Bearer <access_token>
```

- **Audience:** `https://api.time-4-action.com` (`AUTH0_AUDIENCE`)
- **Issuer:** `https://time-4-action.eu.auth0.com/` (`AUTH0_ISSUER_BASE_URL`)
- **Signing algorithm:** RS256

### The `export` role

Most partner endpoints additionally require the **`export`** role. It is injected
into the access token by an Auth0 Post-Login Action under the claim:

```
https://time-4-action.com/roles
```

Requests from a valid token **without** the `export` role get `403 { "message": "Export role required" }`.

### Early-access tiers

Some features (currently the legacy "Shopify Deprecated" connect flow) require an
additional **tier role** — `alpha` or `beta` — from the same roles claim. A missing
tier returns:

```json
{ "message": "This feature is in beta testing — the 'beta' role is required.", "code": "TIER_REQUIRED", "tier": "beta" }
```

---

## Export API Keys

Export API keys are scoped to a **single export configuration**. They let a
machine download that export's data without an interactive Auth0 login. Keys are
created and revoked by the export **owner** — see
[API Keys & Access](api-keys-and-access.md).

Present the key with either:

```
X-Api-Key: <key>
```

or, in a JSON body, `{ "api_key": "<key>" }`. The header takes priority; query
params are **not** accepted.

Under **Dual Auth**, the middleware tries JWT first (if an `Authorization: Bearer`
header is present) and otherwise falls back to the API key. A valid key implicitly
satisfies the `export` role check (the key was minted by a role-bearing user), and
grants access only to its own export (`req.authContext.exportId`).

---

## Webhook Key

A single static secret (`WEBHOOK_API_KEY`) protects the automation surface:

```
x-api-key: <WEBHOOK_API_KEY>
```

Two middlewares consume it:

- **`webhookApiKey`** — a hard gate. A missing/incorrect key returns
  `401 { "message": "Unauthorized: invalid or missing x-api-key header." }`.
  Used by all [Webhooks](webhooks.md) and the
  [AI Categorization](ai-categorization.md) endpoint.
- **`detectApiKey`** — non-blocking. It never rejects; it only sets
  `req.hasFullAccess = true` when the key matches, which widens the
  [Products](products.md) read endpoints to the full (unpublished/inactive)
  catalogue. Anonymous callers keep the published-only view.

> Both read the same `WEBHOOK_API_KEY`, so any holder of that key can also read the
> full catalogue through the product endpoints.

---

## Internal Admin Token

The `/api/admin/*` surface is consumed **server-side** by the internal *t4a-admin*
app and is guarded by a shared bearer token (`PARTNER_ADMIN_TOKEN`) that never
reaches a browser:

```
Authorization: Bearer <PARTNER_ADMIN_TOKEN>
```

A missing/incorrect token returns `401`; an unset server var returns `500`.

---

## Access model for exports

For a specific export configuration (`/api/export/custom-export/:id/*`), access is
layered by `requireExportAccess` and `requireOwner`:

| Caller | Access |
|--------|--------|
| **API key** | Only if the key's `exportId` equals `:id` |
| **JWT owner** | `config.owner.sub === token.sub` |
| **JWT grantee** | `sub` or `email` present in `config.accessList` |
| **Legacy docs** | Configs with `owner.sub === null` are open to all `export`-role users (migration compatibility) |

`requireOwner` narrows the above to the owner only (used for destructive and
management operations: update, delete, key management, access management).

Failures: `400` invalid ObjectId · `404` export not found/inactive · `403` not authorized.

---

## Error shapes

Auth errors are terse JSON:

```json
{ "message": "Unauthorized" }
```

Endpoints in the [Custom Exports](custom-exports.md) tree use a richer error
envelope with a `code` field — see that page.
