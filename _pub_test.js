require('dotenv').config();
const { connectToDb, getDb } = require('./src/services/db/mongo.service');
const { getValidAccessToken } = require('./src/services/shopify/shopifyToken.service');
const { graphqlRequest } = require('./src/services/shopify/shopifyGraphql.service');

(async () => {
    await connectToDb();
    const conn = await getDb().collection('shopify_connections').findOne({ status: 'active' });
    const token = await getValidAccessToken(conn._id);
    const gq = (q, v) => graphqlRequest(conn.shopDomain, token, q, v);

    // 1) publications
    const pubs = await gq('query{ publications(first:20){ nodes{ id name catalog{ title } } } }', {});
    console.log('PUBLICATIONS:'); pubs.publications.nodes.forEach(p => console.log('  ', p.id, '| name:', p.name, '| catalog.title:', p.catalog?.title));

    // a real variant image
    const withVImg = await getDb().collection('products').findOne({ active: true, 'child_products.images.0': { $exists: true } }, { projection: { 'child_products.images': 1, 'child_products.code': 1 } });
    const vImg = withVImg?.child_products?.find(v => v.images?.[0])?.images?.[0];
    console.log('variant image url:', vImg);

    // 2) create test product with a variant that has mediaSrc (variant image)
    const pc = await gq('mutation($product: ProductCreateInput!){ productCreate(product:$product){ product{ id } userErrors{ message } } }',
        { product: { title: 'T4A PUB+VIMG TEST (delete me)', status: 'ACTIVE', productOptions: [{ name: 'Size', values: [{ name: 'S' }, { name: 'M' }] }] } });
    const pid = pc.productCreate.product.id;
    const vbc = await gq('mutation($productId: ID!, $variants:[ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy){ productVariantsBulkCreate(productId:$productId, variants:$variants, strategy:$strategy){ productVariants{ id sku media(first:3){ nodes{ id } } } userErrors{ field message } } }',
        { productId: pid, strategy: 'REMOVE_STANDALONE_VARIANT', variants: [
            { optionValues: [{ name: 'S', optionName: 'Size' }], inventoryItem: { sku: 'T4A-VIMG-S' }, mediaSrc: vImg ? [vImg] : undefined },
            { optionValues: [{ name: 'M', optionName: 'Size' }], inventoryItem: { sku: 'T4A-VIMG-M' } }
        ] });
    console.log('bulkCreate userErrors:', JSON.stringify(vbc.productVariantsBulkCreate.userErrors));
    console.log('variant media counts:', vbc.productVariantsBulkCreate.productVariants.map(v => ({ sku: v.sku, media: v.media.nodes.length })));

    // 3) publish to the first publication (e.g. Online Store)
    const target = pubs.publications.nodes[0];
    const pub = await gq('mutation($id: ID!, $input:[PublicationInput!]!){ publishablePublish(id:$id, input:$input){ userErrors{ field message } } }',
        { id: pid, input: [{ publicationId: target.id }] });
    console.log('publish to', target.name || target.catalog?.title, 'userErrors:', JSON.stringify(pub.publishablePublish.userErrors));

    // verify published
    const chk = await gq('query($id: ID!){ product(id:$id){ publishedOnCurrentPublication resourcePublicationsCount{ count } } }', { id: pid });
    console.log('product publications count:', JSON.stringify(chk.product));

    // cleanup
    const del = await gq('mutation($input: ProductDeleteInput!){ productDelete(input:$input){ deletedProductId } }', { input: { id: pid } });
    console.log('deleted:', del.productDelete.deletedProductId);
    process.exit(0);
})().catch(e => { console.log('ERROR:', e.code || '', e.message); process.exit(1); });
