// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { scriptDefinitionSchema } from '../codebound/contracts.validation';
import type { AdapterDefinition } from './catalog';

export const codeboundTemplateSchema = scriptDefinitionSchema.omit({ binding: true }).extend({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), toolName: z.string().min(1).max(128),
});
export type CodeboundTemplate = z.infer<typeof codeboundTemplateSchema>;

/** Local compiled catalog only; never interpolate credentials into source or schemas. */
export function parseCodeboundTemplates(adapter: AdapterDefinition): CodeboundTemplate[] {
  if (adapter.codeboundScripts === undefined) return [];
  const templates = z.array(codeboundTemplateSchema).min(1).max(1).parse(adapter.codeboundScripts);
  if (adapter.connector.type !== 'REST' || !adapter.connector.baseUrl.startsWith('https://') ||
      !['NONE', 'API_KEY', 'BEARER_TOKEN', 'BASIC_AUTH'].includes(adapter.connector.authType)) throw new Error('Unsupported script adapter');
  for (const template of templates) {
    const tools = adapter.tools.filter(tool => tool.name === template.toolName);
    if (tools.length !== 1 || tools[0].enabled === false || tools[0].useProxy === true ||
        tools[0].endpointMapping?.method !== 'GET') throw new Error('Invalid script tool reference');
  }
  return templates;
}
