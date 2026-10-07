# Sources API — AI autofill (`/api/v1/ai/*`)

Two endpoints that let the client of the Sources API (Recharge Hub) use the
portal's AI on **its own** catalogue model: sort a product into one of the
client's categories, and read the values of the client's attributes from a
product's data. The client's side of the same contract is Recharge Hub's
`docs/sources.md` § AI autofill; where the two disagree about the wire
format, `scripts/sources-api-ai-smoke.js` here is right.

## What it is on this side

- `src/services/ai/productAutofill.service.js` — both endpoints, the
  supplier-data lookup, and the request checks.
- `src/controllers/sourcesApiController.js` (`categorize`,
  `extractAttributes`) and `src/routes/sourcesApiRoutes.js` — mounted behind
  `sourcesApiAuth` like every `/api/v1` route: bearer key, `X-Shop-Domain`
  bound to the key's connection, 409 while the connection is not active.
- Model: Claude Haiku (`claude-haiku-4-5`), structured outputs, the same as
  `categoryIdentification.service.js`. `ANTHROPIC_API_KEY` as everywhere;
  without it both endpoints answer 503 `ai_unavailable` (the service does
  not throw at load).
- **Stateless.** Nothing about a request is stored and nothing is written to
  the store. Token usage goes to `aiAnalytics` as operation
  `sources-api:<connectionId>`.

How it relates to the category sets: `categoryIdentification` categorizes
the portal's own catalogue against a stored category set and persists the
result on the product; `/ai/categorize` categorizes the **client's**
products against the categories the **client** sends and persists nothing.
Same model and the same kind of prompt, with two differences the client
needs: "none fits" is an allowed answer (no forced "Ostalo"), and each
answer carries a confidence and a reason, because a person reviews it.

## Endpoints

```text
POST /api/v1/ai/categorize
  { products: AiProduct[] (1–50), categories: [{ id, label }] (1–2000) }
  → 200 { results: [{ code, categoryId: string|null, confidence: number|null, reason: string|null }] }

POST /api/v1/ai/extract-attributes
  { product: AiProduct, attributes: Attribute[] (1–200) }
  → 200 { values: [{ attributeId, variantId: string|null, value: string | string[] }] }

AiProduct  { code, name, shopifyProductId?, vendor?, productType?, category?, tags?,
             description?, options?, variants?: [{ id, title, sku?, options?: [{ name, value }] }] }
Attribute  { id, name, description?, format, unit?, options?: [{ code, label }], level: product|variant }
           format ∈ text | integer | decimal | boolean | date | choice | choices | measurement
```

**categorize** answers one result per product sent, in the order sent, keyed
by `code`. A `categoryId` the client did not send is turned into `null`, as
is a product the model skipped; `confidence` (0–1) is null with it.

**extract-attributes** answers only what the model could tell; an attribute
it could not is absent. Before answering, the service drops: an unknown
attribute, a `choice` value that is not one of its codes, `choices` codes
that are not offered (and the entry if none is left), a variant id the
product does not have, a product-level value given per variant or the
reverse, an empty value, and a second answer for the same attribute and
variant. The model is told to state only what the data settles, never a
typical value.

**Supplier data.** When `shopifyProductId` names a product this portal
created in the connection's store (`shopify_product_map`, by connection and
Shopify product id, indexed on first use), the prompt also gets the
supplier's own facts: name, categories, tags, description (1,500
characters) and the portal's own category labels. A feed row is looked up
among the connection's own feeds first, so two feeds that reuse a code
cannot lend each other facts; the catalogue is the fallback. The Shopify id
itself is never sent to the model.

## Refusals

The Sources API's shape, `{ error: { code, message }, errors? }`:

| Status | Code             | When                                                                 |
| ------ | ---------------- | -------------------------------------------------------------------- |
| 401/403/409 | as every `/api/v1` route | key, shop binding, connection not active                  |
| 422    | `invalid`        | malformed body; `errors[0].field` names the part (`products[2]`)     |
| 502    | `ai_failed`      | the model failed, declined, or its answer was cut short or unreadable |
| 503    | `ai_unavailable` | `ANTHROPIC_API_KEY` is not set                                       |

The 502/503 messages are written for a merchant; the client shows them
as they are.

## Limits

- Request bodies are capped by the app's JSON parser at 100 kB. The client
  sends ten products per categorize call, descriptions clipped, and one
  product per extraction.
- Output tokens are sized to the request (about 160 per product, 60 per
  attribute and variant, at most 8,192); a request that would need more is
  answered 502 rather than with a partial list.
- No cost in money is computed here, as for the rest of `aiAnalytics`.

## Smoke test

```bash
MONGO_URI=mongodb://localhost:27099 MONGO_DB_NAME=sources_ai_smoke node scripts/sources-api-ai-smoke.js
```

Boots the app in-process against a throwaway MongoDB with a fake model, and
checks the key and shop binding, the request checks, that the supplier data
of the store's own feed (and not another feed's) reaches the prompt, that
the Shopify id does not, the usage log, and every answer the client must
never receive.
