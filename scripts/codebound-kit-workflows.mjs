// SPDX-License-Identifier: AGPL-3.0-only
// Sources are stored through authenticated management APIs and run ONLY in Docker.
export const workflows = [
  {
    name: 'price_drift_check',
    description: 'Compare all active ERP purchase prices with batched supplier prices.',
    tools: ['mock_erp_list_articles', 'mock_supplier_get_prices'],
    outputSchema: { type: 'array', items: { type: 'object' } },
    source: `async function main(input, api) {
  const articles = [];
  let complete = false;
  for (let page = 1; page <= 64; page++) {
    const result = await api.call('mock_erp_list_articles', {status:'active', page, pageSize:100});
    if (!Array.isArray(result.items) || !Number.isInteger(result.totalPages) || result.totalPages < 0) throw new Error('Invalid article page');
    articles.push(...result.items);
    if (page >= result.totalPages) { complete = true; break; }
  }
  if (!complete) throw new Error('Article page limit reached');
  const prices = Object.create(null);
  for (let offset = 0; offset < articles.length; offset += 100) {
    const batch = articles.slice(offset, offset + 100).map(article => article.sku);
    const result = await api.call('mock_supplier_get_prices', {skus:batch});
    if (!result.prices || typeof result.prices !== 'object' || Array.isArray(result.prices)) throw new Error('Invalid prices');
    for (const sku of batch) if (Object.hasOwn(result.prices, sku)) prices[sku] = result.prices[sku];
  }
  return articles.filter(article => Object.hasOwn(prices, article.sku)).map(article => {
    const purchasePrice = article.purchasePrice;
    const supplierPrice = prices[article.sku];
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0 || !Number.isFinite(supplierPrice)) throw new Error('Invalid price');
    const driftPct = Math.round(((supplierPrice - purchasePrice) / purchasePrice) * 1000) / 10;
    return {sku:article.sku, purchasePrice, supplierPrice, driftPct};
  }).filter(row => row.driftPct > input.threshold).sort((a,b) => b.driftPct - a.driftPct);
}`,
  },
  {
    name: 'catalogue_total',
    description: 'Count supplier catalogue pages until an empty page; report service failures as incomplete.',
    tools: ['mock_supplier_list_catalogue'],
    outputSchema: { type: 'object', properties: { category: { type: 'string' }, total: { type: 'integer' }, complete: { type: 'boolean' } },
      required: ['category', 'total', 'complete'], additionalProperties: false },
    source: `async function main(input, api) {
  let total = 0;
  for (let page = 1; page <= 100; page++) {
    let result;
    try { result = await api.call('mock_supplier_list_catalogue', {category:input.category, page}); }
    catch (error) {
      if (error.code !== 'CONNECTOR_ERROR') throw error;
      return {category:input.category, total, complete:false};
    }
    if (!Array.isArray(result.items)) throw new Error('Invalid catalogue page');
    if (result.items.length === 0) return {category:input.category, total, complete:true};
    total += result.items.length;
  }
  return {category:input.category, total, complete:false};
}`,
  },
  {
    name: 'stuck_orders',
    description: 'Join all shipped ERP orders with carrier scans, relative to the supplied reference time.',
    tools: ['mock_erp_list_orders', 'mock_carrier_get_tracking'],
    outputSchema: { type: 'array', items: { type: 'object' } },
    source: `async function main(input, api) {
  const cutoff = Date.parse(input.as_of) - input.days * 86400000;
  if (!Number.isFinite(cutoff) || input.days < 0) throw new Error('Invalid reference time');
  const rows = [];
  let complete = false;
  for (let page = 1; page <= 32; page++) {
    const result = await api.call('mock_erp_list_orders', {status:'shipped', page, pageSize:50});
    if (!Array.isArray(result.items) || !Number.isInteger(result.totalPages) || result.totalPages < 0) throw new Error('Invalid order page');
    for (const order of result.items) {
      if (order.status !== 'shipped' || typeof order.trackingNo !== 'string') throw new Error('Invalid shipped order');
      const parcel = await api.call('mock_carrier_get_tracking', {tracking_no:order.trackingNo});
      const scan = Date.parse(parcel.lastScanAt);
      if (!Number.isFinite(scan) || typeof parcel.status !== 'string') throw new Error('Invalid tracking response');
      if (parcel.status !== 'delivered' && scan < cutoff) rows.push({orderNo:order.orderNo,
        trackingNo:order.trackingNo, status:parcel.status, lastScanAt:parcel.lastScanAt});
    }
    if (page >= result.totalPages) { complete = true; break; }
  }
  if (!complete) throw new Error('Order page limit reached');
  return rows.sort((a,b) => Date.parse(a.lastScanAt) - Date.parse(b.lastScanAt));
}`,
  },
];
