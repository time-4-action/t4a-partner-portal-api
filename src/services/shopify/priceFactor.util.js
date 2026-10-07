/**
 * Price factor — the per-source multiplier applied to every price the Shopify push sends.
 *
 * A partner selling the catalogue in another currency (or at a fixed uplift) sets a factor such
 * as `11.4` and every resolved price is multiplied by it. Exchange rates need real precision, so
 * the factor keeps up to {@link PRICE_FACTOR_DECIMALS} decimals — the ROUNDING to 2 dp happens
 * once, on the final amount, never on the factor.
 *
 * Lives in its own module because BOTH the sync engine (applies it) and the connection service
 * (sanitizes it on write) need it, and those two already depend on each other.
 */

/** Decimals kept on the factor itself — enough for an exchange rate (e.g. 11.456789). */
const PRICE_FACTOR_DECIMALS = 6;

/** Upper bound — a sanity rail, not a business rule; guards a fat-fingered 1e12. */
const PRICE_FACTOR_MAX = 1_000_000;

/**
 * Coerces any stored/submitted factor to a usable positive multiplier. Anything missing, junk,
 * zero or negative falls back to `1` (= no change), so a connection that has never seen this
 * setting — every connection that exists today — behaves exactly as before.
 *
 * Accepts a comma decimal separator ("11,4") since the portal's partners type locale-style.
 *
 * @param {number|string|null|undefined} raw
 * @returns {number} a positive multiplier, at most PRICE_FACTOR_DECIMALS decimals
 */
function normalizePriceFactor(raw) {
    if (raw === null || raw === undefined || raw === '') return 1;
    const n = typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 1;
    const p = 10 ** PRICE_FACTOR_DECIMALS;
    return Math.round(Math.min(n, PRICE_FACTOR_MAX) * p) / p;
}

/**
 * Formats a computed amount as the 2-dp string Shopify expects.
 *
 * `toFixed(2)` alone mis-rounds binary-float halves (1.005 is stored as 1.00499… → "1.00"), which
 * a multiplier makes far more likely to hit. Re-reading the cent value at 12 significant digits
 * first drops that representation error, so a genuine half rounds up.
 *
 * @param {number} amount
 * @returns {string} e.g. "140.68"
 */
function toMoneyString(amount) {
    if (!Number.isFinite(amount) || amount < 0) return '0.00';
    const cents = Math.round(Number((amount * 100).toPrecision(12)));
    return (cents / 100).toFixed(2);
}

module.exports = { PRICE_FACTOR_DECIMALS, PRICE_FACTOR_MAX, normalizePriceFactor, toMoneyString };
