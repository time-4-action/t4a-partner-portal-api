const connectionService = require('./shopifyConnection.service');
const syncService = require('./shopifySync.service');
const syncJobs = require('./shopifySyncJobs.service');
const tokenService = require('./shopifyToken.service');
const shopifyGraphql = require('./shopifyGraphql.service');
const { getAllExportConfigs, getExportConfigById, getDistinctPricelists } = require('../customExport.service');
const { getAiEnabledExports } = require('../exports.service');
const ownSource = require('../external/ownSource.service');
const pnvScheduler = require('../pnv/pnvScheduler.service');
const { normalizePriceFactor } = require('./priceFactor.util');
const { normalizePriceRounding, DEFAULT_PRICE_ROUNDING } = require('./priceRounding.util');
const {
    normalizeCompareAtPricelist, normalizePriceFields, normalizeExistingSalePolicy
} = require('./comparePrice.util');

/**
 * The Sources API (`docs/sources-api.md`): one connected store's scopes, described and edited
 * as **sources** the way an external client — Recharge Hub's Sources area — reads them.
 *
 * Nothing here is new data. A *source* is one entry of `config.scopes[]` (a catalogue export or
 * an Own Source feed pushed to one location, with its own push settings); a *run* is one
 * `shopify_sync_jobs` document. This module is the translation: scope ⇄ `Source`, job ⇄ `Run`,
 * and — the part that keeps the client generic — each source kind's settings described as a
 * list of typed **fields** the client renders without knowing what any of them means.
 *
 * The field list below is the contract's view of `SCOPE_CONFIG_KEYS` (the sync engine's
 * per-scope settings). Adding a scope setting means adding a field here and nowhere else on
 * the client side.
 */

/** A typed error the controller turns into the contract's `{ error, errors }` reply. */
class SourcesApiError extends Error {
    constructor(status, code, message, fieldErrors = []) {
        super(message);
        this.status = status;
        this.code = code;
        this.fieldErrors = fieldErrors;
    }
}

const OWNERSHIP_OPTIONS = [
    { value: 'stock_only', label: 'Stock only — the portal writes stock, nothing else' },
    { value: 'create_then_handoff', label: 'Create, then hand off — new products are created, then the store owns them' },
    { value: 'portal_authoritative', label: 'Portal authoritative — the portal maintains every synced field' }
];
const VAT_MODE_OPTIONS = [
    { value: 'inclusive', label: 'Pricelist prices include VAT' },
    { value: 'exclusive', label: 'Pricelist prices exclude VAT' }
];
const PRICE_FIELDS_OPTIONS = [
    { value: 'price_and_compare_at', label: 'Price and compare-at' },
    { value: 'price_only', label: 'Price only' },
    { value: 'compare_at_only', label: 'Compare-at only' }
];
const SALE_POLICY_OPTIONS = [
    { value: 'overwrite', label: 'Overwrite the sale with the portal prices' },
    { value: 'leave', label: 'Leave the sale alone' },
    { value: 'price_only', label: 'Update the price, keep the compare-at' },
    { value: 'compare_at_only', label: 'Update the compare-at, keep the price' }
];
const ROUNDING_MODE_OPTIONS = [
    { value: 'up', label: 'Up' },
    { value: 'down', label: 'Down' },
    { value: 'nearest', label: 'Nearest' }
];

const G_STORE = 'Store';
const G_SYNC = 'What to sync';
const G_PRICING = 'Pricing';
const G_ROUNDING = 'Price rounding';
const G_CREATED = 'Products the portal creates';
const G_CHANNELS = 'Sales channels';

/** The prefix of the one-boolean-per-sales-channel fields. */
const PUBLICATION_FIELD = 'publication:';

// ─── Live store facts (locations, channels) ─────────────────────────────────

/**
 * The store's locations and sales channels, read from Shopify with the connection's token.
 * One call per request that needs them; a store that cannot be read yields empty lists and a
 * `needsReconnect` flag so the fields still render (with no choices) rather than failing.
 */
async function loadStoreFacts(connection) {
    const facts = { locations: [], publications: [], publishingEnabled: connectionService.canPublish(connection), needsReconnect: connection.status === 'error' };
    if (connection.status !== 'active') return facts;
    try {
        const token = await tokenService.getValidAccessToken(connection._id);
        facts.locations = (await shopifyGraphql.listLocations(connection.shopDomain, token))
            .filter((l) => l.active !== false && !l.fulfillmentServiceId);
        if (facts.publishingEnabled) {
            try {
                facts.publications = await shopifyGraphql.listPublications(connection.shopDomain, token);
            } catch (err) {
                console.error('[sources-api] listPublications failed:', err.message);
            }
        }
    } catch (err) {
        if (err.code === 'REAUTH_REQUIRED' || err.status === 401) facts.needsReconnect = true;
        else console.error('[sources-api] listLocations failed:', err.code || '', err.message);
    }
    return facts;
}

// ─── What a source can be: the tenant's catalogue exports and feeds ─────────

/** The tenant's possible sources: `[{ kind, label, description, type, exportConfigId|feedId }]`. */
async function listSourceKinds(connection) {
    const authContext = { sub: connection.ownerSub, email: connection.ownerEmail };
    const [exportConfigs, feeds] = await Promise.all([
        getAllExportConfigs({ preset: 'shopify', limit: 200 }, authContext),
        connection.ownerSub ? ownSource.listSourcesForUser(connection.ownerSub) : []
    ]);
    const kinds = [];
    for (const cfg of exportConfigs) {
        kinds.push({
            kind: `export_config:${cfg._id.toString()}`,
            label: cfg.name || 'Catalogue export',
            description: 'A filtered view of the Time 4 Action catalogue, pushed to one location.',
            type: 'export_config',
            exportConfigId: cfg._id.toString()
        });
    }
    for (const feed of feeds) {
        kinds.push({
            kind: `own_source:${feed.feedId}`,
            label: feed.brand || feed.feedId,
            description: 'An Own Source feed the portal imports, pushed to one location.',
            type: 'own_source',
            feedId: feed.feedId
        });
    }
    return kinds;
}

function parseKind(kind) {
    const m = /^(export_config|own_source):(.+)$/.exec(String(kind || ''));
    if (!m) return null;
    return m[1] === 'own_source' ? { type: 'own_source', feedId: m[2] } : { type: 'export_config', exportConfigId: m[2] };
}

function kindOf(scope) {
    return scope.type === 'own_source' ? `own_source:${scope.feedId}` : `export_config:${scope.exportConfigId}`;
}

// ─── Fields: the per-scope settings, described ──────────────────────────────

/**
 * The AI category sets a source may tag with: for a catalogue export, every set with
 * categorization on; for a feed, the sets the feed itself maintains.
 */
async function categorySetOptions(scope) {
    if (scope.type === 'own_source') {
        const feed = await ownSource.getSourceByFeedId(scope.feedId);
        const ai = feed?.aiCategorization;
        const ids = ai?.enabled ? (ai.exportIds || []) : [];
        if (!ids.length) return [];
        const all = await getAiEnabledExports();
        return ids.map((id) => {
            const found = all.find((e) => e._id.toString() === id);
            return { value: id, label: found?.name || id };
        });
    }
    const all = await getAiEnabledExports();
    return all.map((e) => ({ value: e._id.toString(), label: e.name || e._id.toString() }));
}

/**
 * The field list for one scope (or for a kind, when `scope` is a bare `{type, …}`), with the
 * store's live choices baked into the selects.
 */
async function describeFields(scope, facts, pricelists) {
    const sets = await categorySetOptions(scope);
    const pricelistOptions = pricelists.map((p) => ({ value: p, label: p }));
    const fields = [
        { key: 'locationId', label: 'Location', type: 'select', required: true, group: G_STORE,
          help: facts.needsReconnect ? 'The store needs to be reconnected in the portal before its locations can be read.' : 'The Shopify location this source stocks. Other locations are activated at zero, never written.',
          options: facts.locations.map((l) => ({ value: l.id, label: l.name })) },

        { key: 'ownership', label: 'How much the portal owns', type: 'select', required: true, group: G_SYNC, options: OWNERSHIP_OPTIONS },
        { key: 'syncStock', label: 'Stock', type: 'boolean', group: G_SYNC, help: 'Free-to-sell quantities, every run.' },
        { key: 'syncNewProducts', label: 'New products', type: 'boolean', group: G_SYNC, help: 'Products the store does not have yet are created. Needs an ownership mode other than stock only.' },
        { key: 'syncPrices', label: 'Prices', type: 'boolean', group: G_SYNC },
        { key: 'syncDescriptions', label: 'Descriptions', type: 'boolean', group: G_SYNC },
        { key: 'syncTags', label: 'Tags', type: 'boolean', group: G_SYNC, help: 'Whether tags reach products already in the store is decided by the ownership mode.' },
        { key: 'syncImages', label: 'Images', type: 'boolean', group: G_SYNC },

        { key: 'pricelistPriority', label: 'Pricelist priority', type: 'text', group: G_PRICING,
          placeholder: pricelists.slice(0, 3).join(', '),
          help: `Pricelist names in the order to try, comma-separated. Known: ${pricelists.join(', ') || 'none yet'}.` },
        { key: 'priceVatMode', label: 'VAT in pricelists', type: 'select', group: G_PRICING, options: VAT_MODE_OPTIONS },
        { key: 'priceFactor', label: 'Price multiplier', type: 'number', group: G_PRICING, help: '1 leaves prices unchanged. Applied before rounding.' },
        { key: 'futureDatedGuard', label: 'Ignore future-dated pricelists', type: 'boolean', group: G_PRICING },
        { key: 'compareAtPricelist', label: 'Compare-at pricelist', type: 'select', group: G_PRICING,
          help: 'The pricelist pushed as the struck-through "was" price. Leave empty to never send a compare-at.', options: pricelistOptions },
        { key: 'priceFields', label: 'Price fields the portal maintains', type: 'select', group: G_PRICING, options: PRICE_FIELDS_OPTIONS,
          help: 'Only matters with a compare-at pricelist.' },
        { key: 'existingSalePolicy', label: 'When the store already runs a sale', type: 'select', group: G_PRICING, options: SALE_POLICY_OPTIONS },

        { key: 'rounding_enabled', label: 'Round shelf prices', type: 'boolean', group: G_ROUNDING, help: 'Snap every pushed price to a step and an ending, after the multiplier.' },
        { key: 'rounding_mode', label: 'Direction', type: 'select', group: G_ROUNDING, options: ROUNDING_MODE_OPTIONS },
        { key: 'rounding_step', label: 'Step', type: 'number', group: G_ROUNDING, help: '10 with an ending of 9 gives 2039; 1 with 0.99 gives 2039.99.' },
        { key: 'rounding_offset', label: 'Ending', type: 'number', group: G_ROUNDING, help: 'Between 0 and the step.' },
        { key: 'rounding_always_advance', label: 'Move a price that already ends right', type: 'boolean', group: G_ROUNDING, help: 'Off is the safe reading: a price that already fits is left alone.' },

        { key: 'variantOptionName', label: 'Variant option name', type: 'text', group: G_CREATED, placeholder: 'Size', help: 'The Shopify option name for variants of products the portal creates. Empty uses the default.' },
        { key: 'titlePrefix', label: 'Title prefix', type: 'text', group: G_CREATED, placeholder: 'WINDSURF -', help: 'Prepended to every pushed product title. Empty for none.' },
        { key: 'aiExportId', label: 'Category set for tags', type: 'select', group: G_CREATED, options: sets,
          help: sets.length ? 'Which AI category set supplies this store\'s tags.' : 'No category set is available for this source.' }
    ];
    if (facts.publishingEnabled) {
        for (const pub of facts.publications) {
            fields.push({ key: `${PUBLICATION_FIELD}${pub.id}`, label: pub.name, type: 'boolean', group: G_CHANNELS, help: 'Products the portal creates are published to this channel.' });
        }
    }
    return fields;
}

/** Stored pricelist priority (`[{name, enabled, priority}]`) as the text field's value. */
function pricelistPriorityText(list) {
    if (!Array.isArray(list)) return '';
    return list
        .filter((p) => p && p.enabled !== false && p.name)
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        .map((p) => p.name)
        .join(', ');
}

/** The effective settings of a scope, as field values. */
function valuesFor(connection, scope, facts) {
    const cfg = syncService.resolveScopeConfig(connection, scope);
    const rounding = normalizePriceRounding(cfg.priceRounding ?? DEFAULT_PRICE_ROUNDING);
    const pubs = new Set(Array.isArray(cfg.publicationIds) ? cfg.publicationIds : []);
    const values = {
        locationId: scope.locationId || connection.shopifyLocationId || null,
        ownership: cfg.ownership || 'stock_only',
        syncStock: cfg.syncStock !== false,
        syncNewProducts: !!cfg.syncNewProducts,
        syncPrices: !!cfg.syncPrices,
        syncDescriptions: !!cfg.syncDescriptions,
        syncTags: cfg.syncTags !== false,
        syncImages: !!cfg.syncImages,
        pricelistPriority: pricelistPriorityText(cfg.pricelistPriority),
        priceVatMode: cfg.priceVatMode || 'inclusive',
        priceFactor: normalizePriceFactor(cfg.priceFactor),
        futureDatedGuard: cfg.futureDatedGuard !== false,
        compareAtPricelist: normalizeCompareAtPricelist(cfg.compareAtPricelist),
        priceFields: normalizePriceFields(cfg.priceFields),
        existingSalePolicy: normalizeExistingSalePolicy(cfg.existingSalePolicy),
        rounding_enabled: !!rounding.enabled,
        rounding_mode: rounding.mode,
        rounding_step: rounding.step,
        rounding_offset: rounding.offset,
        rounding_always_advance: !!rounding.alwaysAdvance,
        variantOptionName: cfg.variantOptionName || '',
        titlePrefix: cfg.titlePrefix || '',
        aiExportId: scope.aiExportId || null
    };
    if (facts.publishingEnabled) {
        for (const pub of facts.publications) values[`${PUBLICATION_FIELD}${pub.id}`] = pubs.has(pub.id);
    }
    return values;
}

/**
 * Field values → a scope patch, checked against the field list. Unknown keys are ignored; a
 * value that is not one of the offered choices, or a number that makes no sense, is a per-field
 * error the client shows against the input.
 */
function applyValues(scope, values, fields, facts) {
    const out = { ...scope };
    const errors = [];
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const fail = (key, message) => errors.push({ field: key, message });
    const has = (key) => Object.prototype.hasOwnProperty.call(values, key);
    const bool = (key) => (has(key) ? values[key] === true || values[key] === 'true' : undefined);
    const str = (key) => (has(key) ? (values[key] === null ? '' : String(values[key]).trim()) : undefined);
    const num = (key) => {
        if (!has(key)) return undefined;
        if (values[key] === null || values[key] === '') return null;
        const n = typeof values[key] === 'string' ? Number(values[key].replace(',', '.')) : Number(values[key]);
        return Number.isFinite(n) ? n : NaN;
    };
    const choice = (key) => {
        const v = str(key);
        if (v === undefined) return undefined;
        if (v === '') return null;
        const options = byKey.get(key)?.options || [];
        if (!options.some((o) => o.value === v)) { fail(key, `${byKey.get(key)?.label || key} must be one of the offered choices.`); return undefined; }
        return v;
    };

    const locationId = choice('locationId');
    if (locationId === null) fail('locationId', 'Choose the location this source stocks.');
    else if (locationId !== undefined) out.locationId = locationId;

    for (const key of ['ownership', 'priceVatMode', 'priceFields', 'existingSalePolicy']) {
        const v = choice(key);
        if (v === null) fail(key, `${byKey.get(key).label} is required.`);
        else if (v !== undefined) out[key] = v;
    }
    for (const key of ['syncStock', 'syncNewProducts', 'syncPrices', 'syncDescriptions', 'syncTags', 'syncImages', 'futureDatedGuard']) {
        const v = bool(key);
        if (v !== undefined) out[key] = v;
    }

    const priority = str('pricelistPriority');
    if (priority !== undefined) {
        out.pricelistPriority = priority
            .split(',').map((s) => s.trim()).filter(Boolean)
            .map((name, i) => ({ name, enabled: true, priority: i }));
    }
    const factor = num('priceFactor');
    if (Number.isNaN(factor)) fail('priceFactor', 'Price multiplier must be a number.');
    else if (factor !== undefined) {
        if (factor === null || factor <= 0) fail('priceFactor', 'Price multiplier must be greater than zero.');
        else out.priceFactor = normalizePriceFactor(factor);
    }
    const compareAt = choice('compareAtPricelist');
    if (compareAt !== undefined) out.compareAtPricelist = compareAt;

    // Rounding is one object on the scope; the five fields are its parts.
    const roundingKeys = ['rounding_enabled', 'rounding_mode', 'rounding_step', 'rounding_offset', 'rounding_always_advance'];
    if (roundingKeys.some(has)) {
        const current = normalizePriceRounding(scope.priceRounding ?? DEFAULT_PRICE_ROUNDING);
        const next = { ...current };
        const enabled = bool('rounding_enabled'); if (enabled !== undefined) next.enabled = enabled;
        const mode = choice('rounding_mode'); if (mode) next.mode = mode;
        const step = num('rounding_step'); const offset = num('rounding_offset');
        if (Number.isNaN(step)) fail('rounding_step', 'Step must be a number.'); else if (step !== undefined && step !== null) next.step = step;
        if (Number.isNaN(offset)) fail('rounding_offset', 'Ending must be a number.'); else if (offset !== undefined && offset !== null) next.offset = offset;
        const advance = bool('rounding_always_advance'); if (advance !== undefined) next.alwaysAdvance = advance;
        const normalized = normalizePriceRounding(next);
        if (next.enabled && !normalized.enabled) {
            fail('rounding_step', 'The rounding rule does not make sense: the step must be between 0.01 and 1000 and the ending between 0 and the step.');
        }
        out.priceRounding = normalized;
    }

    const optionName = str('variantOptionName'); if (optionName !== undefined) out.variantOptionName = optionName;
    const prefix = str('titlePrefix'); if (prefix !== undefined) out.titlePrefix = prefix;
    const set = choice('aiExportId');
    if (set !== undefined) { if (set) out.aiExportId = set; else delete out.aiExportId; }

    if (facts.publishingEnabled) {
        const pubKeys = fields.filter((f) => f.key.startsWith(PUBLICATION_FIELD)).map((f) => f.key);
        if (pubKeys.some(has)) {
            const currentIds = new Set(Array.isArray(scope.publicationIds) ? scope.publicationIds : []);
            for (const key of pubKeys) {
                const v = bool(key);
                if (v === undefined) continue;
                const id = key.slice(PUBLICATION_FIELD.length);
                if (v) currentIds.add(id); else currentIds.delete(id);
            }
            out.publicationIds = [...currentIds];
        }
    }

    return { scope: out, errors };
}

// ─── Runs ───────────────────────────────────────────────────────────────────

const RUN_STATUS = { running: 'running', done: 'completed', partial: 'completed', failed: 'failed' };

/** One line about a finished run, in the portal's own words (counts, then the error). */
function runMessage(job) {
    const c = job.counts || {};
    const bits = [];
    if (job.error) bits.push(job.error);
    if (c.pushed) bits.push(`${c.pushed} stock`);
    if (c.createdProducts) bits.push(`${c.createdProducts} created`);
    if (c.pricesPushed) bits.push(`${c.pricesPushed} prices`);
    if (c.compareAtPushed) bits.push(`${c.compareAtPushed} compare-at`);
    if (c.contentPushed) bits.push(`${c.contentPushed} content`);
    if (c.imagesPushed) bits.push(`${c.imagesPushed} images`);
    if (c.publishedProducts) bits.push(`${c.publishedProducts} published`);
    if (c.unmatched) bits.push(`${c.unmatched} unmatched`);
    if (c.failed) bits.push(`${c.failed} failed`);
    if (job.status === 'running') return 'Running';
    if (!bits.length) return (c.inScope || 0) === 0 ? 'Nothing in scope' : null;
    return bits.join(' · ');
}

function toRun(job, scopeId) {
    const summary = scopeId ? (job.scopes || []).find((s) => s.id === scopeId) : null;
    const iso = (d) => (d?.toISOString ? d.toISOString() : d ? new Date(d).toISOString() : null);
    return {
        id: job._id.toString(),
        sourceId: scopeId || summary?.id || (job.scopes?.[0]?.id ?? job.scopeIds?.[0] ?? ''),
        status: RUN_STATUS[job.status] || 'failed',
        triggeredBy: job.trigger || null,
        queuedAt: iso(job.createdAt),
        startedAt: iso(job.startedAt),
        finishedAt: iso(job.finishedAt),
        itemCount: summary ? (summary.products ?? null) : (job.counts?.inScope ?? null),
        message: runMessage(job),
        downloadUrl: null
    };
}

/** The run's story as log lines, from what a job records: scopes, errors, unmatched, outcome. */
function toLog(job) {
    const at = (d) => (d?.toISOString ? d.toISOString() : new Date().toISOString());
    const lines = [{ at: at(job.startedAt || job.createdAt), level: 'info', message: `Started (${job.trigger || 'manual'}).` }];
    for (const s of job.scopes || []) {
        lines.push({ at: at(job.startedAt), level: 'info', message: `${s.source || s.type}: ${s.products ?? 0} products, ${s.ownership || 'stock_only'}.` });
    }
    for (const e of job.errors || []) {
        const text = typeof e === 'string' ? e : (e.error || e.message || JSON.stringify(e));
        lines.push({ at: at(job.finishedAt || job.startedAt), level: 'error', message: text });
    }
    const unmatched = job.unmatched || [];
    if (unmatched.length) {
        const sample = unmatched.slice(0, 10).map((u) => u.sku || u.code || u).join(', ');
        lines.push({ at: at(job.finishedAt || job.startedAt), level: 'warning', message: `${unmatched.length} SKU(s) had no matching variant in the store: ${sample}${unmatched.length > 10 ? ', …' : ''}.` });
    }
    if (job.finishedAt) {
        const msg = runMessage(job);
        lines.push({ at: at(job.finishedAt), level: job.status === 'failed' ? 'error' : 'info', message: `Finished ${job.status}${msg ? ` — ${msg}` : ''}.` });
    }
    return lines;
}

// ─── Source summaries ───────────────────────────────────────────────────────

/** "Every day at 04:00 (Europe/Ljubljana)" from a feed schedule. */
function describeFeedSchedule(schedule) {
    if (!schedule?.enabled) return null;
    const tz = schedule.timezone ? ` (${schedule.timezone})` : '';
    if (schedule.frequency === 'every_hours') return `Every ${Math.max(1, Number(schedule.everyHours) || 6)} hours`;
    const time = schedule.timeOfDay || '03:00';
    if (schedule.frequency === 'weekly') {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        return `Every ${days[Number(schedule.weekday)] || 'week'} at ${time}${tz}`;
    }
    return `Every day at ${time}${tz}`;
}

/** What starts this source's runs automatically, if anything. */
async function scheduleFor(scope, pnvStatus, feedsById) {
    if (scope.type === 'own_source') {
        const feed = feedsById.get(scope.feedId);
        const description = describeFeedSchedule(feed?.schedule);
        if (!description) return { mode: 'manual', description: null, nextRunAt: null };
        return { mode: 'automatic', description: `${description}, after the feed imports`, nextRunAt: feed?.nextRunAt ? new Date(feed.nextRunAt).toISOString() : null };
    }
    if (pnvStatus?.enabled) {
        return {
            mode: 'automatic',
            description: `After each catalogue refresh (${pnvStatus.schedule})`,
            nextRunAt: pnvStatus.nextRunAt ? new Date(pnvStatus.nextRunAt).toISOString() : null
        };
    }
    return { mode: 'manual', description: null, nextRunAt: null };
}

function healthFor(scope, lastJob, facts) {
    if (scope.enabled === false) return 'off';
    if (facts.needsReconnect || !scope.locationId) return 'needs_attention';
    if (!lastJob) return 'never_ran';
    if (lastJob.status === 'failed') return 'needs_attention';
    if (lastJob.status === 'partial' && ((lastJob.counts?.failed || 0) > 0 || (lastJob.errors || []).length > 0)) return 'needs_attention';
    return 'ok';
}

/** The label a source gets when the partner has not named it: "<what> → <where>". */
function defaultName(scope, kindLabel, facts) {
    const location = facts.locations.find((l) => l.id === scope.locationId);
    return location ? `${kindLabel} → ${location.name}` : kindLabel;
}

async function summarize(connection, scope, { kinds, facts, pnvStatus, feedsById }) {
    const kind = kinds.find((k) => k.kind === kindOf(scope));
    const kindLabel = kind?.label || (scope.type === 'own_source' ? `Feed ${scope.feedId}` : 'Catalogue export');
    const [lastJob] = await syncJobs.listRunsForScope(connection._id, scope.id, 1);
    const location = facts.locations.find((l) => l.id === scope.locationId);
    return {
        id: scope.id,
        name: scope.name || defaultName(scope, kindLabel, facts),
        kind: kindOf(scope),
        kindLabel,
        enabled: scope.enabled !== false,
        destination: location ? `${connection.shopName || connection.shopDomain} · ${location.name}` : (connection.shopName || connection.shopDomain),
        schedule: await scheduleFor(scope, pnvStatus, feedsById),
        health: healthFor(scope, lastJob, facts),
        lastRun: lastJob ? toRun(lastJob, scope.id) : null
    };
}

/** Everything a listing or a detail needs about the tenant, read once. */
async function context(connection, { withFacts = true } = {}) {
    const [kinds, facts, pnvStatus, feeds, pricelists] = await Promise.all([
        listSourceKinds(connection),
        withFacts ? loadStoreFacts(connection) : { locations: [], publications: [], publishingEnabled: false, needsReconnect: false },
        pnvScheduler.getStatus().catch(() => null),
        connection.ownerSub ? ownSource.listSourcesForUser(connection.ownerSub).catch(() => []) : [],
        getDistinctPricelists().catch(() => [])
    ]);
    const feedsById = new Map(feeds.map((f) => [f.feedId, f]));
    const names = pricelists.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
    return { kinds, facts, pnvStatus, feedsById, pricelists: names };
}

/** The connection with every scope carrying an id. */
async function loadTenant(connectionId) {
    const raw = await connectionService.getConnectionWithToken(connectionId);
    if (!raw) throw new SourcesApiError(404, 'not_found', 'The store is no longer connected.');
    const stamped = await connectionService.ensureScopeIds(raw);
    return stamped;
}

function scopesOf(connection) {
    return syncService.getScopeList(connection, { includeDisabled: true });
}

function findScope(connection, sourceId) {
    const scope = scopesOf(connection).find((s) => s.id === sourceId);
    if (!scope) throw new SourcesApiError(404, 'not_found', 'This source no longer exists in the portal.');
    return scope;
}

/**
 * Writes the whole scopes array back through the one path that normalizes it. The scopes carry
 * their ids, so identity reconciliation is a no-op; the connection-level location mirrors the
 * first scope's, as the portal UI does.
 */
async function saveScopes(connection, scopes) {
    await connectionService.updateConnectionConfig(connection._id.toString(), {
        config: { scopes },
        shopifyLocationId: scopes[0]?.locationId ?? connection.shopifyLocationId ?? null
    });
    return loadTenant(connection._id);
}

// ─── The operations the controller exposes ──────────────────────────────────

async function connectionInfo(connection, keyRecord) {
    return {
        tenant: { id: connection._id.toString(), name: connection.displayName || connection.shopName || connection.shopDomain },
        shop: { domain: connection.shopDomain },
        key: { name: keyRecord?.name || null, createdAt: keyRecord?.createdAt ? new Date(keyRecord.createdAt).toISOString() : null }
    };
}

async function listSourceTypes(connection) {
    const ctx = await context(connection);
    const types = [];
    for (const kind of ctx.kinds) {
        const scope = kind.type === 'own_source' ? { type: 'own_source', feedId: kind.feedId } : { type: 'export_config', exportConfigId: kind.exportConfigId };
        types.push({ kind: kind.kind, label: kind.label, description: kind.description, fields: await describeFields(scope, ctx.facts, ctx.pricelists) });
    }
    return types;
}

async function listSources(connectionId) {
    const connection = await loadTenant(connectionId);
    const ctx = await context(connection);
    const sources = [];
    for (const scope of scopesOf(connection)) sources.push(await summarize(connection, scope, ctx));
    return sources;
}

async function getSource(connectionId, sourceId) {
    const connection = await loadTenant(connectionId);
    const scope = findScope(connection, sourceId);
    const ctx = await context(connection);
    const summary = await summarize(connection, scope, ctx);
    return {
        ...summary,
        fields: await describeFields(scope, ctx.facts, ctx.pricelists),
        values: valuesFor(connection, scope, ctx.facts),
        createdAt: null,
        updatedAt: connection.updatedAt ? new Date(connection.updatedAt).toISOString() : null,
        portalUrl: process.env.SHOPIFY_PORTAL_RETURN_URL || null
    };
}

/** The defaults a source created over the API starts from: the connection's own config. */
function newScopeFrom(connection, parsedKind) {
    const base = connection.config || {};
    const scope = { ...parsedKind, id: connectionService.newScopeId(), enabled: true, locationId: null };
    for (const k of ['ownership', 'syncStock', 'syncNewProducts', 'syncPrices', 'syncDescriptions', 'syncTags', 'syncImages',
        'priceVatMode', 'futureDatedGuard', 'pricelistPriority', 'priceFactor', 'priceRounding',
        'compareAtPricelist', 'priceFields', 'existingSalePolicy', 'publicationIds', 'variantOptionName', 'titlePrefix']) {
        if (base[k] !== undefined) scope[k] = base[k];
    }
    return scope;
}

async function createSource(connectionId, { kind, name, values }) {
    const connection = await loadTenant(connectionId);
    const parsed = parseKind(kind);
    const ctx = await context(connection);
    if (!parsed || !ctx.kinds.some((k) => k.kind === kind)) {
        throw new SourcesApiError(422, 'invalid', 'The export portal does not offer this kind of source for the store.', [{ field: 'kind', message: 'Choose one of the offered kinds.' }]);
    }
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new SourcesApiError(422, 'invalid', 'Give the source a name.', [{ field: 'name', message: 'Give the source a name.' }]);
    if (parsed.type === 'export_config' && !(await getExportConfigById(parsed.exportConfigId))) {
        throw new SourcesApiError(422, 'invalid', 'That catalogue export no longer exists.', [{ field: 'kind', message: 'That catalogue export no longer exists.' }]);
    }

    const draft = newScopeFrom(connection, parsed);
    draft.name = trimmed.slice(0, 80);
    const fields = await describeFields(draft, ctx.facts, ctx.pricelists);
    const { scope, errors } = applyValues(draft, values || {}, fields, ctx.facts);
    if (!scope.locationId) errors.push({ field: 'locationId', message: 'Choose the location this source stocks.' });
    if (errors.length) throw new SourcesApiError(422, 'invalid', errors[0].message, errors);

    const saved = await saveScopes(connection, [...scopesOf(connection), scope]);
    return getSource(saved._id, scope.id);
}

async function updateSource(connectionId, sourceId, { name, enabled, values }) {
    const connection = await loadTenant(connectionId);
    const current = findScope(connection, sourceId);
    const ctx = await context(connection);
    const fields = await describeFields(current, ctx.facts, ctx.pricelists);
    let next = { ...current };
    const errors = [];
    if (name !== undefined) {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) errors.push({ field: 'name', message: 'Give the source a name.' });
        else next.name = trimmed.slice(0, 80);
    }
    if (enabled !== undefined) next.enabled = enabled === true;
    if (values && typeof values === 'object') {
        const applied = applyValues(next, values, fields, ctx.facts);
        next = applied.scope;
        errors.push(...applied.errors);
    }
    if (errors.length) throw new SourcesApiError(422, 'invalid', errors[0].message, errors);

    const scopes = scopesOf(connection).map((s) => (s.id === sourceId ? next : s));
    const saved = await saveScopes(connection, scopes);
    return getSource(saved._id, sourceId);
}

async function deleteSource(connectionId, sourceId) {
    const connection = await loadTenant(connectionId);
    findScope(connection, sourceId);
    await saveScopes(connection, scopesOf(connection).filter((s) => s.id !== sourceId));
}

async function startRun(connectionId, sourceId, keyRecord) {
    const connection = await loadTenant(connectionId);
    const scope = findScope(connection, sourceId);
    if (scope.enabled === false) throw new SourcesApiError(409, 'source_off', 'This source is switched off. Turn it on before running it.');
    try {
        const job = await syncService.startStockSync(connection._id, { trigger: `api:${keyRecord?.name || 'key'}`, scopeIds: [sourceId] });
        return toRun(job, sourceId);
    } catch (err) {
        if (err.code === 'SYNC_BUSY') throw new SourcesApiError(409, 'run_in_progress', 'A run is already in progress for this store. Wait for it to finish.');
        if (err.code === 'REAUTH_REQUIRED' || err.code === 'NOT_ACTIVE') throw new SourcesApiError(409, 'store_not_connected', 'The store needs to be reconnected in the portal before it can run.');
        if (err.code === 'NO_EXPORT_CONFIG') throw new SourcesApiError(422, 'invalid', err.message);
        throw err;
    }
}

async function listRuns(connectionId, sourceId, limit) {
    const connection = await loadTenant(connectionId);
    findScope(connection, sourceId);
    const jobs = await syncJobs.listRunsForScope(connection._id, sourceId, limit);
    return jobs.map((job) => toRun(job, sourceId));
}

async function getRun(connectionId, runId) {
    const connection = await loadTenant(connectionId);
    const job = await syncJobs.getRun(runId);
    if (!job || job.connectionId.toString() !== connection._id.toString()) {
        throw new SourcesApiError(404, 'not_found', 'This run no longer exists in the portal.');
    }
    const scopeId = (job.scopes || []).find((s) => s.id)?.id || job.scopeIds?.[0] || scopesOf(connection)[0]?.id || '';
    return { run: toRun(job, scopeId), log: toLog(job) };
}

module.exports = {
    SourcesApiError,
    connectionInfo,
    listSourceTypes,
    listSources,
    getSource,
    createSource,
    updateSource,
    deleteSource,
    startRun,
    listRuns,
    getRun,
    // exported for tests
    applyValues,
    valuesFor,
    describeFields,
    toRun,
    toLog,
    healthFor,
    parseKind
};
