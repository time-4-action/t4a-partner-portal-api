/**
 * The title prefix as a pattern: `{vendor} -`, `{category|upper} -`, `[{vendor} · ]`.
 *
 * The syntax is Recharge Hub's name-pattern syntax (its `domain/products/template`), ported
 * here so a prefix built with the Hub's chips means the same thing when the portal pushes it:
 *
 *   pattern := (literal | group | token)*
 *   group   := "[" (literal | token)* "]"      — vanishes when every token in it is empty
 *   token   := "{" field ("|" filter)* "}"
 *   filter  := name (":" arg)*                   — an arg may be "quoted" to hold a colon
 *
 * A backslash escapes a literal brace, bracket or backslash. Filters are the Hub's set, with the
 * Hub's rule: none turns an empty value into a non-empty one except `default`, and
 * `prefix`/`suffix` only apply to a value that is there — so a separator can belong to its token.
 *
 * What differs from the Hub is only what a prefix needs: a trailing separator is the point of a
 * prefix ("Unifiber -"), so it is kept; and a pattern whose tokens all came out empty is no
 * prefix at all, rather than a stray "-".
 *
 * Parsing never throws. `lintTitlePattern` reports what is wrong for the save path (a 422 naming
 * the field); the sync path renders whatever is stored and an unknown field renders empty.
 */

/** Per-product fields a prefix can use. `brand` is kept as an alias of `vendor`. */
const TITLE_FIELDS = [
    { key: 'vendor', label: 'Vendor' },
    { key: 'product_type', label: 'Product type' },
    { key: 'category', label: 'Category' },
    { key: 'subcategory', label: 'Subcategory' },
    { key: 'code', label: 'Product code' }
];
const FIELD_ALIASES = { brand: 'vendor' };
const KNOWN = new Set([...TITLE_FIELDS.map((f) => f.key), ...Object.keys(FIELD_ALIASES)]);

const count = (arg) => (arg !== undefined && /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : null);
const whenPresent = (fn) => (value, args) => (value === '' ? '' : fn(value, args));

const FILTERS = {
    upper: { min: 0, max: 0, apply: (v) => v.toUpperCase() },
    lower: { min: 0, max: 0, apply: (v) => v.toLowerCase() },
    trim: { min: 0, max: 0, apply: (v) => v.trim() },
    truncate: { min: 1, max: 1, apply: whenPresent((v, a) => { const n = count(a[0]); return n === null ? v : v.slice(0, n).trim(); }) },
    first: { min: 1, max: 1, apply: whenPresent((v, a) => { const n = count(a[0]); return n === null ? v : v.trim().split(/\s+/).slice(0, n).join(' '); }) },
    last: { min: 1, max: 1, apply: whenPresent((v, a) => { const n = count(a[0]); if (n === null) return v; const w = v.trim().split(/\s+/); return n === 0 ? '' : w.slice(-n).join(' '); }) },
    replace: { min: 2, max: 2, apply: whenPresent((v, a) => (a[0] ? v.split(a[0]).join(a[1] ?? '') : v)) },
    prefix: { min: 1, max: 1, apply: whenPresent((v, a) => `${a[0] ?? ''}${v}`) },
    suffix: { min: 1, max: 1, apply: whenPresent((v, a) => `${v}${a[0] ?? ''}`) },
    default: { min: 1, max: 1, apply: (v, a) => (v === '' ? (a[0] ?? '') : v) }
};

const FIELD_RE = /^[a-z0-9_.]+$/;
const ESCAPABLE = new Set(['{', '}', '[', ']', '\\']);

function parseArgs(raw, errors) {
    const args = [];
    let i = 0;
    while (i < raw.length) {
        if (raw[i] === ':') { i += 1; continue; }
        let value = '';
        if (raw[i] === '"') {
            i += 1;
            let closed = false;
            while (i < raw.length) {
                if (raw[i] === '\\' && i + 1 < raw.length) { value += raw[i + 1]; i += 2; continue; }
                if (raw[i] === '"') { closed = true; i += 1; break; }
                value += raw[i]; i += 1;
            }
            if (!closed) errors.push('A quoted value is missing its closing quotation mark.');
        } else {
            while (i < raw.length && raw[i] !== ':') { value += raw[i]; i += 1; }
        }
        args.push(value);
    }
    return args;
}

function parseToken(cur, errors) {
    const close = cur.src.indexOf('}', cur.at + 1);
    if (close === -1) { errors.push('A token is missing its closing brace.'); cur.at = cur.src.length; return null; }
    const inner = cur.src.slice(cur.at + 1, close);
    cur.at = close + 1;
    const [rawField = '', ...rawFilters] = inner.split('|');
    const field = rawField.trim().toLowerCase();
    if (!field) { errors.push('A token has no field in it.'); return null; }
    if (!FIELD_RE.test(field)) { errors.push(`"${rawField.trim()}" is not a field name.`); return null; }
    const filters = [];
    for (const rawFilter of rawFilters) {
        const t = rawFilter.trim();
        if (!t) continue;
        const colon = t.indexOf(':');
        const name = (colon === -1 ? t : t.slice(0, colon)).trim().toLowerCase();
        const spec = FILTERS[name];
        if (!spec) { errors.push(`"${name}" is not a filter.`); continue; }
        const args = colon === -1 ? [] : parseArgs(t.slice(colon), errors);
        if (args.length < spec.min || args.length > spec.max) { errors.push(`"${name}" takes ${spec.min} ${spec.min === 1 ? 'value' : 'values'}.`); continue; }
        filters.push({ name, args });
    }
    return { kind: 'token', field, filters };
}

function parseNodes(cur, errors, inGroup) {
    const nodes = [];
    let lit = '';
    const flush = () => { if (lit) { nodes.push({ kind: 'literal', text: lit }); lit = ''; } };
    while (cur.at < cur.src.length) {
        const ch = cur.src[cur.at];
        if (ch === '\\' && ESCAPABLE.has(cur.src[cur.at + 1])) { lit += cur.src[cur.at + 1]; cur.at += 2; continue; }
        if (ch === '{') { flush(); const t = parseToken(cur, errors); if (t) nodes.push(t); continue; }
        if (ch === '[') {
            flush();
            cur.at += 1;
            if (inGroup) { errors.push('An optional group cannot contain another one.'); continue; }
            const children = parseNodes(cur, errors, true);
            if (cur.src[cur.at] === ']') cur.at += 1; else errors.push('An optional group is missing its closing bracket.');
            nodes.push({ kind: 'group', children });
            continue;
        }
        if (ch === ']') {
            flush();
            if (inGroup) return nodes;
            errors.push('A bracket closes an optional group that was never opened.');
            cur.at += 1;
            continue;
        }
        lit += ch;
        cur.at += 1;
    }
    flush();
    return nodes;
}

function parseTitlePattern(src) {
    const errors = [];
    const nodes = parseNodes({ src: typeof src === 'string' ? src : '', at: 0 }, errors, false);
    return { nodes, errors };
}

/** Every field a token names, groups included. */
function fieldsOf(nodes) {
    return nodes.flatMap((n) => (n.kind === 'group' ? fieldsOf(n.children) : n.kind === 'token' ? [n.field] : []));
}

/** What is wrong with a stored pattern, as sentences; empty when it is fine. */
function lintTitlePattern(src) {
    const { nodes, errors } = parseTitlePattern(src);
    const unknown = [...new Set(fieldsOf(nodes).filter((f) => !KNOWN.has(f)))];
    if (unknown.length) {
        errors.push(`${unknown.map((f) => `{${f}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} a title prefix can use. Use ${TITLE_FIELDS.map((f) => `{${f.key}}`).join(', ')}.`);
    }
    return errors;
}

/** Whether a stored prefix uses any token — a plain "WINDSURF -" does not. */
function usesTokens(src) {
    return fieldsOf(parseTitlePattern(src).nodes).length > 0;
}

/**
 * The field values for one product. `categoryExportId` is the category set the store tags with
 * (the export config's `aiExportId`), so `{category}` names the same taxonomy as the tags.
 */
function titleFacts(product, { vendor = '', categoryExportId = null } = {}) {
    const ai = categoryExportId && categoryExportId !== 'all'
        ? (product.ai_categories || []).find((c) => c.exportId === categoryExportId)
        : null;
    const path = ai?.categoryName ? ai.categoryName.split(' / ').map((s) => s.trim()).filter(Boolean) : [];
    return {
        vendor: vendor || '',
        product_type: (product.categories && product.categories[0]) || '',
        category: path[0] || '',
        subcategory: path.length > 1 ? path[path.length - 1] : '',
        code: product.code || ''
    };
}

function renderNodes(nodes, facts) {
    let text = '';
    let filled = false;
    let hadToken = false;
    for (const node of nodes) {
        if (node.kind === 'literal') { text += node.text; continue; }
        if (node.kind === 'group') {
            const inner = renderNodes(node.children, facts);
            if (!inner.hadToken) { text += inner.text; continue; }
            hadToken = true;
            if (inner.filled) { text += inner.text; filled = true; }
            continue;
        }
        hadToken = true;
        const key = FIELD_ALIASES[node.field] || node.field;
        const raw = Object.prototype.hasOwnProperty.call(facts, key) ? String(facts[key] ?? '') : '';
        const value = node.filters.reduce((v, f) => FILTERS[f.name].apply(v, f.args), raw);
        if (value !== '') filled = true;
        text += value;
    }
    return { text, filled, hadToken };
}

const SEP = '\\-\u2013\u2014/|,;:\u00b7';
const LEADING = new RegExp(`^[\\s${SEP}]+`);
// Two separators an empty token left side by side: keep the later one, the one that joins the title.
const ADJACENT = new RegExp(`[${SEP}]\\s*([${SEP}])`, 'g');

/**
 * The prefix for one product: tokens filled, the gaps an empty token leaves collapsed, a leading
 * separator dropped. The trailing separator stays — it is what joins the prefix to the title.
 * Empty when the pattern has tokens and none of them produced anything.
 */
function renderTitlePrefix(src, facts) {
    const { nodes } = parseTitlePattern(src);
    const r = renderNodes(nodes, facts);
    if (r.hadToken && !r.filled) return '';
    let out = r.text.replace(/\s+/g, ' ');
    let prev = '';
    while (prev !== out) { prev = out; out = out.replace(ADJACENT, '$1'); }
    out = out.replace(LEADING, '').replace(/\s+/g, ' ').trim();
    return new RegExp(`^[\\s${SEP}]*$`).test(out) ? '' : out;
}

module.exports = {
    TITLE_FIELDS,
    parseTitlePattern,
    lintTitlePattern,
    usesTokens,
    titleFacts,
    renderTitlePrefix
};
