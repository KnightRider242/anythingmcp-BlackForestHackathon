// SPDX-License-Identifier: AGPL-3.0-only
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AxiosError } from 'axios';
import { outboundRequest } from '../../common/outbound-http';
import { createSsrfGuardedAgents } from '../../common/ssrf.util';
import { ConnectorsService } from '../../connectors/connectors.service';
import { interpolateDeep, interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { buildCallerContextVars, CALLER_CONTEXT_PREFIX } from '../../common/caller-context.util';
import { assertNoUnresolvedPlaceholders } from '../../common/unresolved-placeholders.util';
import { jsonSchemaToZodShape, stripEnvVarParams } from '../../mcp-server/tool-schema.util';
import { findSecretLiterals, isCredentialHeaderName, isSecretQueryName } from '../../common/secret-literals.util';
import { supervisorConnectorReplySchema } from '../contracts.validation';
import type { ConnectorCallControls, ExecutionPrincipal, JsonObject, JsonValue } from '../contracts';
import type { BoundReadTool } from './bound-read-authorization.service';

const mappingSchema = z.strictObject({
  method: z.literal('GET'), path: z.string().startsWith('/'),
  queryParams: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).optional(),
  headers: z.record(z.string(), z.string()).optional(), encodePathParams: z.boolean().optional(),
});

export class ConnectorResponseLimitError extends Error {}

/** Whole headers alone miss tokens returned without their scheme or cookie name. */
function headerSecrets(name: string, value: string): string[] {
  const trimmed = value.trim();
  const knownScheme = /^(Bearer|Basic|Token|Bot|ApiKey|Api-Key|Key|OAuth|SSWS|Digest)\s+/i.test(trimmed);
  if (!knownScheme && !isCredentialHeaderName(name)) return [];
  const secrets: string[] = [];
  const scheme = /^\S+\s+(.+)$/.exec(trimmed);
  if (scheme) secrets.push(scheme[1]);
  if (/^Basic\s+/i.test(trimmed)) {
    const decoded = Buffer.from(scheme?.[1] ?? '', 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    secrets.push(decoded);
    if (colon >= 0) secrets.push(decoded.slice(0, colon), decoded.slice(colon + 1));
  }
  if (name.toLowerCase() === 'cookie') {
    for (const pair of value.split(';')) {
      const equals = pair.indexOf('=');
      if (equals >= 0) secrets.push(pair.slice(equals + 1).trim());
    }
  }
  return secrets;
}

@Injectable()
export class BoundRestExecutor {
  constructor(private readonly connectors: ConnectorsService) {}

  async execute(tool: BoundReadTool, input: JsonObject, principal: ExecutionPrincipal, controls: ConnectorCallControls): Promise<JsonValue> {
    controls.signal.throwIfAborted();
    const connector = tool.connector;
    if (connector.type !== 'REST' || tool.useProxy) throw new Error('Unsupported connector');
    const env = (connector.envVars ?? {}) as Record<string, string>;
    const vars = { ...env, ...buildCallerContextVars({
      userId: principal.userId, organizationId: principal.organizationId,
      mcpServerId: principal.origin.kind === 'mcp' ? principal.origin.serverId : undefined, authMethod: 'jwt',
    }) };
    const schema = stripEnvVarParams(tool.parameters as Record<string, unknown>, env);
    const args = z.strictObject(jsonSchemaToZodShape(schema)).parse(input);
    const resolved = interpolateConnectorConfig({ baseUrl: connector.baseUrl,
      headers: (connector.headers ?? {}) as Record<string, string> },
    mappingSchema.parse(tool.endpointMapping), vars, { reservedPrefix: CALLER_CONTEXT_PREFIX });
    // The shared interpolator adds undefined body fields; an actual body stays forbidden.
    const mapping = mappingSchema.parse(Object.fromEntries(Object.entries(resolved.endpointMapping).filter(([, value]) => value !== undefined)));
    if (mapping.path.startsWith('//') || /[\\?#%]/.test(mapping.path) || mapping.path.split('/').includes('..')) throw new Error('Invalid path');
    const values = { ...env, ...args };
    const path = mapping.path.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
      const value = values[key];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid path parameter');
      if (!/^[A-Za-z0-9_-]+$/.test(String(value))) throw new Error('Invalid path parameter');
      return encodeURIComponent(String(value));
    });
    const base = new URL(resolved.config.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('HTTPS connector required');
    const url = new URL(base.href.replace(/\/$/, '') + path);
    if (url.origin !== base.origin) throw new Error('Invalid destination');
    const headers = { ...resolved.config.headers, ...mapping.headers };
    // Sandbox arguments never choose headers, credentials or destinations.
    if (Object.values(headers).some(v => typeof v !== 'string' || v.includes('$'))) throw new Error('Dynamic headers unsupported');
    const auth = interpolateDeep(this.connectors.getDecryptedAuthConfig(connector) ?? {}, vars, { reservedPrefix: CALLER_CONTEXT_PREFIX });
    switch (connector.authType) {
      case 'NONE': break;
      case 'BEARER_TOKEN':
        if (typeof auth.token !== 'string' || !auth.token) throw new Error('Missing credential');
        headers.Authorization = `Bearer ${auth.token}`; break;
      case 'API_KEY':
        if (typeof auth.apiKey !== 'string' || !auth.apiKey || typeof auth.headerName !== 'string') throw new Error('Missing credential');
        headers[auth.headerName] = auth.apiKey; break;
      case 'BASIC_AUTH':
        if (typeof auth.username !== 'string' || typeof auth.password !== 'string') throw new Error('Missing credential');
        headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`; break;
      default: throw new Error('Unsupported authentication');
    }
    const params: Record<string, unknown> = {};
    for (const [key, template] of Object.entries(mapping.queryParams ?? {})) {
      const value = typeof template === 'string' && template.startsWith('$') ? values[template.slice(1)] : template;
      if (key.toLowerCase() === '_method' || (value !== undefined && value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('Unsupported query mapping');
      params[key] = value;
    }
    if (Object.keys(headers).some(key => ['x-http-method-override', 'x-http-method', 'x-method-override'].includes(key.toLowerCase()))) throw new Error('Method override forbidden');
    assertNoUnresolvedPlaceholders({ baseUrl: url.href, headers, authConfig: auth, queryParams: params });
    controls.signal.throwIfAborted();
    const remaining = controls.deadlineEpochMs - Date.now();
    if (remaining <= 0) throw new Error('Deadline expired');
    // The shared lookup exempts operator proxy hostnames. This request never
    // uses a proxy, so its connect-time guard must not inherit that exemption.
    const directEnv = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete directEnv[key];
    const agents = createSsrfGuardedAgents(directEnv);
    const response = await outboundRequest({
      ...agents,
      method: 'GET', url: url.href, params, headers, signal: controls.signal,
      timeout: remaining, maxContentLength: controls.maxResponseBytes,
      maxBodyLength: 0, responseType: 'json', proxy: false,
      transitional: { silentJSONParsing: false }, validateStatus: status => status >= 200 && status < 300,
    }, { maxRedirects: 0, credentialHeaders: Object.keys(headers) }).catch((error: unknown) => {
      if (error instanceof AxiosError && error.code === 'ERR_BAD_RESPONSE' && /^maxContentLength size of \d+ exceeded$/.test(error.message)) {
        throw new ConnectorResponseLimitError();
      }
      throw error;
    }).finally(() => { agents.httpAgent.destroy(); agents.httpsAgent.destroy(); });
    // Validate plain bounded JSON BEFORE walking it for secret exposure.
    const reply = supervisorConnectorReplySchema.parse({ type: 'connector.reply', requestId: 'validated', ok: true, value: response.data });
    if (!reply.ok) throw new Error('Invalid response');
    const serialized = JSON.stringify(reply.value);
    if (Buffer.byteLength(serialized) > controls.maxResponseBytes) throw new ConnectorResponseLimitError();
    // Fail closed on credential echoes, including object keys and short secrets.
    const secrets = [...Object.values(env), ...Object.values(headers), ...Object.values(auth),
      ...Object.entries(headers).flatMap(([name, value]) => headerSecrets(name, value)),
      ...Object.entries(params).filter(([name]) => isSecretQueryName(name)).map(([, value]) => String(value ?? '')),
      // The scanner masks brace-delimited placeholders; passing a JSON wrapper
      // would mask nested headers/params rather than inspect their literals.
      ...findSecretLiterals(url.href).map(finding => finding.value)]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]);
    if (secrets.some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw new Error('Credential echo');
    return reply.value;
  }
}
