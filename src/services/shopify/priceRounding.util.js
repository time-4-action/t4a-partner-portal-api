/**
 * Price rounding — the per-source rule every pushed price is snapped to after the factor.
 *
 * A partner selling at shelf prices wants endings, not exact conversions: "always end in 9",
 * "round up to a whole euro", "nearest 0.05". All of those are the SAME rule with different
 * numbers, so rather than a switch of named tricks this is one primitive:
 *
 *     result = (the multiple of `step` nearest to `amount - offset`, per `mode`) + offset
 *
 * with `offset` the ending to land on, always inside `[0, step)`. So:
 *   - end in 9            → { mode:'up',      step:10,   offset:9    }   2031.99 → 2039
 *   - end in .99          → { mode:'up',      step:1,    offset:0.99 }   2039.80 → 2039.99
 *   - nearest 5           → { mode:'nearest', step:5,    offset:0    }
 *   - up to a whole euro  → { mode:'up',      step:1,    offset:0    }
 *
 * `alwaysAdvance` covers the partner who wants a price that ALREADY ends in 9 pushed up to the
 * next one anyway (2039.00 → 2049). It is off by default: it raises prices nobody asked to raise,
 * and because the SOURCE price is what gets rounded (never the live Shopify price) a partner who
 * later edits the source to 2039 gets 2049 again — a ratchet across edits, not within a sync.
 *
 * INVARIANT: a rule never moves a price by more than one `step`, and `step` is capped at
 * {@link PRICE_ROUNDING_STEP_MAX}. That, plus the never-returns-zero guard in
 * {@link applyPriceRounding}, is the whole safety story — a silly-but-valid rule is off by at most
 * 1000, and the partner sees exactly that in the portal's worked example before saving.
 *
 * Lives beside `priceFactor.util` for the same reason: the sync engine applies it and the
 * connection service sanitizes it on write.
 */

/** The rounding directions. Anything else disables the rule rather than picking one. */
const ROUNDING_MODES = ['up', 'down', 'nearest'];

/**
 * Largest accepted `step` — a sanity rail, not a business rule. It IS the blast radius: a valid
 * rule can never shift a price further than this, so it doubles as the guarantee above.
 */
const PRICE_ROUNDING_STEP_MAX = 1000;

/** Smallest accepted `step` — one cent, the finest grid Shopify can store. */
const PRICE_ROUNDING_STEP_MIN = 0.01;

/** Off, carrying the numbers a partner is most likely to want when they switch it on. */
const DEFAULT_PRICE_ROUNDING = Object.freeze({
    enabled: false,
    mode: 'up',
    step: 10,
    offset: 9,
    alwaysAdvance: false
});

/**
 * Money as an exact integer number of cents.
 *
 * Everything below is integer arithmetic on this value — there is no `x / step` anywhere — because
 * the amount arriving from the engine is `price × factor` and can land as 2039.0000000000002. One
 * float division on that spuriously jumps a whole step. Re-reading at 12 significant digits first
 * drops the representation error, exactly as `toMoneyString` does.
 */
function cents(x) {
    return Math.round(Number((x * 100).toPrecision(12)));
}

/** Parses a stored/submitted number, tolerating the locale-style comma decimal partners type. */
function toNumber(raw) {
    if (raw === null || raw === undefined || raw === '') return NaN;
    return typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw);
}

/**
 * Coerces any stored/submitted rule into a complete, usable one.
 *
 * Always returns a FULLY POPULATED object with the keys in a FIXED ORDER. Both matter:
 * `resolveScopeConfig` falls back whole-value (a scope's rule never merges with the connection's),
 * so a half-filled object would push with someone else's numbers; and the portal's unsaved-changes
 * check is a `JSON.stringify` comparison, which a shuffled key order breaks.
 *
 * A rule that does not make sense is DISABLED rather than repaired. Silently defaulting a missing
 * direction to `up`, or clamping a fat-fingered step of 100000 down to 1000 and then applying it,
 * would re-price a whole catalogue in a way nobody chose — leaving prices untouched is the only
 * safe reading of a broken rule.
 *
 * @param {object|null|undefined} raw
 * @returns {{enabled:boolean, mode:string, step:number, offset:number, alwaysAdvance:boolean}}
 */
function normalizePriceRounding(raw) {
    const off = { ...DEFAULT_PRICE_ROUNDING };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return off;
    if (raw.enabled !== true) {
        // Keep whatever numbers the partner had configured, so flipping the toggle back on
        // restores their rule instead of silently resetting it to the defaults.
        const kept = normalizePriceRounding({ ...raw, enabled: true });
        return { ...kept, enabled: false };
    }

    const mode = ROUNDING_MODES.includes(raw.mode) ? raw.mode : null;
    if (!mode) return off;

    const step = toNumber(raw.step);
    if (!Number.isFinite(step) || step < PRICE_ROUNDING_STEP_MIN || step > PRICE_ROUNDING_STEP_MAX) return off;
    const stepCents = cents(step);
    if (stepCents < 1) return off;

    // An offset at or beyond the step is not an error — it is the same rule stated the long way
    // ("end in 19" on a step of 10 IS "end in 9") — so fold it in rather than rejecting the rule.
    const rawOffset = toNumber(raw.offset);
    const offsetCents = Number.isFinite(rawOffset) && rawOffset >= 0
        ? ((cents(rawOffset) % stepCents) + stepCents) % stepCents
        : 0;

    return {
        enabled: true,
        mode,
        step: stepCents / 100,
        offset: offsetCents / 100,
        // Meaningless for 'nearest' (there is no direction to advance in). Forced off so a stored
        // rule cannot carry a flag that silently starts mattering when the mode is changed later.
        alwaysAdvance: mode === 'nearest' ? false : raw.alwaysAdvance === true
    };
}

/**
 * Snaps an amount to the rule's grid. Returns a NUMBER — `toMoneyString` stays the single
 * authority on how a price becomes the 2-dp string Shopify wants.
 *
 * Identity for a disabled rule and for anything it cannot safely improve, so the caller applies it
 * unconditionally with no branch of its own.
 *
 * @param {number} amount
 * @param {object} rule normalized here, so a raw stored rule is fine
 * @returns {number}
 */
function applyPriceRounding(amount, rule) {
    if (!Number.isFinite(amount) || amount <= 0) return amount;
    const r = normalizePriceRounding(rule);
    if (!r.enabled) return amount;

    const s = cents(r.step);
    const o = cents(r.offset);
    const d = cents(amount) - o;
    // `d` goes negative for a cheap price under a coarse rule (5.00 against "end in 99"), so take
    // the modulo the long way — JS `%` keeps the sign of the dividend.
    const rem = ((d % s) + s) % s;
    const base = d - rem;

    let out;
    if (r.mode === 'up') out = r.alwaysAdvance ? base + s : (rem === 0 ? base : base + s);
    else if (r.mode === 'down') out = r.alwaysAdvance && rem === 0 ? base - s : base;
    else out = rem * 2 >= s ? base + s : base; // nearest, half-up

    const result = (out + o) / 100;
    // A `down` rule can take a cheap price to zero or below. A price of 0 published to a live store
    // is far worse than an unrounded one, so leave the amount alone instead.
    return Number.isFinite(result) && result > 0 ? result : amount;
}

/**
 * One-line human summary of a rule, for the portal's source list and the sync logs —
 * e.g. "rounds up to …9", "rounds to nearest 0.05", "off".
 */
function describePriceRounding(rule) {
    const r = normalizePriceRounding(rule);
    if (!r.enabled) return 'off';
    // "0.99" reads better as "….99"; a whole-number ending as "…9".
    const ending = r.offset > 0 ? `…${String(r.offset).replace(/^0/, '')}` : null;
    if (r.mode === 'nearest') return `rounds to nearest ${r.step}${ending ? ` (${ending})` : ''}`;
    const dir = r.mode === 'up' ? 'up' : 'down';
    const always = r.alwaysAdvance ? ', always' : '';
    return ending
        ? `rounds ${dir} to ${ending}${always}`
        : `rounds ${dir} to ${r.step === 1 ? 'whole' : r.step}${always}`;
}

module.exports = {
    ROUNDING_MODES,
    PRICE_ROUNDING_STEP_MAX,
    PRICE_ROUNDING_STEP_MIN,
    DEFAULT_PRICE_ROUNDING,
    normalizePriceRounding,
    applyPriceRounding,
    describePriceRounding
};
