const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020'); // the schema is JSON Schema Draft 2020-12
const addFormats = require('ajv-formats');

/**
 * Feed validator — "validate, never parse" (design §5).
 *
 * A feed is strictly-formatted JSON validated against a published JSON Schema. Valid → ingested;
 * a SINGLE violation rejects the WHOLE import with a precise, copy-pasteable error report and the
 * catalogue is left untouched. The portal does no column-mapping, guessing, or normalization.
 *
 * Two stages, both reported the same way:
 *   1. JSON parse — malformed JSON → one `INVALID_JSON` issue.
 *   2. Schema validate (Ajv, `allErrors`, `additionalProperties:false` everywhere — the contract
 *      is closed) + beyond-schema invariants (unique ids, https images, staleness, currency).
 *
 * Output is `{ ok, normalized?, counts, issues, warnings }`. `issues[]` is what the "Test feed"
 * UI renders verbatim — each carries a JSON Pointer `path`, a `message`, and the offending `value`.
 */

const SUPPORTED_VERSIONS = ['1.0'];
const SCHEMA_PATH = path.join(__dirname, 'schema', 'own-source.v1.json');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
const validateSchema = ajv.compile(schema);

/** One issue in the report. `value` is omitted when there's nothing useful to show. */
function issue(path, message, value) {
    const out = { path: path || '/', message };
    if (value !== undefined) out.value = value;
    return out;
}

/**
 * Converts an Ajv error into a report issue. Ajv's `instancePath` is already a JSON Pointer
 * (`/products/3/variants/0/price/amount`); for an unexpected property we append its name so the
 * pointer points at the offending key, not its parent.
 */
function ajvErrorToIssue(err) {
    let pointer = err.instancePath || '/';
    let message = err.message || 'is invalid';
    if (err.keyword === 'additionalProperties') {
        const extra = err.params.additionalProperty;
        pointer = `${pointer}/${extra}`;
        message = `unexpected property "${extra}" — the feed contract is closed (remove it)`;
    } else if (err.keyword === 'required') {
        pointer = `${pointer}/${err.params.missingProperty}`;
        message = `missing required property "${err.params.missingProperty}"`;
    } else if (err.keyword === 'enum') {
        message = `${message} (${(err.params.allowedValues || []).map((v) => JSON.stringify(v)).join(', ')})`;
    }
    return issue(pointer, message, err.data);
}

/**
 * Validates a feed.
 *
 * @param {string|Object} input - the raw feed body (string) OR an already-parsed object.
 * @param {Object} [opts]
 * @param {string} [opts.connectionCurrency] - if set, a currency mismatch is reported as a WARNING.
 * @param {number} [opts.maxStalenessHours] - reject feeds whose `generatedAt` is older than this.
 * @param {number} [opts.nowMs] - injectable clock for tests (defaults to Date.now()).
 * @returns {{ ok:boolean, normalized?:Object, counts:{products:number,variants:number}, issues:Array, warnings:Array }}
 */
function validateFeed(input, opts = {}) {
    const nowMs = opts.nowMs ?? Date.now();
    const issues = [];
    const warnings = [];
    const empty = { products: 0, variants: 0 };

    // ── Stage 1: parse ────────────────────────────────────────────────────────
    let feed = input;
    if (typeof input === 'string') {
        try {
            feed = JSON.parse(input);
        } catch (e) {
            return { ok: false, counts: empty, warnings, issues: [issue('/', `INVALID_JSON: ${e.message}`)] };
        }
    }
    if (feed === null || typeof feed !== 'object' || Array.isArray(feed)) {
        return { ok: false, counts: empty, warnings, issues: [issue('/', 'feed must be a JSON object')] };
    }

    // ── Stage 2a: schema ──────────────────────────────────────────────────────
    if (!validateSchema(feed)) {
        for (const err of validateSchema.errors || []) issues.push(ajvErrorToIssue(err));
        // Schema failed — don't run cross-field invariants on a shape we can't trust.
        return { ok: false, counts: empty, warnings, issues };
    }

    // ── Stage 2b: beyond-schema invariants ─────────────────────────────────────
    if (!SUPPORTED_VERSIONS.includes(feed.schemaVersion)) {
        issues.push(issue('/schemaVersion', `unsupported schemaVersion — portal supports ${SUPPORTED_VERSIONS.join(', ')}`, feed.schemaVersion));
    }

    // Staleness (and an absurd-future guard) on generatedAt.
    const genMs = new Date(feed.generatedAt).getTime();
    if (Number.isNaN(genMs)) {
        issues.push(issue('/generatedAt', 'not a parseable ISO-8601 timestamp', feed.generatedAt));
    } else {
        if (opts.maxStalenessHours != null && nowMs - genMs > opts.maxStalenessHours * 3600 * 1000) {
            const ageH = Math.round((nowMs - genMs) / 3600000);
            issues.push(issue('/generatedAt', `feed is stale — generated ${ageH}h ago, max allowed ${opts.maxStalenessHours}h`, feed.generatedAt));
        }
        if (genMs - nowMs > 24 * 3600 * 1000) {
            issues.push(issue('/generatedAt', 'generatedAt is more than 24h in the future', feed.generatedAt));
        }
    }

    // Currency mismatch is a WARNING, not a hard error (design E6).
    if (opts.connectionCurrency && feed.currency !== opts.connectionCurrency) {
        warnings.push(issue('/currency', `feed currency ${feed.currency} differs from store currency ${opts.connectionCurrency}`, feed.currency));
    }

    // Global uniqueness of externalId + sku, and https-only images. One pass over the catalogue.
    const seenExternalIds = new Map(); // value -> first index
    const seenSkus = new Map();
    let variantCount = 0;

    const products = feed.products || [];
    products.forEach((p, pi) => {
        if (seenExternalIds.has(p.externalId)) {
            issues.push(issue(`/products/${pi}/externalId`, `duplicate externalId (first seen at /products/${seenExternalIds.get(p.externalId)})`, p.externalId));
        } else {
            seenExternalIds.set(p.externalId, pi);
        }

        (p.images || []).forEach((img, ii) => {
            if (!/^https:\/\//i.test(img.src)) {
                issues.push(issue(`/products/${pi}/images/${ii}/src`, 'image src must be an https:// URL (Shopify cannot fetch http/data URLs)', img.src));
            }
        });

        (p.variants || []).forEach((v, vi) => {
            variantCount++;
            if (seenSkus.has(v.sku)) {
                issues.push(issue(`/products/${pi}/variants/${vi}/sku`, `duplicate SKU (first seen at /products/${seenSkus.get(v.sku)})`, v.sku));
            } else {
                seenSkus.set(v.sku, `${pi}/variants/${vi}`);
            }
            if (v.image && !/^https:\/\//i.test(v.image)) {
                issues.push(issue(`/products/${pi}/variants/${vi}/image`, 'variant image must be an https:// URL', v.image));
            }
        });
    });

    const counts = { products: products.length, variants: variantCount };
    if (issues.length) return { ok: false, counts, warnings, issues };
    return { ok: true, normalized: feed, counts, warnings, issues: [] };
}

module.exports = {
    validateFeed,
    SUPPORTED_VERSIONS,
    SCHEMA_PATH
};
