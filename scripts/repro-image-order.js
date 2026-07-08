/* Repro for the gallery-order fix: scramble a product's media order in Shopify (move the
 * first image to the end — same drift a delete+re-add causes), run a sync, and verify the
 * portal_authoritative reconcile restores the catalogue order. No media is deleted.
 * Usage: node scripts/repro-image-order.js <shopifyProductGid>
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
  variants(first: 100) { nodes { id sku media(first: 5) { nodes { alt } } } }
} }`;
const REORDER_M = `mutation($id: ID!, $moves: [MoveInput!]!) {
  productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message } }
}`;

async function show(shop, token, pid, label) {
    const p = (await graphqlRequest(shop, token, MEDIA_Q, { id: pid })).product;
    console.log(`\n--- ${label}: "${p.title}"`);
    p.media.nodes.forEach((m, i) => console.log(`   #${i + 1} [${m.status}] ${m.alt}`));
    for (const v of p.variants.nodes) console.log(`   variant ${v.sku}: [${v.media.nodes.map((m) => m.alt).join(', ')}]`);
    return p;
}

(async () => {
    await connectToDb();
    const db = getDb();
    const conn = await db.collection('shopify_connections').findOne({ status: 'active' });
    const token = await getValidAccessToken(String(conn._id));
    const shop = conn.shopDomain;
    const pid = process.argv[2];

    const before = await show(shop, token, pid, 'BEFORE');
    if (before.media.nodes.length < 2) { console.log('need >= 2 media'); process.exit(1); }

    // Scramble: move the FIRST image to the END (simulates the delete+re-add drift).
    const first = before.media.nodes[0];
    const res = await graphqlRequest(shop, token, REORDER_M, {
        id: pid, moves: [{ id: first.id, newPosition: String(before.media.nodes.length - 1) }]
    });
    console.log('\nscramble:', JSON.stringify(res.productReorderMedia));
    await new Promise((r) => setTimeout(r, 5000));
    await show(shop, token, pid, 'AFTER SCRAMBLE');

    console.log('\nstarting sync…');
    const job = await sync.startStockSync(String(conn._id), { trigger: 'manual' });
    for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await db.collection('shopify_sync_jobs').findOne({ _id: job._id });
        if (j.status !== 'running') {
            console.log(`\njob ${j.status}; counts=${JSON.stringify(j.counts)}`);
            if (j.errors?.length) console.log('errors:', JSON.stringify(j.errors.slice(0, 5), null, 2));
            break;
        }
    }
    await new Promise((r) => setTimeout(r, 6000)); // reorder is an async Shopify job
    await show(shop, token, pid, 'AFTER SYNC');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
