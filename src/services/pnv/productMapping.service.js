/**
 * This service provides functions for transforming product data during the mapping process.
 */

/**
 * Splits a string by the backslash character, trims each resulting substring, and filters out any empty strings.
 * If the input value is falsy, it returns an empty array.
 * @param {string | undefined | null} value - The string to split, e.g., "Category 1 \ Category 2".
 * @returns {string[]} An array of trimmed strings, e.g., ["Category 1", "Category 2"].
 */
const splitStringByBackslash = (value) => {
    return value ? value.split('\\').map(s => s.trim()).filter(Boolean) : [];
};

/**
 * Transforms a value to its boolean equivalent. "1" or 1 becomes true, "0" or 0 becomes false.
 * Any other value will result in false.
 * @param {string | number | undefined | null} value - The value to transform.
 * @returns {boolean} The boolean representation.
 */
const transformToBoolean = (value) => {
    if (value === '1' || value === 1) {
        return true;
    }
    return false;
};

/**
 * Returns the size value as-is if non-empty, otherwise extracts a trailing number
 * from the product name (e.g. "Patrik QT-Wave 71" → "71").
 * @param {string | undefined | null} value - The Size column value.
 * @param {Object} row - The full CSV row, used to read 'Product name' as fallback.
 * @returns {string} The size string.
 */
const extractSize = (value, row) => {
    if (value && value.trim()) return value.trim();
    const name = row?.['Product name'] || '';
    const match = name.match(/\s(\d+(?:[.,]\d+)?)$/);
    return match ? match[1] : '';
};

module.exports = {
    splitStringByBackslash,
    transformToBoolean,
    extractSize,
};