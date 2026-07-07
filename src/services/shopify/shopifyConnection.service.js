const { getDb } = require('../db/mongo.service');
const { ObjectId } = require('mongodb');
const { encryptToken } = require('./crypto.service');

/**
 * Data-access layer for the `shopify_connections` collection — one document per
 * connected store (design §6). Access tokens are stored encrypted; this module
 * never returns the plaintext or the encrypted token to callers other than the
 * sync engine via {@link getConnectionWithToken}.
 */

const COLLECTION_NAME = 'shopify_connections';
// Short-lived pre-OAuth registrations for the "bring your own OAuth app" (custom_oauth) flow: the
// portal user's app credentials are parked here between "Connect" (build install URL) and the OAuth
// callback, keyed by an id carried in the signed `state`. TTL-swept an hour after creation.
const REGISTRATION_COLLECTION = 'shopify_app_registrations';

const DEFAULT_SCOPES = (process.env.SHOPIFY_SCOPES ||
    'read_products,write_products,read_inventory,write_inventory,read_locations,read_publications,write_publications')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Scopes that enable listing + publishing to sales channels (publications). */
const PUBLICATION_SCOPES = ['read_publications', 'write_publications'];

/** True if the connection's granted scopes allow listing/publishing to sales channels. */
function canPublish(conn) {
    const granted = conn?.scopes || [];
    return PUBLICATION_SCOPES.some((s) => granted.includes(s));
}

/** Default per-connection sync config — safe defaults: stock-only, no image push. */
const DEFAULT_CONFIG = {
    exportConfigId: null,
    pricelistPriority: [],
    priceVatMode: 'inclusive', // 'inclusive' | 'exclusive'
    futureDatedGuard: true,
    syncStock: true,
    syncNewProducts: false,
    syncPrices: false,
    syncDescriptions: false,
    syncImages: false,
    ownership: 'stock_only', // 'stock_only' | 'portal_authoritative' | 'create_then_handoff'
    publicationIds: [] // sales channels (publications) to publish created products to
};

/**
 * Strips secrets (encrypted access + refresh tokens) before a connection leaves the service
 * for the API layer.
 */
function toPublic(conn) {
    if (!conn) return null;
    // Strip every at-rest secret before a connection leaves the service: the encrypted access +
    // refresh tokens AND a custom_oauth app's encrypted client secret.
    const { accessTokenEnc, refreshTokenEnc, appClientSecretEnc, ...rest } = conn;
    return { ...rest, _id: conn._id.toString(), connected: conn.status === 'active' };
}

/** Seconds-from-now → absolute Date, or null when the input is missing. */
function expiryDate(seconds) {
    return typeof seconds === 'number' ? new Date(Date.now() + seconds * 1000) : null;
}

/**
 * Upserts a connection after a successful OAuth exchange. Keyed by (ownerSub, shopDomain)
 * so re-installing the same store for the same user refreshes the token in place rather than
 * duplicating. Preserves an existing `config` on re-install.
 * @returns {Promise<Object>} the public-shaped connection
 */
async function upsertConnection({ ownerSub, ownerEmail, shopDomain, accessToken, refreshToken, expiresIn, refreshTokenExpiresIn, scopes, shopInfo }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();

    const existing = await collection.findOne({ ownerSub, shopDomain });

    const setFields = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        shopDomain,
        accessTokenEnc: encryptToken(accessToken),
        // Expiring offline tokens (2026-04 requirement): keep the refresh token + expiries so
        // the token service can renew the ~60-min access token without re-prompting the user.
        refreshTokenEnc: refreshToken ? encryptToken(refreshToken) : null,
        tokenExpiresAt: expiryDate(expiresIn),
        refreshTokenExpiresAt: expiryDate(refreshTokenExpiresIn),
        // Explicitly OAuth — so reconnecting a store here clears any prior 'custom_app' marker
        // (Prerelease flow) and the token service resumes refreshing instead of returning as-is.
        authMethod: 'oauth',
        scopes: scopes && scopes.length ? scopes : DEFAULT_SCOPES,
        shopName: shopInfo?.name || existing?.shopName || null,
        shopCurrency: shopInfo?.currency || existing?.shopCurrency || null,
        status: 'active',
        updatedAt: now
    };

    if (existing) {
        await collection.updateOne({ _id: existing._id }, { $set: setFields });
        return toPublic({ ...existing, ...setFields });
    }

    const doc = {
        ...setFields,
        shopifyLocationId: null,
        config: { ...DEFAULT_CONFIG },
        installedAt: now,
        lastSyncAt: null,
        lastSyncStatus: null
    };
    const result = await collection.insertOne(doc);
    return toPublic({ ...doc, _id: result.insertedId });
}

/**
 * Upserts a connection authenticated by a merchant-supplied **custom-app** Admin API token
 * (Route B / "Shopify Prerelease"). Unlike the OAuth path there is no `code` exchange and no
 * refresh token — a custom app created in the store admin issues a single long-lived,
 * non-expiring Admin API access token. `authMethod: 'custom_app'` marks the row so the token
 * service returns the stored token as-is instead of trying to refresh it (which would fail).
 * Keyed by (ownerSub, shopDomain) like {@link upsertConnection}, so re-pasting a token for the
 * same store refreshes it in place and preserves the existing sync `config`.
 * @returns {Promise<Object>} the public-shaped connection
 */
async function upsertCustomAppConnection({ ownerSub, ownerEmail, shopDomain, accessToken, scopes, shopInfo }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();

    const existing = await collection.findOne({ ownerSub, shopDomain });

    const setFields = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        shopDomain,
        accessTokenEnc: encryptToken(accessToken),
        // Custom-app tokens don't expire and can't be refreshed — clear the OAuth-only fields so
        // the token service takes the custom-app fast path (return-as-is) rather than the refresh path.
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        authMethod: 'custom_app',
        // A custom app's granted scopes aren't introspectable from the token, so we record the
        // scopes we ASK the merchant to enable (DEFAULT_SCOPES). A call needing a scope they didn't
        // grant simply 403s at request time and is surfaced then (best-effort, as elsewhere).
        scopes: scopes && scopes.length ? scopes : DEFAULT_SCOPES,
        shopName: shopInfo?.name || existing?.shopName || null,
        shopCurrency: shopInfo?.currency || existing?.shopCurrency || null,
        status: 'active',
        updatedAt: now
    };

    if (existing) {
        await collection.updateOne({ _id: existing._id }, { $set: setFields });
        return toPublic({ ...existing, ...setFields });
    }

    const doc = {
        ...setFields,
        shopifyLocationId: null,
        config: { ...DEFAULT_CONFIG },
        installedAt: now,
        lastSyncAt: null,
        lastSyncStatus: null
    };
    const result = await collection.insertOne(doc);
    return toPublic({ ...doc, _id: result.insertedId });
}

/**
 * Parks a portal user's own OAuth-app credentials before the OAuth redirect (custom_oauth /
 * "bring your own app" flow). Returns the inserted doc (incl. `_id`); the id is embedded in the
 * signed OAuth `state` so {@link getAppRegistration} can recover the client secret in the callback.
 * The client secret is encrypted at rest with the same key as tokens.
 * @returns {Promise<{ _id: ObjectId, ownerSub: string, ownerEmail: string|null, shopDomain: string, appClientId: string }>}
 */
async function createAppRegistration({ ownerSub, ownerEmail, shopDomain, appClientId, appClientSecret }) {
    const db = getDb();
    const doc = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        shopDomain,
        appClientId,
        appClientSecretEnc: encryptToken(appClientSecret),
        createdAt: new Date()
    };
    const result = await db.collection(REGISTRATION_COLLECTION).insertOne(doc);
    return { ...doc, _id: result.insertedId };
}

/** Returns a raw app-registration doc (INCLUDING the encrypted client secret) by id, or null. */
async function getAppRegistration(id) {
    if (!ObjectId.isValid(id)) return null;
    return getDb().collection(REGISTRATION_COLLECTION).findOne({ _id: new ObjectId(id) });
}

/** Deletes an app registration once its OAuth callback has completed (or on abandonment). */
async function deleteAppRegistration(id) {
    if (!ObjectId.isValid(id)) return;
    await getDb().collection(REGISTRATION_COLLECTION).deleteOne({ _id: new ObjectId(id) });
}

/**
 * Upserts a connection installed via the customer's OWN OAuth app (custom_oauth / "bring your own
 * app"). Identical token model to the shared-app {@link upsertConnection} (expiring offline token
 * + refresh token), but ALSO stores the app's `appClientId` and encrypted `appClientSecretEnc` so
 * the token service can refresh with the RIGHT app's credentials and the webhook handler can verify
 * that app's HMAC. Keyed by (ownerSub, shopDomain); preserves an existing `config` on reconnect.
 * @returns {Promise<Object>} the public-shaped connection
 */
async function upsertCustomOAuthConnection({ ownerSub, ownerEmail, shopDomain, accessToken, refreshToken, expiresIn, refreshTokenExpiresIn, scopes, shopInfo, appClientId, appClientSecret }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();

    const existing = await collection.findOne({ ownerSub, shopDomain });

    const setFields = {
        ownerSub,
        ownerEmail: ownerEmail || null,
        shopDomain,
        accessTokenEnc: encryptToken(accessToken),
        refreshTokenEnc: refreshToken ? encryptToken(refreshToken) : null,
        tokenExpiresAt: expiryDate(expiresIn),
        refreshTokenExpiresAt: expiryDate(refreshTokenExpiresIn),
        authMethod: 'custom_oauth',
        appClientId,
        appClientSecretEnc: encryptToken(appClientSecret),
        scopes: scopes && scopes.length ? scopes : DEFAULT_SCOPES,
        shopName: shopInfo?.name || existing?.shopName || null,
        shopCurrency: shopInfo?.currency || existing?.shopCurrency || null,
        status: 'active',
        updatedAt: now
    };

    if (existing) {
        await collection.updateOne({ _id: existing._id }, { $set: setFields });
        return toPublic({ ...existing, ...setFields });
    }

    const doc = {
        ...setFields,
        shopifyLocationId: null,
        config: { ...DEFAULT_CONFIG },
        installedAt: now,
        lastSyncAt: null,
        lastSyncStatus: null
    };
    const result = await collection.insertOne(doc);
    return toPublic({ ...doc, _id: result.insertedId });
}

/**
 * Returns ALL raw connection docs (INCLUDING encrypted secrets) for a shop domain. Used by the
 * webhook handler to find a custom_oauth app's client secret so it can verify a webhook signed
 * with that app's secret rather than the shared one. Never expose the result over the API.
 * @returns {Promise<Array<Object>>}
 */
async function findRawByShopDomain(shopDomain) {
    return getDb().collection(COLLECTION_NAME).find({ shopDomain }).toArray();
}

/**
 * Creates (or refreshes) a PENDING connection for a Shopify-initiated install — the merchant
 * approved OAuth from the App URL before signing into the portal, so we hold the token but have
 * no owner yet. `ownerSub` is null and `status` is 'pending'; the row is claimed (→ active) when an
 * approved partner signs in, or uninstalled+deleted on decline / by the cleanup sweep. Keyed by
 * `(ownerSub: null, shopDomain)` so a repeat install just refreshes the same pending row rather
 * than duplicating (and `createdAt` is bumped so the sweep clock restarts on each attempt).
 * @returns {Promise<Object>} the public-shaped pending connection
 */
async function createPendingConnection({ shopDomain, accessToken, refreshToken, expiresIn, refreshTokenExpiresIn, scopes, shopInfo, claimTokenHash }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();
    const setFields = {
        ownerSub: null,
        ownerEmail: null,
        shopDomain,
        accessTokenEnc: encryptToken(accessToken),
        refreshTokenEnc: refreshToken ? encryptToken(refreshToken) : null,
        tokenExpiresAt: expiryDate(expiresIn),
        refreshTokenExpiresAt: expiryDate(refreshTokenExpiresIn),
        scopes: scopes && scopes.length ? scopes : DEFAULT_SCOPES,
        shopName: shopInfo?.name || null,
        shopCurrency: shopInfo?.currency || null,
        status: 'pending',
        claimTokenHash,
        createdAt: now,
        updatedAt: now
    };
    await collection.updateOne(
        { ownerSub: null, shopDomain },
        { $set: setFields, $setOnInsert: { config: { ...DEFAULT_CONFIG }, shopifyLocationId: null, installedAt: now, lastSyncAt: null, lastSyncStatus: null } },
        { upsert: true }
    );
    return toPublic(await collection.findOne({ ownerSub: null, shopDomain }));
}

/**
 * Binds a pending connection to a signed-in (approved) portal user, making it active. Authorized
 * by the one-time claim token (its hash). Idempotent — a double submit (RSC re-render / refresh)
 * after the first claim returns the now-active connection instead of erroring. If the user already
 * owns a row for this shop (a reconnect), the fresh token is moved onto it and the pending row is
 * dropped, so the `(ownerSub, shopDomain)` unique index is never violated.
 * @returns {Promise<Object>} the public-shaped active connection
 */
async function claimPendingConnection({ shopDomain, claimTokenHash, ownerSub, ownerEmail }) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const now = new Date();

    const pending = await collection.findOne({ shopDomain, status: 'pending', claimTokenHash });
    if (!pending) {
        const already = await collection.findOne({ ownerSub, shopDomain });
        if (already && already.status === 'active') return toPublic(already);
        const error = new Error('No pending connection to claim for this store.');
        error.code = 'NOT_FOUND';
        throw error;
    }

    const existingOwned = await collection.findOne({ ownerSub, shopDomain });
    if (existingOwned) {
        await collection.updateOne(
            { _id: existingOwned._id },
            { $set: {
                accessTokenEnc: pending.accessTokenEnc,
                refreshTokenEnc: pending.refreshTokenEnc,
                tokenExpiresAt: pending.tokenExpiresAt,
                refreshTokenExpiresAt: pending.refreshTokenExpiresAt,
                scopes: pending.scopes,
                // A pending row always comes from OAuth — stamp it so claiming onto a store that was
                // previously connected via the custom-app (Prerelease) flow clears that marker.
                authMethod: 'oauth',
                shopName: pending.shopName || existingOwned.shopName || null,
                shopCurrency: pending.shopCurrency || existingOwned.shopCurrency || null,
                ownerEmail: ownerEmail || existingOwned.ownerEmail || null,
                status: 'active',
                updatedAt: now
            } }
        );
        await collection.deleteOne({ _id: pending._id });
        return toPublic(await collection.findOne({ _id: existingOwned._id }));
    }

    await collection.updateOne(
        { _id: pending._id },
        { $set: { ownerSub, ownerEmail: ownerEmail || null, status: 'active', updatedAt: now }, $unset: { claimTokenHash: '' } }
    );
    return toPublic(await collection.findOne({ _id: pending._id }));
}

/**
 * Returns the RAW pending connection (INCLUDING the encrypted token) matching a shop + claim-token
 * hash, or null. For the decline handler, which needs the token to self-uninstall before deleting.
 */
async function getPendingByClaim({ shopDomain, claimTokenHash }) {
    return getDb().collection(COLLECTION_NAME).findOne({ shopDomain, status: 'pending', claimTokenHash });
}

/**
 * Returns RAW pending connections (INCLUDING tokens) created before `cutoff` — abandoned installs
 * never claimed/declined (e.g. a merchant who only used the request-access form). The cleanup
 * sweep uninstalls + deletes them so we never hold a Shopify token for an unbound store.
 * @param {Date} cutoff
 * @returns {Promise<Array<Object>>}
 */
async function findStalePending(cutoff) {
    return getDb().collection(COLLECTION_NAME).find({ status: 'pending', createdAt: { $lt: cutoff } }).toArray();
}

/**
 * Returns the connection for a portal user (by Auth0 sub), public-shaped, or null.
 * Returns the most recently updated — used by the legacy single-store `status` endpoint.
 * Prefer {@link listConnectionsForUser} for the multi-store UI.
 */
async function getConnectionForUser(ownerSub) {
    const db = getDb();
    const conn = await db
        .collection(COLLECTION_NAME)
        .findOne({ ownerSub, status: { $ne: 'uninstalled' } }, { sort: { updatedAt: -1 } });
    return toPublic(conn);
}

/**
 * Returns ALL of a portal user's connected stores (public-shaped), oldest-first for a stable
 * switcher order. A single user can connect any number of Shopify stores — each is a separate
 * `(ownerSub, shopDomain)` row with its own token, config, location and product map. This is a
 * cheap query (no Shopify API calls); live locations/publications are loaded per-store on demand
 * via the connection-detail endpoint.
 * @returns {Promise<Array<Object>>}
 */
async function listConnectionsForUser(ownerSub) {
    const db = getDb();
    const conns = await db
        .collection(COLLECTION_NAME)
        .find({ ownerSub, status: { $ne: 'uninstalled' } })
        .sort({ installedAt: 1 })
        .toArray();
    return conns.map(toPublic);
}

/**
 * Returns the most recent ACTIVE connection for a shop domain (public-shaped), or null.
 * Used by the App-URL entry point to decide whether a store opening the app is already
 * connected (→ open the portal on it) or not (→ send them to connect). A given shop can only
 * be actively connected to one portal account at a time.
 */
async function findByShopDomain(shopDomain) {
    const db = getDb();
    const conn = await db
        .collection(COLLECTION_NAME)
        .findOne({ shopDomain, status: 'active' }, { sort: { updatedAt: -1 } });
    return toPublic(conn);
}

/**
 * Returns a connection by id, public-shaped, or null.
 */
async function getConnectionById(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const conn = await db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(id) });
    return toPublic(conn);
}

/**
 * Lists active connections that are **ready to sync** — have a live token, a chosen
 * "Products to sync" export config, and a target location. Used by the automatic triggers
 * (PNV-end delta, n8n reconcile) to fan a sync out across every connected store.
 * Returns minimal docs (`_id`, `shopDomain`); the sync engine re-loads the token itself.
 * @returns {Promise<Array<{ _id: ObjectId, shopDomain: string }>>}
 */
async function listActiveSyncable() {
    const db = getDb();
    return db.collection(COLLECTION_NAME)
        .find(
            {
                status: 'active',
                accessTokenEnc: { $ne: null },
                // Syncable when a scope source is selected: the legacy export-config field, a single
                // `config.scope`, or a `config.scopes[]` array. Locations are validated per-scope at
                // run time (a multi-source connection holds its locations per scope, not on the
                // connection), so a missing connection-level `shopifyLocationId` no longer excludes it.
                $or: [
                    { 'config.exportConfigId': { $ne: null } },
                    { 'config.scope.type': { $exists: true } },
                    { 'config.scopes.0': { $exists: true } }
                ]
            },
            { projection: { _id: 1, shopDomain: 1 } }
        )
        .toArray();
}

/**
 * Lists active, sync-ready connections whose scope is a specific Own Source feed — used by the
 * importer to fan the Shopify push out to every store consuming a feed after it re-imports.
 * @param {string} feedId
 * @returns {Promise<Array<{ _id: ObjectId, shopDomain: string }>>}
 */
async function listConnectionsForFeed(feedId) {
    const db = getDb();
    return db.collection(COLLECTION_NAME)
        .find(
            {
                status: 'active',
                accessTokenEnc: { $ne: null },
                // Match the feed whether it's the single `config.scope` or one entry of a
                // multi-source `config.scopes[]` array.
                $or: [
                    { 'config.scope.type': 'own_source', 'config.scope.feedId': feedId },
                    { 'config.scopes': { $elemMatch: { type: 'own_source', feedId } } }
                ]
            },
            { projection: { _id: 1, shopDomain: 1 } }
        )
        .toArray();
}

/**
 * Returns the raw connection INCLUDING the encrypted token. For internal use by the
 * sync engine and the OAuth/locations flow — never expose the result over the API.
 */
async function getConnectionWithToken(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    return db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(id) });
}

/**
 * Updates the per-connection sync config and/or chosen Shopify location.
 * Only whitelisted keys are accepted. Returns the public-shaped connection.
 */
async function updateConnectionConfig(id, patch) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);

    const allowed = [
        'exportConfigId', 'pricelistPriority', 'priceVatMode', 'futureDatedGuard',
        'syncStock', 'syncNewProducts', 'syncPrices', 'syncDescriptions', 'syncImages', 'ownership',
        'publicationIds',
        // Shopify Option1 name for variants of newly-created products (e.g. "Size", "Volume").
        // Per-source override lives on the scope; this is the connection-level fallback.
        'variantOptionName',
        // `scope` selects WHAT this connection pushes: { type:'export_config', exportConfigId }
        // (default/back-compat) or { type:'own_source', feedId } (an external brand feed).
        'scope',
        // `scopes[]` is the multi-source form: several sources pushed to the SAME store at
        // DIFFERENT locations — each { type, exportConfigId|feedId, locationId }.
        'scopes'
    ];
    const set = { updatedAt: new Date() };
    if (patch.config) {
        for (const key of allowed) {
            if (key in patch.config) set[`config.${key}`] = patch.config[key];
        }
    }
    if ('shopifyLocationId' in patch) set.shopifyLocationId = patch.shopifyLocationId;
    // Optional friendly label a partner gives a store (shown in the switcher pill + panel header).
    // Trimmed; an empty string clears it so the UI falls back to the raw *.myshopify.com domain.
    if ('displayName' in patch) {
        const name = typeof patch.displayName === 'string' ? patch.displayName.trim() : '';
        set.displayName = name ? name.slice(0, 60) : null;
    }

    const result = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: set },
        { returnDocument: 'after' }
    );
    const updated = result; // driver v6+: the doc itself (or null), no {value} wrapper
    if (!updated) {
        const error = new Error('Connection not found');
        error.code = 'NOT_FOUND';
        throw error;
    }
    return toPublic(updated);
}

/**
 * Persists a renewed token set after a refresh. Obtaining a new expiring token retires the
 * previous one, so this must overwrite both the access and refresh tokens atomically.
 * @param {ObjectId|string} id
 * @param {{ accessToken:string, refreshToken:string, expiresIn:number, refreshTokenExpiresIn:number }} tokens
 */
async function updateTokens(id, { accessToken, refreshToken, expiresIn, refreshTokenExpiresIn }) {
    if (!ObjectId.isValid(id)) return;
    await getDb().collection(COLLECTION_NAME).updateOne(
        { _id: new ObjectId(id) },
        {
            $set: {
                accessTokenEnc: encryptToken(accessToken),
                refreshTokenEnc: refreshToken ? encryptToken(refreshToken) : null,
                tokenExpiresAt: expiryDate(expiresIn),
                refreshTokenExpiresAt: expiryDate(refreshTokenExpiresIn),
                updatedAt: new Date()
            }
        }
    );
}

/**
 * Records the outcome of a sync run on the connection (drives the UI's "Last sync" /
 * "Sync status" summary). Never touches the connection `status` field (active/uninstalled).
 * @param {ObjectId|string} id
 * @param {{ lastSyncAt?: Date, lastSyncStatus?: string }} fields
 */
async function updateLastSync(id, { lastSyncAt = new Date(), lastSyncStatus } = {}) {
    if (!ObjectId.isValid(id)) return;
    const set = { lastSyncAt, updatedAt: new Date() };
    if (lastSyncStatus) set.lastSyncStatus = lastSyncStatus;
    await getDb().collection(COLLECTION_NAME).updateOne({ _id: new ObjectId(id) }, { $set: set });
}

/**
 * Sets the connection status (e.g. 'uninstalled' on app/uninstalled webhook, 'error' on failure).
 */
async function setStatus(id, status, extra = {}) {
    if (!ObjectId.isValid(id)) return;
    const db = getDb();
    await db.collection(COLLECTION_NAME).updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date(), ...extra } }
    );
}

/**
 * Marks every connection for a shop domain as uninstalled (app/uninstalled webhook). Both tokens
 * are cleared (uninstall revokes them). The connection ROW is kept (status: 'uninstalled', hidden
 * from the portal list) so a later reinstall reuses it and preserves the partner's config.
 * @returns {Promise<Array<ObjectId>>} ids of the affected connections (so the caller can drop
 *   their product maps).
 */
async function markUninstalledByShop(shopDomain) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const affected = await collection.find({ shopDomain }, { projection: { _id: 1 } }).toArray();
    await collection.updateMany(
        { shopDomain },
        { $set: { status: 'uninstalled', accessTokenEnc: null, refreshTokenEnc: null, updatedAt: new Date() } }
    );
    return affected.map((c) => c._id);
}

/**
 * Clears the scope on any connection linked to a now-deleted Own Source feed, so it stops
 * trying to push a feed that no longer exists. Returns the number of connections unlinked.
 * @param {string} feedId
 */
async function unlinkFeedFromConnections(feedId) {
    const db = getDb();
    // Clear a legacy single scope pointing at the feed…
    const single = await db.collection(COLLECTION_NAME).updateMany(
        { 'config.scope.type': 'own_source', 'config.scope.feedId': feedId },
        { $set: { 'config.scope': null, updatedAt: new Date() } }
    );
    // …and pull the feed out of any multi-source `config.scopes[]` array.
    const multi = await db.collection(COLLECTION_NAME).updateMany(
        { 'config.scopes': { $elemMatch: { type: 'own_source', feedId } } },
        { $pull: { 'config.scopes': { type: 'own_source', feedId } }, $set: { updatedAt: new Date() } }
    );
    return (single.modifiedCount || 0) + (multi.modifiedCount || 0);
}

/**
 * Hard-deletes EVERY connection row for a shop domain — the `shop/redact` GDPR webhook.
 * By the time Shopify sends it (48h after uninstall) the rows are already `uninstalled`
 * with tokens cleared; this erases the residual record (domain, owner, config) entirely.
 * @returns {Promise<Array<ObjectId>>} ids of the deleted connections (so the caller can
 *   drop their product maps and sync history).
 */
async function deleteByShopDomain(shopDomain) {
    const db = getDb();
    const collection = db.collection(COLLECTION_NAME);
    const affected = await collection.find({ shopDomain }, { projection: { _id: 1 } }).toArray();
    await collection.deleteMany({ shopDomain });
    return affected.map((c) => c._id);
}

/**
 * Hard-deletes a connection (explicit user disconnect). Returns true if removed.
 */
async function deleteConnection(id) {
    if (!ObjectId.isValid(id)) {
        const error = new Error('Invalid connection id');
        error.code = 'INVALID_ID';
        throw error;
    }
    const db = getDb();
    const result = await db.collection(COLLECTION_NAME).deleteOne({ _id: new ObjectId(id) });
    return result.deletedCount > 0;
}

/**
 * Creates indexes for the connection + map + job collections. Called once at startup.
 */
async function ensureIndexes() {
    try {
        const db = getDb();
        await db.collection(COLLECTION_NAME).createIndex({ ownerSub: 1, shopDomain: 1 }, { unique: true });
        await db.collection(COLLECTION_NAME).createIndex({ shopDomain: 1 });
        await db.collection(COLLECTION_NAME).createIndex({ status: 1 });

        // Pre-OAuth app registrations (custom_oauth flow) self-expire an hour after creation so an
        // abandoned "Connect" never leaves an app's client secret parked indefinitely.
        await db.collection(REGISTRATION_COLLECTION).createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });

        // Forward-declared collections for the sync engine (design §6) — index now so the
        // data plane can be added later without a migration.
        await db.collection('shopify_product_map').createIndex({ connectionId: 1, sku: 1 });
        await db.collection('shopify_product_map').createIndex({ connectionId: 1, parentCode: 1 });
        await db.collection('shopify_sync_jobs').createIndex({ connectionId: 1, status: 1 });
        await db.collection('shopify_sync_jobs').createIndex({ nextAttemptAt: 1 }, { sparse: true });

        console.log('[shopify] Connection indexes ensured.');
    } catch (error) {
        console.error('[shopify] Index creation error:', error.message);
    }
}

module.exports = {
    COLLECTION_NAME,
    DEFAULT_SCOPES,
    DEFAULT_CONFIG,
    canPublish,
    upsertConnection,
    upsertCustomAppConnection,
    upsertCustomOAuthConnection,
    createAppRegistration,
    getAppRegistration,
    deleteAppRegistration,
    findRawByShopDomain,
    createPendingConnection,
    claimPendingConnection,
    getPendingByClaim,
    findStalePending,
    getConnectionForUser,
    listConnectionsForUser,
    findByShopDomain,
    getConnectionById,
    getConnectionWithToken,
    listActiveSyncable,
    updateConnectionConfig,
    listConnectionsForFeed,
    updateTokens,
    updateLastSync,
    setStatus,
    markUninstalledByShop,
    unlinkFeedFromConnections,
    deleteByShopDomain,
    deleteConnection,
    ensureIndexes
};
