const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseTitlePattern, lintTitlePattern, usesTokens, titleFacts, renderTitlePrefix
} = require('../src/services/shopify/titlePattern');

const facts = (f) => ({ vendor: '', product_type: '', category: '', subcategory: '', code: '', ...f });

test('renders tokens and keeps the trailing separator', () => {
    assert.equal(renderTitlePrefix('{vendor} -', facts({ vendor: 'Dakine' })), 'Dakine -');
    assert.equal(renderTitlePrefix('{category|upper} -', facts({ category: 'Windsurf' })), 'WINDSURF -');
    assert.equal(renderTitlePrefix('{brand} -', facts({ vendor: 'Unifiber' })), 'Unifiber -');
});

test('a pattern whose tokens are all empty renders nothing', () => {
    assert.equal(renderTitlePrefix('{vendor} -', facts()), '');
    assert.equal(renderTitlePrefix('{unknown} -', facts({ vendor: 'X' })), '');
});

test('plain literal prefixes pass through', () => {
    assert.equal(renderTitlePrefix('WINDSURF -', facts()), 'WINDSURF -');
});

test('optional groups vanish when their tokens are empty', () => {
    assert.equal(renderTitlePrefix('[{vendor} · ]{category} -', facts({ category: 'Kite' })), 'Kite -');
    assert.equal(renderTitlePrefix('[{vendor} · ]{category} -', facts({ vendor: 'X', category: 'Kite' })), 'X · Kite -');
});

test('the gap an empty token leaves collapses, a leading separator is dropped', () => {
    assert.equal(renderTitlePrefix('{vendor} - {category} -', facts({ vendor: 'Dakine' })), 'Dakine -');
    assert.equal(renderTitlePrefix('{vendor} - {category} -', facts({ category: 'Kite' })), 'Kite -');
});

test('filters', () => {
    const f = facts({ vendor: 'Point Seven Sails', category: '' });
    assert.equal(renderTitlePrefix('{vendor|truncate:5}', f), 'Point');
    assert.equal(renderTitlePrefix('{vendor|first:2|lower}', f), 'point seven');
    assert.equal(renderTitlePrefix('{vendor|last:1}', f), 'Sails');
    assert.equal(renderTitlePrefix('{vendor|replace:" ":"_"}', f), 'Point_Seven_Sails');
    assert.equal(renderTitlePrefix('{category|default:"Misc"} -', f), 'Misc -');
    // prefix/suffix only apply to a value that is there
    assert.equal(renderTitlePrefix('{category|prefix:"> "}{vendor|suffix:":"}', f), 'Point Seven Sails:');
});

test('backslash escapes a literal brace', () => {
    assert.equal(renderTitlePrefix('\\{X\\} -', facts()), '{X} -');
    assert.deepEqual(parseTitlePattern('\\{X\\}').nodes, [{ kind: 'literal', text: '{X}' }]);
});

test('lintTitlePattern reports what is wrong, empty when fine', () => {
    assert.deepEqual(lintTitlePattern('{vendor} - [{category|upper} ]'), []);
    assert.match(lintTitlePattern('{foo} -').join(' '), /\{foo\} is not a field/);
    assert.match(lintTitlePattern('{vendor|nope}').join(' '), /"nope" is not a filter/);
    assert.match(lintTitlePattern('{vendor').join(' '), /missing its closing brace/);
    assert.match(lintTitlePattern('[{vendor}').join(' '), /missing its closing bracket/);
    assert.match(lintTitlePattern('[[{vendor}]]').join(' '), /cannot contain another/);
    assert.match(lintTitlePattern('{vendor|truncate}').join(' '), /"truncate" takes 1 value/);
});

test('parsing never throws on junk', () => {
    for (const src of [null, undefined, 42, '}}}', ']', '{', '{|}', '["']) {
        assert.doesNotThrow(() => parseTitlePattern(src));
        assert.doesNotThrow(() => renderTitlePrefix(src, facts()));
    }
});

test('usesTokens', () => {
    assert.equal(usesTokens('WINDSURF -'), false);
    assert.equal(usesTokens('[{vendor}] -'), true);
});

test('titleFacts reads the category from the selected AI set', () => {
    const product = {
        code: 'C1',
        categories: ['Kite'],
        ai_categories: [
            { exportId: 'other', categoryName: 'Nope' },
            { exportId: 'e1', categoryName: 'Water / Kite / Boards' }
        ]
    };
    assert.deepEqual(titleFacts(product, { vendor: 'V', categoryExportId: 'e1' }), {
        vendor: 'V', product_type: 'Kite', category: 'Water', subcategory: 'Boards', code: 'C1'
    });
    const none = titleFacts(product, { categoryExportId: 'all' });
    assert.equal(none.category, '');
    assert.equal(none.subcategory, '');
    assert.equal(titleFacts({}, {}).product_type, '');
});
