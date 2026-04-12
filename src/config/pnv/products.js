const { splitStringByBackslash, transformToBoolean, extractSize } = require('../../services/pnv/productMapping.service');
const { getCategoryNameForProductCode } = require('../../services/ai/categoryIdentification.service');


module.exports = {
    productMapping: [
        { csvHeader: 'Code', jsonKey: 'code' },
        { csvHeader: 'EAN koda', jsonKey: 'ean_code' },
        { csvHeader: 'Product name', jsonKey: 'product_name' },
        { csvHeader: 'Žeton', jsonKey: 'token' },
        { csvHeader: 'Kratek opis', jsonKey: 'short_description' },
        { csvHeader: 'Podroben opis', jsonKey: 'detailed_description' },
        { csvHeader: 'Kategorije', jsonKey: 'categories', transform: splitStringByBackslash },
        { jsonKey: 'images', csvHeaders: ['Prikazna slika', 'Dodatna fotografija 1', 'Dodatna fotografija 2', 'Dodatna fotografija 3', 'Dodatna fotografija 4', 'Dodatna fotografija 5', 'Dodatna fotografija 6', 'Dodatna fotografija 7', 'Dodatna fotografija 8'] },
        { csvHeader: 'Objavljeno', jsonKey: 'published', transform: transformToBoolean },
        { csvHeader: 'Arhivirano', jsonKey: 'archived', transform: transformToBoolean },
        { csvHeader: 'Košarica', jsonKey: 'cart', transform: transformToBoolean },
        { csvHeader: 'Mission', jsonKey: "mission", transform: transformToBoolean },
        { csvHeader: 'New', jsonKey: 'new', transform: transformToBoolean },
        { csvHeader: 'Priporočamo', jsonKey: 'recomended', transform: transformToBoolean },
        { csvHeader: 'Size', jsonKey: 'size', transform: extractSize }
    ]
}