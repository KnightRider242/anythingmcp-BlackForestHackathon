// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic logic tests. These never call the public API or local backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, workflow, connector, defaults } from './codebound-openfoodfacts-workflow.mjs';

const makeProduct = (code, sugar, grade = 'b') => ({
  code, product_name: 'Product ' + code, brands: 'Example',
  nutriscore_grade: grade, nova_group: 2,
  nutriments: sugar === null ? {} : { sugars_100g: sugar },
});

function mockApi(searchByCategory, detailByCode = {}) {
  const calls = [];
  const api = {
    call: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === 'off_search_products') {
        const page = searchByCategory[args.category]?.[args.page - 1];
        if (!page) throw new Error('Unexpected search request');
        return structuredClone(page);
      }
      if (tool === 'off_get_product') {
        const detail = detailByCode[args.code];
        if (!detail) throw new Error('Unexpected detail request');
        return structuredClone(detail);
      }
      throw new Error('Unapproved mock tool requested');
    },
  };
  return { api, calls };
}

test('manifest only exposes read-only HTTPS GET tools with fixed paths', () => {
  assert.equal(connector.baseUrl, 'https://world.openfoodfacts.org');
  assert.equal(connector.authType, 'NONE');
  assert.deepEqual(workflow.tools, ['off_search_products', 'off_get_product']);
  for (const tool of connector.tools) {
    assert.equal(tool.endpointMapping.method, 'GET');
    assert.equal(tool.endpointMapping.path.startsWith('/api/v2/'), true);
    assert.equal(tool.endpointMapping.bodyMapping, undefined);
  }
  assert.match(connector.headers['User-Agent'], /CODEBOUND-/);
  assert.ok(workflow.source.startsWith('async function main('));
  assert.ok(Buffer.byteLength(workflow.source) < 32 * 1024);
  assert.deepEqual(defaults.categories, ['breakfast-cereals', 'yogurts']);
});

test('paginates actual API response shapes, aggregates samples, and enriches details', async () => {
  const a = ['1234567890123', '1234567890124', '1234567890125', '1234567890126',
    '1234567890127', '1234567890128'];
  const y = ['1234567890129', '1234567890130', '1234567890131'];
  const { api, calls } = mockApi({
    'breakfast-cereals': [
      { count: 6, page: 1, page_count: 4, page_size: 4,
        products: [makeProduct(a[0], 32), makeProduct(a[1], 4),
          makeProduct(a[2], null), makeProduct(a[3], 28)] },
      { count: 6, page: 2, page_count: 2, page_size: 4,
        products: [makeProduct(a[4], 12, 'c'), makeProduct(a[5], 8)] },
    ],
    yogurts: [
      { count: 3, page: 1, page_count: 3, page_size: 4,
        products: [makeProduct(y[0], 5), makeProduct(y[1], 2),
          makeProduct(y[2], null, 'unknown')] },
    ],
  }, {
    [a[0]]: { status: 1, product: { code: a[0], ingredients_text: 'Oats, sugar',
      allergens_tags: ['en:gluten'], labels_tags: ['en:organic'] } },
    [a[3]]: { status: 1, product: { code: a[3], ingredients_text: '',
      allergens_tags: [], labels_tags: [] } },
  });
  const result = await main({ categories: ['breakfast-cereals', 'yogurts'],
    pagesPerCategory: 2, pageSize: 4, detailLimit: 2, sugarThreshold: 20 }, api);
  assert.equal(result.sourceRequests.searchCalls, 3);
  assert.equal(result.sourceRequests.productLookups, 2);
  assert.equal(result.observedUniqueProducts, 9);
  assert.equal(result.sampledOnly, false);
  assert.equal(result.categories[0].sampledProducts, 6);
  assert.equal(result.categories[0].pagesFetched, 2);
  assert.equal(result.categories[0].sugarGPer100g.measuredCount, 5);
  assert.equal(result.categories[0].sugarGPer100g.aboveThresholdCount, 2);
  assert.equal(result.categories[1].sampledProducts, 3);
  assert.equal(result.detailSamples[0].ingredientsPresent, true);
  assert.deepEqual(result.detailSamples[0].allergenTagExamples, ['en:gluten']);
  assert.deepEqual(calls.map(x => x.tool), [
    'off_search_products', 'off_search_products', 'off_search_products',
    'off_get_product', 'off_get_product',
  ]);
  // Match CODEBOUND worker: no undefined/functions, null prototypes,
  // NaN, sparse arrays, custom object prototypes, or oversized outputs.
  function assertPlain(value) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return; }
    assert.ok(typeof value === 'object');
    assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
    for (const item of Object.values(value)) assertPlain(item);
  }
  assertPlain(result);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
});

test('never treats a partial sampled page as a complete catalogue', async () => {
  const { api, calls } = mockApi({
    'breakfast-cereals': [
      { count: 200, page: 1, products: [
        makeProduct('1234567890123', null), makeProduct('1234567890124', 0),
        makeProduct('1234567890125', 15), makeProduct('1234567890126', 30),
      ] },
    ],
  });
  const result = await main({
    categories: ['breakfast-cereals'], pageSize: 4, pagesPerCategory: 1,
    detailLimit: 0,
  }, api);
  assert.equal(result.sampledOnly, true);
  assert.equal(result.categories[0].reportedCatalogueCount, 200);
  assert.equal(result.categories[0].completeCatalogue, false);
  assert.equal(result.categories[0].sugarGPer100g.missingCount, 1);
  assert.equal(result.categories[0].sugarGPer100g.measuredCount, 3);
  assert.equal(result.categories[0].sugarGPer100g.aboveThresholdCount, 1);
  assert.equal(calls.length, 1);
});

test('validates unbounded input locally before any connector calls', async () => {
  for (const invalid of [
    { pagesPerCategory: 20 }, { pageSize: 1000 }, { detailLimit: 50 },
    { sugarThreshold: -1 }, { categories: ['a', 'b', 'c'] },
    { categories: ['../../admin'] }, { categories: ['yogurts', 'yogurts'] },
    { categories: [] },
  ]) {
    const { api, calls } = mockApi({});
    await assert.rejects(main(invalid, api));
    assert.equal(calls.length, 0);
  }
});

test('malformed upstream search results fail closed', async () => {
  const { api, calls } = mockApi({ yogurts: [{ count: 1, products: {} }] });
  await assert.rejects(main({ categories: ['yogurts'], detailLimit: 0 }, api),
    /Malformed product search response/);
  assert.equal(calls.length, 1);
});
