/* One-off diagnostic: image-sync state per connection.
 * Usage: node scripts/diag-images.js [parentCode]
 */
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(process.cwd(), '.env') });

const { connectToDb, getDb } = require('../src/services/db/mongo.service');
const { getValidAccessToken } = require('../src/services/shopify/shopifyToken.service');
const { graphqlRequest } = require('../src/services/shopify/shopifyGraphql.service');

const MEDIA_Q = `query($id: ID!) { product(id: $id) {
  title
  media(first: 100) { nodes { id alt status mediaContentType } }
  variants(first: 100) { nodes { id sku media(first: 5) { nodes { id alt } } } }
} }`;

(async () => {
    await connectToDb();
    const db = getDb();
    const conns = await db.collection('shopify_connections').find({}).toArray();
    for (const c of conns) {
        console.log(`\n=== connection ${c._id} shop=${c.shopDomain} status=${c.status}`);
        console.log('  ownership =', c.config?.ownership, '| syncImages =', c.config?.syncImages, '| syncNewProducts =', c.config?.syncNewProducts);
    }
    const conn = conns.find((c) => c.status === 'active');
    if (!conn) { console.log('no active connection'); process.exit(0); }

    const filter = { connectionId: conn._id };
    if (process.argv[2]) filter.parentCode = process.argv[2];
    const rows = await db.collection('shopify_product_map').find(filter).limit(500).toArray();
    console.log(`\nmap rows (${rows.length}):`);
    const byProduct = new Map();
    for (const r of rows) {
        if (!byProduct.has(r.shopifyProductId)) byProduct.set(r.shopifyProductId, r);
    }

    const token = await getValidAccessToken(String(conn._id));
    let shown = 0;
    for (const [pid, row] of byProduct) {
        if (shown >= (process.argv[2] ? 5 : 4)) break;
        shown++;
        const data = await graphqlRequest(conn.shopDomain, token, MEDIA_Q, { id: pid });
        const p = data?.product;
        if (!p) { console.log(`\n-- ${row.parentCode} ${pid}: PRODUCT GONE`); continue; }
        console.log(`\n-- ${row.parentCode} "${p.title}" (${pid}) imageHash=${row.imageHash}`);
        for (const m of p.media.nodes) console.log(`   media ${m.id} [${m.status}] alt="${m.alt}"`);
        for (const v of p.variants.nodes) console.log(`   variant ${v.sku}: media=[${v.media.nodes.map((m) => m.id).join(', ')}]`);
        const prod = await db.collection('products').findOne({ code: row.parentCode }) ||
                     await db.collection('external_products').findOne({ code: row.parentCode });
        if (prod) {
            const vimgs = (prod.child_products || []).flatMap((v) => v.images || []);
            const desired = [...new Set([...(prod.images || []), ...vimgs])].filter(Boolean);
            console.log('   desired images:');
            for (const u of desired) console.log('     ', u);
        }
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
