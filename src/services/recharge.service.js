const { getAllProducts } = require('./product.service');

const escapeXml = (str) => {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

const getLatestValidPriceWithVat = (pricelist) => {
    if (!pricelist || pricelist.length === 0) return null;

    const now = new Date();
    const validEntries = pricelist
        .filter(p => p.valid_from && new Date(p.valid_from) <= now)
        .sort((a, b) => new Date(b.valid_from) - new Date(a.valid_from));

    if (validEntries.length === 0) return null;

    const entry = validEntries[0];
    const priceWithVat = entry.price * (1 + (entry.vat || 0) / 100);
    return priceWithVat.toFixed(2);
};

const generateRechargeXml = async () => {
    const products = await getAllProducts();

    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<products>'];

    for (const product of products) {
        if (!product.active || product.archived) continue;

        lines.push('  <product>');
        lines.push(`    <id>${escapeXml(product.code)}</id>`);
        lines.push(`    <name>${escapeXml(product.product_name)}</name>`);

        lines.push(`    <descriptionSI><![CDATA[${product.short_description || ''}]]></descriptionSI>`);
        lines.push(`    <descriptionEN><![CDATA[${product.short_description || ''}]]></descriptionEN>`);

        const katalogCategories = (product.ai_categories || []).filter(cat => cat.categoryName?.startsWith('Katalog'));
        if (katalogCategories.length > 0) {
            lines.push('    <features>');
            for (const cat of katalogCategories) {
                lines.push('      <feature>');
                lines.push('        <name>Category</name>');
                lines.push(`        <value>${escapeXml(cat.categoryName)}</value>`);
                lines.push('        <description></description>');
                lines.push('      </feature>');
            }
            lines.push('    </features>');
        }

        if (product.images && product.images.length > 0) {
            lines.push('    <images>');
            for (const img of product.images) {
                lines.push(`      <image>${escapeXml(img)}</image>`);
            }
            lines.push('    </images>');
        }

        if (product.child_products && product.child_products.length > 0) {
            lines.push('    <variants>');
            for (const child of product.child_products) {
                if (child.archived) continue;

                lines.push('      <variant>');
                lines.push(`        <id>${escapeXml(child.code)}</id>`);
                lines.push(`        <ean>${escapeXml(child.ean_code)}</ean>`);
                lines.push(`        <name>${escapeXml(child.product_name)}</name>`);
                lines.push(`        <stock>${child.stock_amount || 0}</stock>`);

                const price = getLatestValidPriceWithVat(child.pricelist);
                if (price !== null) {
                    lines.push(`        <recommendedRetailPriceWithVat>${price}</recommendedRetailPriceWithVat>`);
                }

                if (child.images && child.images.length > 0) {
                    lines.push('        <images>');
                    for (const img of child.images) {
                        lines.push(`          <image>${escapeXml(img)}</image>`);
                    }
                    lines.push('        </images>');
                }

                lines.push('      </variant>');
            }
            lines.push('    </variants>');
        }

        lines.push('  </product>');
    }

    lines.push('</products>');
    return lines.join('\n');
};

module.exports = { generateRechargeXml };
