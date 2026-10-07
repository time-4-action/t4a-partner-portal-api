const Anthropic = require('@anthropic-ai/sdk');
const { ObjectId } = require('mongodb');

const { getDb } = require('../db/mongo.service');
const { logAiUsage } = require('./analytics.service');
const { SourcesApiError } = require('../shopify/sourcesApi.service');

/**
 * AI autofill for a client's own catalogue model (`docs/sources-api-ai.md`): the Sources API's
 * two AI endpoints.
 *
 * - **categorize** — the same job as `categoryIdentification.service` (one category per
 *   product, Claude Haiku, structured output), but against a category list the CALLER sends
 *   (Recharge Hub's product type tree) rather than a category set stored here, with "none fits"
 *   allowed, and a confidence and reason per product so a person reviewing it knows how much
 *   to trust it.
 * - **extractAttributes** — values for a list of attributes the caller describes (format, unit,
 *   allowed options, product or variant level), read from the product's data.
 *
 * Both are stateless: nothing is stored about the request, only the token usage
 * (`aiAnalytics`, operation `sources-api:<connectionId>`). Both enrich a product the portal
 * created with what the portal knows and the store does not — the supplier's own category,
 * tags and description — by following `shopify_product_map` from the Shopify product id.
 *
 * The caller checks every answer again (an option code it did not offer, a number that is not
 * one, a variant it does not have) and holds the result for a person to review; this service's
 * own checks only keep malformed answers from leaving it.
 */

const MODEL_NAME = 'claude-haiku-4-5';
const MAP_COLLECTION = 'shopify_product_map';

/** Request limits. One categorize call covers a review page; one extraction is one product. */
const LIMITS = {
    products: 50,
    categories: 2000,
    attributes: 200,
    options: 500,
    variants: 100,
    text: 4000
};

const FORMATS = ['text', 'integer', 'decimal', 'boolean', 'date', 'choice', 'choices', 'measurement'];

let client = null;
function anthropic() {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new SourcesApiError(503, 'ai_unavailable', 'AI is not configured on the export portal.');
    }
    client = client || new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
}

/* ───────────────────────── Request checks ───────────────────────── */

const str = (value, max = LIMITS.text) => (typeof value === 'string' ? value.slice(0, max) : '');

function invalid(field, message) {
    return new SourcesApiError(422, 'invalid', message, [{ field, message }]);
}

function list(value, field, max, { min = 0 } = {}) {
    if (!Array.isArray(value)) throw invalid(field, `${field} must be a list.`);
    if (value.length < min) throw invalid(field, `${field} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}.`);
    if (value.length > max) throw invalid(field, `${field} takes at most ${max} entries.`);
    return value;
}

/** A product as the prompt sees it: only descriptive text, every field bounded. */
function productIn(raw, field) {
    if (!raw || typeof raw !== 'object') throw invalid(field, 'Each product must be an object.');
    const code = str(raw.code, 200);
    if (!code) throw invalid(field, 'Each product needs a code.');
    const name = str(raw.name, 500);
    if (!name) throw invalid(field, 'Each product needs a name.');
    const variants = Array.isArray(raw.variants) ? raw.variants.slice(0, LIMITS.variants) : [];
    return {
        code,
        name,
        shopifyProductId: str(raw.shopifyProductId, 200) || undefined,
        vendor: str(raw.vendor, 200) || undefined,
        product_type: str(raw.productType, 200) || undefined,
        category: str(raw.category, 500) || undefined,
        tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 40).map((t) => str(t, 100)).filter(Boolean) : undefined,
        description: str(raw.description) || undefined,
        options: Array.isArray(raw.options) ? raw.options.slice(0, 10).map((o) => str(o, 100)) : undefined,
        variants: variants.map((v) => ({
            id: str(v && v.id, 200),
            title: str(v && v.title, 300),
            sku: str(v && v.sku, 200) || undefined,
            options: Array.isArray(v && v.options)
                ? v.options.slice(0, 10).map((o) => ({ name: str(o && o.name, 100), value: str(o && o.value, 200) }))
                : undefined
        })).filter((v) => v.id)
    };
}

/* ───────────────────────── What the portal knows ───────────────────────── */

let mapIndexReady = null;
function ensureMapIndex(db) {
    mapIndexReady = mapIndexReady || db.collection(MAP_COLLECTION)
        .createIndex({ connectionId: 1, shopifyProductId: 1 })
        .catch((error) => {
            mapIndexReady = null;
            console.error('[sources-api-ai] map index:', error.message);
        });
    return mapIndexReady;
}

const textFromHtml = (html) => String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The supplier's own facts for products this portal created in the store, keyed by Shopify
 * product id. A product the portal does not know is simply absent: the store's data is enough
 * to work from, this only adds evidence.
 */
async function supplierFacts(connection, shopifyProductIds) {
    const ids = [...new Set(shopifyProductIds.filter(Boolean))];
    const facts = new Map();
    if (ids.length === 0) return facts;
    const db = getDb();
    await ensureMapIndex(db);

    const connectionId = connection._id instanceof ObjectId ? connection._id : new ObjectId(String(connection._id));
    const rows = await db.collection(MAP_COLLECTION)
        .find({ connectionId, shopifyProductId: { $in: ids } }, { projection: { shopifyProductId: 1, parentCode: 1 } })
        .toArray();
    const codeOf = new Map(rows.filter((r) => r.parentCode).map((r) => [r.shopifyProductId, String(r.parentCode)]));
    const codes = [...new Set(codeOf.values())];
    if (codes.length === 0) return facts;

    // A feed product is looked up among this store's own feeds first, so two feeds that reuse a
    // code cannot lend each other their facts; the catalogue is the fallback.
    const feedIds = (connection.config && Array.isArray(connection.config.scopes) ? connection.config.scopes : [])
        .filter((s) => s && s.type === 'own_source' && s.feedId)
        .map((s) => s.feedId);
    const projection = { code: 1, product_name: 1, vendor: 1, categories: 1, tags: 1, detailed_description: 1, ai_categories: 1 };
    const [feedRows, catalogueRows] = await Promise.all([
        feedIds.length
            ? db.collection('external_products').find({ feedId: { $in: feedIds }, code: { $in: codes } }, { projection }).toArray()
            : Promise.resolve([]),
        db.collection('products').find({ code: { $in: codes } }, { projection }).toArray()
    ]);
    const byCode = new Map();
    for (const row of [...catalogueRows, ...feedRows]) byCode.set(String(row.code), row);

    for (const [shopifyProductId, code] of codeOf) {
        const row = byCode.get(code);
        if (!row) continue;
        facts.set(shopifyProductId, {
            supplier_name: row.product_name || undefined,
            supplier_categories: Array.isArray(row.categories) ? row.categories.slice(0, 5) : undefined,
            supplier_tags: Array.isArray(row.tags) ? row.tags.slice(0, 20) : undefined,
            supplier_description: textFromHtml(row.detailed_description).slice(0, 1500) || undefined,
            portal_categories: Array.isArray(row.ai_categories)
                ? [...new Set(row.ai_categories.map((c) => c && c.categoryName).filter(Boolean))].slice(0, 5)
                : undefined
        });
    }
    return facts;
}

/* ───────────────────────── The model ───────────────────────── */

async function ask(connection, { system, user, schema, maxTokens }) {
    let message;
    try {
        message = await anthropic().messages.create({
            model: MODEL_NAME,
            max_tokens: maxTokens,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{ role: 'user', content: user }]
        });
    } catch (error) {
        if (error instanceof SourcesApiError) throw error;
        console.error('[sources-api-ai] model call failed:', error.message);
        throw new SourcesApiError(502, 'ai_failed', 'The AI model did not answer. Try again in a moment.');
    }

    const u = message.usage || {};
    const inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    logAiUsage(`sources-api:${connection._id}`, {
        promptTokenCount: inputTokens,
        candidatesTokenCount: u.output_tokens || 0,
        totalTokenCount: inputTokens + (u.output_tokens || 0)
    }, MODEL_NAME);

    if (message.stop_reason === 'refusal') {
        throw new SourcesApiError(502, 'ai_failed', 'The AI model declined to answer for this product.');
    }
    if (message.stop_reason === 'max_tokens') {
        throw new SourcesApiError(502, 'ai_failed', 'The AI answer was cut short. Send fewer products or attributes at a time.');
    }
    try {
        return JSON.parse(message.content.find((b) => b.type === 'text')?.text || '{}');
    } catch {
        throw new SourcesApiError(502, 'ai_failed', 'The AI answer could not be read.');
    }
}

/* ───────────────────────── Categorize ───────────────────────── */

const categorizeSchema = {
    type: 'object',
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    code: { type: 'string' },
                    categoryId: { type: 'string' },
                    confidence: { type: 'number' },
                    reason: { type: 'string' }
                },
                required: ['code', 'categoryId', 'confidence', 'reason'],
                additionalProperties: false
            }
        }
    },
    required: ['results'],
    additionalProperties: false
};

/**
 * One category per product from the caller's list, or none.
 * Body: `{ products: Product[], categories: [{ id, label }] }`.
 * Reply: `{ results: [{ code, categoryId|null, confidence|null, reason|null }] }`, one per product
 * sent, in the order sent.
 */
async function categorize(connection, body) {
    const products = list(body && body.products, 'products', LIMITS.products, { min: 1 })
        .map((p, i) => productIn(p, `products[${i}]`));
    const categories = list(body && body.categories, 'categories', LIMITS.categories, { min: 1 }).map((c, i) => {
        const id = str(c && c.id, 200);
        const label = str(c && c.label, 1000);
        if (!id || !label) throw invalid(`categories[${i}]`, 'Each category needs an id and a label.');
        return { id, label };
    });
    const valid = new Set(categories.map((c) => c.id));

    const facts = await supplierFacts(connection, products.map((p) => p.shopifyProductId));
    const forPrompt = products.map(({ shopifyProductId, ...p }) => ({ ...p, ...(facts.get(shopifyProductId) || {}) }));

    const system = `You sort products of an online store into the store's own category tree.
Each category's label is its full path from the top, levels joined with " > ".
For each product, choose the single most specific category that the product clearly belongs to, judged from its name, vendor, product type, Shopify category, tags, description, options and variants, and from the supplier's own data when present (supplier_categories, supplier_tags, supplier_description, portal_categories).
If no category fits, answer an empty string as categoryId — never force a product into a category that does not describe it.
confidence is a number from 0 to 1: how sure you are that the category is right. Use 0.9 or more only when the product's own data names the kind of product unambiguously.
reason is one short English sentence naming the evidence.
Return exactly one result per product, using the product's code.
Categories: ${JSON.stringify(categories)}`;

    const answer = await ask(connection, {
        system,
        user: `Categorize these products: ${JSON.stringify(forPrompt)}`,
        schema: categorizeSchema,
        maxTokens: Math.min(8192, 400 + products.length * 160)
    });

    const byCode = new Map();
    for (const r of Array.isArray(answer.results) ? answer.results : []) {
        if (!r || byCode.has(r.code)) continue;
        const confidence = typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
        byCode.set(r.code, {
            code: r.code,
            categoryId: valid.has(r.categoryId) ? r.categoryId : null,
            confidence: valid.has(r.categoryId) ? confidence : null,
            reason: typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 500) : null
        });
    }
    return {
        results: products.map((p) => byCode.get(p.code) || { code: p.code, categoryId: null, confidence: null, reason: null })
    };
}

/* ───────────────────────── Attributes ───────────────────────── */

const extractSchema = {
    type: 'object',
    properties: {
        values: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    attributeId: { type: 'string' },
                    variantId: { type: 'string' },
                    value: { type: 'string' },
                    choices: { type: 'array', items: { type: 'string' } }
                },
                required: ['attributeId', 'variantId', 'value', 'choices'],
                additionalProperties: false
            }
        }
    },
    required: ['values'],
    additionalProperties: false
};

function attributeIn(raw, field) {
    if (!raw || typeof raw !== 'object') throw invalid(field, 'Each attribute must be an object.');
    const id = str(raw.id, 200);
    const name = str(raw.name, 300);
    if (!id || !name) throw invalid(field, 'Each attribute needs an id and a name.');
    if (!FORMATS.includes(raw.format)) throw invalid(field, `format must be one of ${FORMATS.join(', ')}.`);
    const options = Array.isArray(raw.options)
        ? list(raw.options, `${field}.options`, LIMITS.options).map((o) => ({ code: str(o && o.code, 200), label: str(o && o.label, 300) })).filter((o) => o.code)
        : [];
    if ((raw.format === 'choice' || raw.format === 'choices') && options.length === 0) {
        throw invalid(field, 'A choice attribute needs its options.');
    }
    return {
        id,
        name,
        description: str(raw.description, 1000) || undefined,
        format: raw.format,
        unit: str(raw.unit, 50) || undefined,
        options: options.length ? options : undefined,
        level: raw.level === 'variant' ? 'variant' : 'product'
    };
}

/**
 * Values for the caller's attributes, read from one product's data.
 * Body: `{ product: Product, attributes: Attribute[] }`.
 * Reply: `{ values: [{ attributeId, variantId|null, value: string|string[] }] }` — only what the
 * model could determine; an attribute it could not is absent, never guessed.
 */
async function extractAttributes(connection, body) {
    const product = productIn(body && body.product, 'product');
    const attributes = list(body && body.attributes, 'attributes', LIMITS.attributes, { min: 1 })
        .map((a, i) => attributeIn(a, `attributes[${i}]`));
    const byId = new Map(attributes.map((a) => [a.id, a]));
    const variantIds = new Set(product.variants.map((v) => v.id));

    const facts = await supplierFacts(connection, [product.shopifyProductId]);
    const { shopifyProductId, ...rest } = product;
    const forPrompt = { ...rest, ...(facts.get(shopifyProductId) || {}) };

    const system = `You fill in product attributes for an online store's catalogue.
You are given one product (its own data, and the supplier's data when present) and a list of attributes to fill.
Rules:
- Only state what the product's data says or what follows directly from it (a size in the title, a material in the description, a volume in a variant name). If the data does not settle an attribute, leave it out. Never guess, never fill an attribute with a typical value.
- format "choice": value is exactly one of the attribute's option codes; choices is []. format "choices": choices lists option codes that apply; value is "". Never invent a code.
- format "integer" / "decimal" / "measurement": value is the number only, digits and a dot, already in the attribute's unit (convert if the data uses another unit). No unit, no range.
- format "boolean": value is "true" or "false". format "date": YYYY-MM-DD. format "text": the value as the store would print it, short, in the language of the product's data.
- level "product": one entry with variantId "". level "variant": one entry per variant whose value you can tell (usually from the variant's title or options), with that variant's id.
Attributes: ${JSON.stringify(attributes)}`;

    const answer = await ask(connection, {
        system,
        user: `Product: ${JSON.stringify(forPrompt)}`,
        schema: extractSchema,
        maxTokens: Math.min(8192, 600 + attributes.length * 60 * Math.max(1, Math.min(product.variants.length, 20)))
    });

    const seen = new Set();
    const values = [];
    for (const v of Array.isArray(answer.values) ? answer.values : []) {
        const attribute = v && byId.get(v.attributeId);
        if (!attribute) continue;
        const variantId = attribute.level === 'variant' ? (variantIds.has(v.variantId) ? v.variantId : null) : null;
        if (attribute.level === 'variant' && !variantId) continue;
        const key = `${attribute.id}@${variantId || ''}`;
        if (seen.has(key)) continue;

        let value;
        if (attribute.format === 'choices') {
            const codes = new Set((attribute.options || []).map((o) => o.code));
            value = [...new Set((Array.isArray(v.choices) ? v.choices : []).filter((c) => codes.has(c)))];
            if (value.length === 0) continue;
        } else {
            value = typeof v.value === 'string' ? v.value.trim() : '';
            if (!value) continue;
            if (attribute.format === 'choice' && !(attribute.options || []).some((o) => o.code === value)) continue;
        }
        seen.add(key);
        values.push({ attributeId: attribute.id, variantId, value });
    }
    return { values };
}

/** Smoke tests stand a fake in for the model; nothing else may call this. */
function setClientForTests(fake) {
    client = fake;
}

module.exports = { categorize, extractAttributes, supplierFacts, LIMITS, setClientForTests };
