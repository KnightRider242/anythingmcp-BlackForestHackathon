import { applyProcessorChain, validateProcessorChain } from './processor-chain.util';

const chain = {
  itemsField: 'items',
  steps: [
    { operation: 'multiply', input: 'price_usd', output: 'price_eur', factor: 0.92, decimals: 2, mode: 'add' },
    { operation: 'multiply', input: 'price_eur', output: 'price_eur_gross', factor: 1.19, decimals: 2, mode: 'add' },
    { operation: 'normalizeWhitespace', input: 'description', output: 'description', mode: 'replace' },
  ],
};

describe('CODEBOUND declarative processor chains', () => {
  const input = { items: [
    { itemNo: 'A-1', price_usd: 1.05, description: '  Black  Screw  ', moq: 5 },
    { itemNo: 'A-2', price_usd: 42.3, description: ' Steel   Plate ', moq: 10 },
  ], category: 'fasteners' };
  it('does nothing unless a chain is explicitly configured', () => {
    expect(applyProcessorChain(input, {})).toBe(input);
    expect(applyProcessorChain(input, undefined)).toBe(input);
  });
  it('applies each step in order with independent rounding and retains all other fields', () => {
    const result = applyProcessorChain(input, { processorChain: chain }) as typeof input;
    expect(result.category).toBe('fasteners');
    expect(result.items).toEqual([
      { itemNo: 'A-1', price_usd: 1.05, description: 'Black Screw', moq: 5, price_eur: 0.97, price_eur_gross: 1.15 },
      { itemNo: 'A-2', price_usd: 42.3, description: 'Steel Plate', moq: 10, price_eur: 38.92, price_eur_gross: 46.31 },
    ]);
    expect(input.items[0]).not.toHaveProperty('price_eur');
    expect(input.items[0].description).toBe('  Black  Screw  ');
  });
  it('fails atomically and names the offending field', () => {
    const broken = { items: [{ price_usd: 12, description: 'Okay' }, { price_usd: 'n/a', description: 'Bad' }] };
    expect(() => applyProcessorChain(broken, { processorChain: chain })).toThrow(/items\[1\]\.price_usd/);
    expect(broken.items[0]).not.toHaveProperty('price_eur');
  });
  it('rejects unsupported operations, unsafe paths, and invalid step modes', () => {
    expect(validateProcessorChain({ itemsField: 'items', steps: [{ operation: 'eval' }] })).toMatch(/operation/);
    expect(validateProcessorChain({ itemsField: '__proto__', steps: chain.steps })).toMatch(/safe field/);
    expect(validateProcessorChain({ ...chain, steps: [{ ...chain.steps[0], mode: 'upsert' }] })).toMatch(/mode/);
    expect(validateProcessorChain(chain)).toBeNull();
  });
  it('never exposes a half-processed array or silently returns raw on invalid prices', () => {
    expect(() => applyProcessorChain([{ price_usd: 'n/a', description: 'oops' }], { processorChain: chain }))
      .toThrow(/price_usd/);
  });
});
