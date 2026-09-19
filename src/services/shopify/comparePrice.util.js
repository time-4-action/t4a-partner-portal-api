/**
 * Compare-at price + existing-sale policy — the per-source settings that decide WHICH of a
 * variant's two Shopify price fields (`price`, `compareAtPrice`) the portal owns, and what to do
 * when the store already shows a sale the portal did not put there.
 *
 * Shopify's `compareAtPrice` is cosmetic: the storefront strikes it through next to `price` when
 * it is HIGHER, and the customer still pays `price`. Cart-level automatic discounts are a separate
 * mechanism that stacks on top — this module does not know about them (see progress doc §9).
 *
 * Three settings, all per scope with connection-level fallback:
 *
 *   - `compareAtPricelist`  name of the pricelist whose price becomes `compareAtPrice`, or null.
 *                           Null is the feature OFF — the push payload is exactly what it was
 *                           before this setting existed, `compareAtPrice` is never sent.
 *   - `priceFields`         which fields the portal maintains when the feature is on.
 *   - `existingSalePolicy`  per-variant override applied when the LIVE variant carries a
 *                           compare-at the portal did not set (a merchant-made sale).
 *
 * Lives beside `priceFactor.util` / `priceRounding.util` for the same reason: the sync engine
 * applies these and the connection service sanitizes them on write.
 */

/** Which of the two Shopify price fields a source pushes. Only meaningful with a compare-at list. */
const PRICE_FIELDS = ['price_and_compare_at', 'price_only', 'compare_at_only'];

/** What to do with a variant the merchant has put on sale in Shopify themselves. */
const EXISTING_SALE_POLICIES = ['overwrite', 'leave', 'price_only', 'compare_at_only'];

const DEFAULT_PRICE_FIELDS = 'price_and_compare_at';
const DEFAULT_EXISTING_SALE_POLICY = 'overwrite';

/** A pricelist name, trimmed; anything empty or non-string is "off". */
function normalizeCompareAtPricelist(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    return s ? s : null;
}

/** Unknown value → the default (push both), never a guess at what the partner meant. */
function normalizePriceFields(raw) {
    return PRICE_FIELDS.includes(raw) ? raw : DEFAULT_PRICE_FIELDS;
}

/** Unknown value → `overwrite`, which is exactly what every existing connection does today. */
function normalizeExistingSalePolicy(raw) {
    return EXISTING_SALE_POLICIES.includes(raw) ? raw : DEFAULT_EXISTING_SALE_POLICY;
}

/**
 * The fields a source wants to push, before any per-variant policy. `wantC` is false whenever the
 * compare-at feature is off, whatever `priceFields` says — the stored selector is kept so choosing
 * a list later restores it, but without a list there is nothing to send.
 *
 * @param {{compareAtPricelist:string|null, priceFields:string}} priceOpts
 * @returns {{wantP:boolean, wantC:boolean}}
 */
function wantedFields(priceOpts) {
    const list = normalizeCompareAtPricelist(priceOpts?.compareAtPricelist);
    const fields = normalizePriceFields(priceOpts?.priceFields);
    return {
        wantP: fields !== 'compare_at_only',
        wantC: !!list && fields !== 'price_only'
    };
}

/**
 * Applies the existing-sale policy to one variant. Passthrough when the variant is not on a
 * merchant-made sale; otherwise narrows (or drops) the fields to push. `skipped` is true when
 * nothing is left to push — the caller counts it and moves on without touching the variant.
 *
 * @param {{wantP:boolean, wantC:boolean}} wanted from {@link wantedFields}
 * @param {string} policy
 * @param {boolean} hasSale live variant carries a compare-at the portal did not set
 * @returns {{wantP:boolean, wantC:boolean, skipped:boolean}}
 */
function applySalePolicy(wanted, policy, hasSale) {
    let { wantP, wantC } = wanted;
    if (hasSale) {
        const p = normalizeExistingSalePolicy(policy);
        if (p === 'leave') { wantP = false; wantC = false; }
        else if (p === 'price_only') wantC = false;
        else if (p === 'compare_at_only') wantP = false;
    }
    return { wantP, wantC, skipped: !wantP && !wantC };
}

/**
 * Stable key for what was pushed, used by the source-hash fallback gate when the live fetch fails.
 * Distinguishes "compare-at not managed" (`undefined`) from "managed and cleared" (`null`) — the
 * two produce different payloads, so they must produce different hashes.
 *
 * @param {{price?:string, compareAt?:string|null}} pushed
 * @returns {string} JSON to feed the caller's hash function
 */
function priceHashInput(pushed) {
    return JSON.stringify([
        pushed.price ?? '-',
        pushed.compareAt === undefined ? '-' : (pushed.compareAt ?? 'null')
    ]);
}

module.exports = {
    PRICE_FIELDS,
    EXISTING_SALE_POLICIES,
    DEFAULT_PRICE_FIELDS,
    DEFAULT_EXISTING_SALE_POLICY,
    normalizeCompareAtPricelist,
    normalizePriceFields,
    normalizeExistingSalePolicy,
    wantedFields,
    applySalePolicy,
    priceHashInput
};
