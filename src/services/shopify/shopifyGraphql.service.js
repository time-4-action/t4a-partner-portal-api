const axios = require('axios');
const { API_VERSION } = require('./shopifyApi.service');

/**
 * GraphQL Admin API client for the Shopify sync engine (design §8.5).
 *
 * The REST {@link module:shopifyApi.service} client covers the lightweight connection
 * lifecycle (token exchange, webhooks, locations). The data-plane push uses GraphQL
 * because it gives explicit query-cost / leaky-bucket feedback and batched mutations.
 *
 * This module owns the one piece the design calls "non-negotiable at scale": throttle
 * handling. Every request inspects `extensions.cost.throttleStatus` and retries on
 * `THROTTLED` with a wait derived from Shopify's own restore rate, plus exponential
 * backoff on transient network/5xx failures. Nothing here logs the access token.
 */

/** Max attempts for a single GraphQL call before giving up (throttle + transient). */
const MAX_ATTEMPTS = 6;
/** Hard ceiling on any single backoff wait, so a pathological cost hint can't hang a sync. */
const MAX_BACKOFF_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pulls the leaky-bucket throttle status out of a GraphQL response, if present. */
function throttleStatusOf(body) {
    return body?.extensions?.cost?.throttleStatus || null;
}

/** True when a GraphQL `errors` array reports a throttling condition. */
function isThrottled(errors) {
    return Array.isArray(errors) && errors.some((e) => e?.extensions?.code === 'THROTTLED');
}

/**
 * Computes how long to wait before a retry.
 *  - THROTTLED: wait long enough for the leaky bucket to refill the cost we need
 *    (requestedQueryCost − currentlyAvailable) ÷ restoreRate, falling back to backoff.
 *  - transient: exponential backoff (250ms, 500ms, 1s, …) capped at MAX_BACKOFF_MS.
 */
function backoffMs(attempt, body) {
    const status = throttleStatusOf(body);
    const requested = body?.extensions?.cost?.requestedQueryCost;
    if (status && typeof requested === 'number' && status.restoreRate > 0) {
        const deficit = requested - (status.currentlyAvailable || 0);
        if (deficit > 0) {
            return Math.min(MAX_BACKOFF_MS, Math.ceil((deficit / status.restoreRate) * 1000) + 250);
        }
    }
    return Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt);
}

/**
 * Executes a single GraphQL operation against a shop's Admin API, with throttle +
 * transient-failure retries. Returns the `data` payload (callers inspect `userErrors`
 * inside it). Throws on definitive GraphQL errors, auth failure, or exhausted retries.
 *
 * The same `variables` are reused across retries, so any `@idempotent` key passed in
 * stays stable — a retried mutation is deduplicated by Shopify rather than re-applied.
 *
 * @param {string} shop - full myshopify domain
 * @param {string} accessToken - decrypted Admin API token
 * @param {string} query - GraphQL document
 * @param {Object} [variables]
 * @returns {Promise<Object>} the `data` object from the response
 */
async function graphqlRequest(shop, accessToken, query, variables = {}) {
    const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        let response;
        try {
            response = await axios.post(
                url,
                { query, variables },
                {
                    headers: {
                        'X-Shopify-Access-Token': accessToken,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000,
                    // We handle status codes ourselves so a 429/5xx becomes a retry, not a throw.
                    validateStatus: () => true
                }
            );
        } catch (err) {
            // Network-level failure (DNS, socket, timeout) — retry with backoff.
            lastError = err;
            if (attempt < MAX_ATTEMPTS - 1) {
                await sleep(Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt));
                continue;
            }
            break;
        }

        const { status, data: body, headers } = response;

        // REST-style throttle (rare for GraphQL, but Shopify can still 429 the endpoint).
        if (status === 429) {
            const retryAfter = parseFloat(headers['retry-after']);
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffMs(attempt, body));
            continue;
        }

        // Transient server errors — retry.
        if (status >= 500) {
            lastError = new Error(`Shopify GraphQL ${status}`);
            await sleep(Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt));
            continue;
        }

        // 401/403 — token invalid/revoked. Not retryable; surface a typed error. The HTTP
        // status is carried so callers can distinguish a revoked token (401 — e.g. the app was
        // uninstalled in Shopify) from a scope/permission refusal (403).
        if (status === 401 || status === 403) {
            const error = new Error(`Shopify auth failed (${status}) for ${shop}`);
            error.code = 'SHOPIFY_AUTH';
            error.status = status;
            throw error;
        }

        if (status !== 200) {
            const error = new Error(`Shopify GraphQL HTTP ${status}`);
            error.code = 'SHOPIFY_HTTP';
            throw error;
        }

        // 200 but throttled — Shopify returns the operation un-run with a THROTTLED error.
        if (isThrottled(body?.errors)) {
            await sleep(backoffMs(attempt, body));
            continue;
        }

        // Definitive GraphQL errors (bad query, permission, etc.) — not retryable.
        if (Array.isArray(body?.errors) && body.errors.length) {
            const error = new Error(body.errors.map((e) => e.message).join('; '));
            error.code = 'SHOPIFY_GRAPHQL';
            error.graphQLErrors = body.errors;
            throw error;
        }

        return body.data;
    }

    const error = new Error(`Shopify GraphQL request failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message || 'throttled'}`);
    error.code = 'SHOPIFY_RETRY_EXHAUSTED';
    throw error;
}

const LOCATIONS_QUERY = `query Locations($first: Int!) {
  locations(first: $first, includeInactive: false) {
    edges { node { id name isActive } }
  }
}`;

/**
 * Lists the shop's **active** inventory locations via GraphQL (the supported, non-legacy
 * path — REST is being retired). Returns the shape the connection's location picker expects.
 * @param {string} shop
 * @param {string} accessToken
 * @returns {Promise<Array<{ id:string, legacyId:string, name:string, active:boolean }>>}
 */
async function listLocations(shop, accessToken) {
    const data = await graphqlRequest(shop, accessToken, LOCATIONS_QUERY, { first: 50 });
    return (data?.locations?.edges || []).map(({ node }) => ({
        id: node.id, // gid://shopify/Location/123 — what we store as shopifyLocationId
        legacyId: node.id.split('/').pop(),
        name: node.name,
        active: node.isActive !== false
    }));
}

const PUBLICATIONS_QUERY = `query Publications($first: Int!) {
  publications(first: $first) {
    nodes { id name }
  }
}`;

/**
 * Lists the shop's publications (sales channels — Online Store, Point of Sale, etc.) so the
 * partner can choose where created products are published. Requires `read_publications`.
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
async function listPublications(shop, accessToken) {
    const data = await graphqlRequest(shop, accessToken, PUBLICATIONS_QUERY, { first: 50 });
    return (data?.publications?.nodes || []).map((p) => ({ id: p.id, name: p.name }));
}

const PUBLISH_MUTATION = `mutation Publish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

/**
 * Publishes a product (or any publishable) to a set of publications. Requires
 * `write_publications`. Returns the userErrors array (empty on success).
 */
async function publishToPublications(shop, accessToken, publishableId, publicationIds) {
    if (!publicationIds?.length) return [];
    const data = await graphqlRequest(shop, accessToken, PUBLISH_MUTATION, {
        id: publishableId,
        input: publicationIds.map((publicationId) => ({ publicationId }))
    });
    return data?.publishablePublish?.userErrors || [];
}

const UNPUBLISH_MUTATION = `mutation Unpublish($id: ID!, $input: [PublicationInput!]!) {
  publishableUnpublish(id: $id, input: $input) {
    userErrors { field message }
  }
}`;

/** Removes a product from a set of publications (sales channels). Requires `write_publications`. */
async function unpublishFromPublications(shop, accessToken, publishableId, publicationIds) {
    if (!publicationIds?.length) return [];
    const data = await graphqlRequest(shop, accessToken, UNPUBLISH_MUTATION, {
        id: publishableId,
        input: publicationIds.map((publicationId) => ({ publicationId }))
    });
    return data?.publishableUnpublish?.userErrors || [];
}

const NODES_EXISTS_QUERY = `query Nodes($ids: [ID!]!) { nodes(ids: $ids) { id } }`;

/**
 * Returns the subset of the given product (or any node) ids that STILL EXIST in the store.
 * Deleted ids come back as null from `nodes(ids:)`. Batched at 250 (the query limit). Used by
 * the sync's pre-flight so deleted products are detected up front and re-created in the same
 * run instead of erroring at push time and forcing a second sync.
 * @returns {Promise<Set<string>>}
 */
async function findExistingIds(shop, accessToken, ids) {
    const existing = new Set();
    for (let i = 0; i < ids.length; i += 250) {
        const batch = ids.slice(i, i + 250);
        const data = await graphqlRequest(shop, accessToken, NODES_EXISTS_QUERY, { ids: batch });
        for (const node of data?.nodes || []) if (node?.id) existing.add(node.id);
    }
    return existing;
}

module.exports = {
    graphqlRequest,
    listLocations,
    findExistingIds,
    listPublications,
    publishToPublications,
    unpublishFromPublications,
    // exported for unit-testing the backoff math
    _internals: { backoffMs, isThrottled, throttleStatusOf }
};
