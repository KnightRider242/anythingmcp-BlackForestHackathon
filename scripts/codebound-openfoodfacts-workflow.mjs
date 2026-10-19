// SPDX-License-Identifier: AGPL-3.0-only
// CODEBOUND real-data demo: two approved Open Food Facts GET tools.
// All work inside main() is self-contained so main.toString() can be saved as
// source and evaluated only by the existing isolated CODEBOUND Docker worker.
export const connector = {
  name: 'CODEBOUND Open Food Facts Public Catalogue',
  type: 'REST',
  baseUrl: 'https://world.openfoodfacts.org',
  isActive: true,
  authType: 'NONE',
  headers: {
    'User-Agent': 'CODEBOUND-Catalogue-Demo/0.1 (https://github.com/KnightRider242/anythingmcp-BlackForestHackathon)',
    'Accept': 'application/json',
  },
  tools: [
    {
      name: 'off_search_products',
      description: 'Read a limited page of real Open Food Facts products in one category. Structured tag search only.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          category: { type: 'string', description: 'English category slug, e.g. breakfast-cereals' },
          page: { type: 'integer', description: 'Page number starting from 1' },
          pageSize: { type: 'integer', description: 'Requested number of products, max 20 in CODEBOUND demo' },
        },
        required: ['category', 'page', 'pageSize'],
      },
      endpointMapping: {
        method: 'GET',
        path: '/api/v2/search',
        queryParams: {
          categories_tags_en: '$category', page: '$page', page_size: '$pageSize',
          fields: 'code,product_name,brands,nutriscore_grade,nova_group,nutriments,completeness',
          sort_by: 'popularity_key',
        },
      },
    },
    {
      name: 'off_get_product',
      description: 'Read real Open Food Facts product enrichment by barcode (selected fields only).',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { code: { type: 'string', description: 'Product barcode obtained from search' } },
        required: ['code'],
      },
      endpointMapping: {
        method: 'GET',
        path: '/api/v2/product/{code}.json',
        queryParams: {
          fields: 'code,product_name,ingredients_text,allergens_tags,labels_tags,quantity',
        },
      },
    },
  ],
};

export const defaults = Object.freeze({
  categories: ['breakfast-cereals', 'yogurts'],
  pagesPerCategory: 1,
  pageSize: 12,
  detailLimit: 2,
  sugarThreshold: 20,
});

export async function main(input, api) {
  // All validation is in the source as well: the MCP schema converter does
  // not yet enforce all nested/number JSON Schema constraints.
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Input must be an object');
  }
  const categories = input.categories === undefined ? ['breakfast-cereals', 'yogurts'] : input.categories;
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > 2 ||
      categories.some(category => typeof category !== 'string' || !/^[a-z][a-z0-9-]{2,39}$/.test(category)) ||
      new Set(categories).size !== categories.length) {
    throw new Error('Select one or two unique category slugs');
  }
  const numberIn = (key, fallback, min, max, integer = true) => {
    const value = input[key] === undefined ? fallback : input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (integer && !Number.isInteger(value)) || value < min || value > max) {
      throw new Error('Invalid ' + key);
    }
    return value;
  };
  const pagesPerCategory = numberIn('pagesPerCategory', 1, 1, 2);
  const pageSize = numberIn('pageSize', 12, 4, 20);
  const detailLimit = numberIn('detailLimit', 2, 0, 3);
  const sugarThreshold = numberIn('sugarThreshold', 20, 0, 100, false);

  const categorySummaries = [];
  const observed = [];
  let searchCalls = 0;
  let productLookups = 0;
  let skippedInvalidBarcodes = 0;
  for (const category of categories) {
    const rows = [];
    const seen = new Set();
    let totalMatching = null;
    let pagesFetched = 0;
    let sourcePageCount = 0;
    for (let page = 1; page <= pagesPerCategory; page++) {
      const result = await api.call('off_search_products', { category, page, pageSize });
      searchCalls++;
      if (!result || !Array.isArray(result.products) || result.products.length > pageSize) {
        throw new Error('Malformed product search response');
      }
      pagesFetched++;
      sourcePageCount += result.products.length;
      if (Number.isInteger(result.count) && result.count >= 0 && totalMatching === null) {
        totalMatching = result.count;
      }
      for (const product of result.products) {
        if (!product || typeof product !== 'object' || Array.isArray(product)) continue;
        const code = product.code;
        if (typeof code !== 'string' || !/^\d{8,14}$/.test(code)) {
          skippedInvalidBarcodes++;
          continue;
        }
        if (seen.has(code)) continue;
        seen.add(code);
        const sugars = product.nutriments && typeof product.nutriments === 'object'
          ? product.nutriments.sugars_100g : null;
        const sugar100g = typeof sugars === 'number' && Number.isFinite(sugars) &&
          sugars >= 0 && sugars <= 100 ? Math.round(sugars * 10) / 10 : null;
        const grade = typeof product.nutriscore_grade === 'string' &&
          /^[a-e]$/i.test(product.nutriscore_grade) ? product.nutriscore_grade.toLowerCase() : null;
        const nova = Number.isInteger(product.nova_group) &&
          product.nova_group >= 1 && product.nova_group <= 4 ? product.nova_group : null;
        rows.push({
          code,
          name: typeof product.product_name === 'string' ? product.product_name.slice(0, 90) : '',
          brand: typeof product.brands === 'string' ? product.brands.slice(0, 60) : '',
          sugar100g,
          nutriscoreGrade: grade,
          novaGroup: nova,
        });
      }
      // page_count is the number of items on this page, NOT the total pages.
      if (result.products.length < pageSize ||
          (totalMatching !== null && page * pageSize >= totalMatching)) break;
    }

    const known = rows.filter(row => row.sugar100g !== null);
    const sum = known.reduce((value, row) => value + row.sugar100g, 0);
    const gradeCounts = { a: 0, b: 0, c: 0, d: 0, e: 0, unknown: 0 };
    for (const row of rows) gradeCounts[row.nutriscoreGrade ?? 'unknown']++;
    categorySummaries.push({
      category,
      reportedCatalogueCount: totalMatching,
      sampledProducts: rows.length,
      pagesFetched,
      sourceRowsRead: sourcePageCount,
      completeCatalogue: totalMatching !== null && rows.length >= totalMatching,
      sugarGPer100g: {
        measuredCount: known.length,
        missingCount: rows.length - known.length,
        sampleAverage: known.length ? Math.round(sum / known.length * 10) / 10 : null,
        aboveThresholdCount: known.filter(row => row.sugar100g > sugarThreshold).length,
      },
      nutriscoreGradeCounts: gradeCounts,
    });
    observed.push(...rows.map(row => ({ ...row, category })));
  }

  const bySugar = observed.filter(row => row.sugar100g !== null)
    .sort((a, b) => b.sugar100g - a.sugar100g || a.code.localeCompare(b.code));
  const topSugarSamples = bySugar.slice(0, 5).map(row => ({
    code: row.code, name: row.name, category: row.category,
    sugarGPer100g: row.sugar100g, nutriscoreGrade: row.nutriscoreGrade,
  }));

  // Only enrich up to three distinct barcodes. Barcode reads are a different
  // approved tool and URL; the sandbox does not fetch anything directly.
  const candidates = [...bySugar, ...observed].filter((row, index, arr) =>
    arr.findIndex(other => other.code === row.code) === index);
  const detailSamples = [];
  for (const row of candidates.slice(0, detailLimit)) {
    const detail = await api.call('off_get_product', { code: row.code });
    productLookups++;
    if (!detail || typeof detail !== 'object' ||
        detail.status !== 1 || !detail.product || typeof detail.product !== 'object') {
      detailSamples.push({ code: row.code, found: false });
      continue;
    }
    const product = detail.product;
    if (typeof product.code === 'string' && product.code !== row.code) {
      throw new Error('Barcode mismatch in product detail');
    }
    const tags = key => Array.isArray(product[key])
      ? product[key].filter(value => typeof value === 'string').slice(0, 3).map(v => v.slice(0, 60))
      : [];
    detailSamples.push({
      code: row.code,
      found: true,
      ingredientsPresent: typeof product.ingredients_text === 'string' &&
        product.ingredients_text.trim().length > 0,
      allergenTagExamples: tags('allergens_tags'),
      labelTagExamples: tags('labels_tags'),
    });
  }

  return {
    source: 'Open Food Facts (ODbL) — https://world.openfoodfacts.org',
    analysis: 'Live sampled public product catalogue; not commercial pricing or medical advice',
    sampledOnly: categorySummaries.some(row => !row.completeCatalogue),
    categories: categorySummaries,
    observedUniqueProducts: new Set(observed.map(row => row.code)).size,
    skippedInvalidBarcodes,
    sourceRequests: { searchCalls, productLookups },
    sugarThresholdGPer100g: sugarThreshold,
    topSugarSamples,
    detailSamples,
    limitations: 'Sampling, crowd-sourced omissions, and product changes can affect results. Counts are not population estimates.',
  };
}

export const workflow = {
  name: 'openfoodfacts_catalogue_audit',
  description: 'Analyze a bounded real Open Food Facts sample across categories; paginate, compare nutrition coverage, and enrich barcodes via approved tools.',
  source: main.toString(),
  tools: connector.tools.map(tool => tool.name),
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      categories: {
        type: 'array', items: { type: 'string' }, maxItems: 2,
        description: 'One or two category slugs such as breakfast-cereals, yogurts',
      },
      pagesPerCategory: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
      pageSize: { type: 'integer', minimum: 4, maximum: 20, default: 12 },
      detailLimit: { type: 'integer', minimum: 0, maximum: 3, default: 2 },
      sugarThreshold: { type: 'number', minimum: 0, maximum: 100, default: 20 },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string' }, sampledOnly: { type: 'boolean' },
      categories: { type: 'array' }, topSugarSamples: { type: 'array' },
      detailSamples: { type: 'array' }, sourceRequests: { type: 'object' },
    },
  },
};
