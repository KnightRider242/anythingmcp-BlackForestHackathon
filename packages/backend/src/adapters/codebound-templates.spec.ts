// SPDX-License-Identifier: AGPL-3.0-only
import { getAdapter } from './catalog';
import { parseCodeboundTemplates } from './codebound-templates';
import { computeAdapterVersion } from './catalog-fingerprint';

describe('local CODEBOUND marketplace templates', () => {
  const adapter = () => JSON.parse(JSON.stringify(getAdapter('hackernews')!)) as NonNullable<ReturnType<typeof getAdapter>>;
  it('validates the real example without evaluating source', () => {
    expect(parseCodeboundTemplates(adapter())).toHaveLength(1);
    expect(parseCodeboundTemplates(getAdapter('openplz')!)).toEqual([]);
  });
  it.each(['missing-tool', 'write', 'disabled', 'proxy', 'unknown-field', 'oversize', 'multiple', 'external-engine'])('rejects %s', mode => {
    const a = adapter(); const template = a.codeboundScripts![0];
    if (mode === 'missing-tool') template.toolName = 'missing';
    if (mode === 'write') a.tools[0].endpointMapping.method = 'POST';
    if (mode === 'disabled') a.tools[0].enabled = false;
    if (mode === 'proxy') a.tools[0].useProxy = true;
    if (mode === 'unknown-field') (template as any).binding = { connectorId: 'forged' };
    if (mode === 'oversize') template.source = 'x'.repeat(32769);
    if (mode === 'multiple') a.codeboundScripts!.push(template);
    if (mode === 'external-engine') a.connector.type = 'MCP';
    expect(() => parseCodeboundTemplates(a)).toThrow();
  });
  it('includes source in catalog version without changing versions for non-script adapters', () => {
    const a = adapter(); const version = computeAdapterVersion(a);
    a.codeboundScripts![0].source += '\n'; expect(computeAdapterVersion(a)).not.toBe(version);
    delete a.codeboundScripts; const legacy = computeAdapterVersion(a);
    expect(computeAdapterVersion({ ...a, codeboundScripts: undefined })).toBe(legacy);
  });
});
