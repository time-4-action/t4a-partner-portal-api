/* Repro: delete ONE media from a product in Shopify, run a sync, check whether the
 * portal_authoritative reconcile re-adds it (and re-links the variant image).
 * Usage: node scripts/repro-image-readd.js <shopifyProductGid> <altUrlToDelete>
 *        node scripts/repro-image-readd.js --check <shopifyProductGid>   (no delete, just sync+show)
 */
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(process.cwd(), '.env') });

const { connectToDb, getDb } = require('../src/services/db/mongo.service');
const { getValidAccessToken } = require('../src/services/shopify/shopifyToken.service');
const { graphqlRequest } = require('../src/services/shopify/shopifyGraphql.service');
const sync = require('../src/services/shopify/shopifySync.service');

const MEDIA_Q = `query($id: ID!) { product(id: $id) {
  title
  media(first: 100) { nodes { id alt status } }
  variants(first: 100) { nodes { id sku media(first: 5) { nodes { id alt } } } }
} }`;
const DELETE_M = `mutation($productId: ID!, $mediaIds: [ID!]!) {
  productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
    deletedMediaIds mediaUserErrors { field message }
  }
}`;

async function show(shop, token, pid, label) {
    const data = await graphqlRequest(shop, token, MEDIA_Q, { id: pid });
    const p = data.product;
    console.log(`\n--- ${label}: "${p.title}" media=${p.media.nodes.length}`);
    for (const m of p.media.nodes) console.log(`   ${m.id} [${m.status}] alt="${m.alt}"`);
    for (const v of p.variants.nodes) console.log(`   variant ${v.sku}: [${v.media.nodes.map((m) => m.alt).join(', ')}]`);
    return p;
}

(async () => {
    await connectToDb();
    const db = getDb();
    const conn = await db.collection('shopify_connections').findOne({ status: 'active' });
    const token = await getValidAccessToken(String(conn._id));
    const shop = conn.shopDomain;

    const checkOnly = process.argv[2] === '--check';
    const pid = checkOnly ? process.argv[3] : process.argv[2];
    const altToDelete = process.argv[3];

    const before = await show(shop, token, pid, 'BEFORE');

    if (!checkOnly) {
        const target = before.media.nodes.find((m) => m.alt === altToDelete);
        if (!target) { console.log('alt not found on product'); process.exit(1); }
        const del = await graphqlRequest(shop, token, DELETE_M, { productId: pid, mediaIds: [target.id] });
        console.log('\ndeleted:', JSON.stringify(del.productDeleteMedia));
        await new Promise((r) => setTimeout(r, 3000));
        await show(shop, token, pid, 'AFTER DELETE');
    }

    console.log('\nstarting sync…');
    const job = await sync.startStockSync(String(conn._id), { trigger: 'manual' });
    // poll job
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await db.collection('shopify_sync_jobs').findOne({ _id: job._id });
        if (j.status !== 'running') {
            console.log(`\njob ${j.status}; counts=${JSON.stringify(j.counts)}`);
            if (j.errors?.length) console.log('errors:', JSON.stringify(j.errors.slice(0, 5), null, 2));
            break;
        }
    }
    await new Promise((r) => setTimeout(r, 4000));
    await show(shop, token, pid, 'AFTER SYNC');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
