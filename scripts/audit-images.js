/* Read-only audit: every mapped product — desired images vs present media (by alt),
 * duplicate alts, non-URL alts, variant-image link state.
 * Usage: node scripts/audit-images.js
 */
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(process.cwd(), '.env') });

const { connectToDb, getDb } = require('../src/services/db/mongo.service');
const { getValidAccessToken } = require('../src/services/shopify/shopifyToken.service');
const { graphqlRequest } = require('../src/services/shopify/shopifyGraphql.service');

const MEDIA_Q = `query($id: ID!) { product(id: $id) {
  title
  media(first: 100) { nodes { id alt status } }
  variants(first: 100) { nodes { id sku media(first: 5) { nodes { id alt } } } }
} }`;

(async () => {
    await connectToDb();
    const db = getDb();
    const conn = await db.collection('shopify_connections').findOne({ status: 'active' });
    const token = await getValidAccessToken(String(conn._id));
    const shop = conn.shopDomain;

    const rows = await db.collection('shopify_product_map').find({ connectionId: conn._id }).toArray();
    const byProduct = new Map();
    for (const r of rows) {
        if (r.shopifyProductId && !byProduct.has(r.shopifyProductId)) byProduct.set(r.shopifyProductId, r);
    }
    console.log(`auditing ${byProduct.size} products…`);

    let issues = 0;
    for (const [pid, row] of byProduct) {
        const prod = await db.collection('products').findOne({ code: row.parentCode }) ||
                     await db.collection('external_products').findOne({ code: row.parentCode });
        const data = await graphqlRequest(shop, token, MEDIA_Q, { id: pid });
        const p = data.product;
        if (!p) { console.log(`!! ${row.parentCode}: product GONE in store`); issues++; continue; }

        const kids = prod?.child_products || [];
        const vimgs = kids.flatMap((v) => v.images || []);
        const desired = [...new Set([...(prod?.images || []), ...vimgs])].filter(Boolean);
        const alts = p.media.nodes.map((m) => m.alt || '');
        const present = new Set(alts.filter(Boolean));

        const problems = [];
        const missing = desired.filter((u) => !present.has(u));
        if (missing.length) problems.push(`MISSING ${missing.length}/${desired.length}: ${missing.join(' , ')}`);
        const nonUrl = alts.filter((a) => a && !/^https?:\/\//.test(a));
        if (nonUrl.length) problems.push(`NON-URL alts: ${nonUrl.length} (${nonUrl.slice(0, 2).join(' | ')})`);
        const emptyAlt = alts.filter((a) => !a).length;
        if (emptyAlt) problems.push(`EMPTY alts: ${emptyAlt}`);
        const dupes = alts.filter((a, i) => a && alts.indexOf(a) !== i);
        if (dupes.length) problems.push(`DUPLICATE alts: ${[...new Set(dupes)].join(' , ')}`);
        const notReady = p.media.nodes.filter((m) => m.status !== 'READY');
        if (notReady.length) problems.push(`NOT READY: ${notReady.map((m) => `${m.id}=${m.status}`).join(' , ')}`);

        // variant link state: variant with a desired image but no/incorrect linked media
        const vBySku = new Map(p.variants.nodes.map((v) => [v.sku, v]));
        for (const v of kids) {
            const want = (v.images && v.images[0]) || null;
            if (!want) continue;
            const sv = vBySku.get(v.code);
            if (!sv) continue;
            const linked = sv.media.nodes.map((m) => m.alt);
            if (!linked.length) problems.push(`variant ${v.code}: UNLINKED (wants ${want})`);
            else if (!linked.includes(want)) problems.push(`variant ${v.code}: WRONG link (${linked[0]} ≠ ${want})`);
        }

        if (problems.length) {
            issues++;
            console.log(`\n## ${row.parentCode} "${p.title}" (${pid})`);
            for (const pr of problems) console.log('   -', pr);
        }
    }
    console.log(`\ndone. products with issues: ${issues}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
