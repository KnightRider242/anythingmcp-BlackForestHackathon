// SPDX-License-Identifier: AGPL-3.0-only
// Official card probes against the existing isolated kit. No setup/reset or secret changes.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

class VerificationFailure extends Error {}
const ensure = (condition, message) => { if (!condition) throw new VerificationFailure(message); };

/** Pre-existing, wrong-tenant, wrong-user and unrelated errors are not evidence. */
export function matchesDeniedAudit(row, scope) {
  const created = Date.parse(row.createdAt);
  return typeof row.id === 'string' && !scope.beforeIds.has(row.id) &&
    row.organizationId === scope.organizationId && row.userId === scope.userId && row.status === 'ERROR' &&
    Number.isFinite(created) && created >= scope.startedAt - 1000 && created <= scope.now + 1000 &&
    typeof row.error === 'string' && /FORBIDDEN|denied|not available|not authorized|permission/i.test(row.error) &&
    (!scope.executionId || (row.input?.executionId === scope.executionId && row.clientInfo === `codebound/${scope.executionId}`)) &&
    (!scope.toolId || row.toolId === scope.toolId) && (!scope.serverId || row.mcpServerId === scope.serverId);
}
/** Never award A7 for a missing file which A never successfully wrote/read. */
export function tempIsolationStatus(writer, reader) {
  if (!writer.wrote) return 'NOT_TESTED';
  if (!writer.verified || reader.readable) return 'FAIL';
  return reader.errorCode === 'ENOENT' ? 'PASS' : 'NOT_TESTED';
}

export async function main(filename) {
  ensure(filename, 'Usage: node scripts/verify-codebound-f234-attacks.mjs <kit-state.json>');
  const stateFile = resolve(filename);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  ensure(state.version === 1 && state.url === 'http://localhost:4001' && state.mode === 'host', 'Only the existing localhost:4001 host-mode kit is supported');
  ensure(state.workspaces?.A?.organizationId && state.workspaces?.B?.organizationId && state.workspaces.A.organizationId !== state.workspaces.B.organizationId, 'Expected distinct existing Alpha and Beta workspaces');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const kit = resolve(dirname(stateFile), '..');
  const team = JSON.parse(readFileSync(join(kit, 'codebound.team.json'), 'utf8'));
  ensure(team.postgres?.docker === 'codebound-kit-db' && team.postgres?.db === 'codeboundkit' && team.logs?.file, 'Expected isolated kit database and backend log configuration');
  const local = parseEnv(readFileSync(join(root, '.env.codebound.local'), 'utf8'));
  const database = new URL(local.DATABASE_URL);
  ensure(database.hostname === 'localhost' && database.port === '5434' && database.pathname === '/codeboundkit' && local.PORT === '4001', 'Refusing verification outside the isolated configuration');
  const cards = readFileSync(join(kit, 'cards/CARDS.md'), 'utf8');
  const { McpClient } = await import(pathToFileURL(join(kit, 'harness/mcp.mjs')).href);
  const runId = randomUUID();
  const evidenceDirectory = join(kit, '.codebound', 'attacks', runId);
  mkdirSync(evidenceDirectory, { recursive: true });
  const report = { runId, startedAt: new Date().toISOString(), backend: state.url,
    officialCardsSha256: createHash('sha256').update(cards).digest('hex'), cards: [], supplementary: [] };
  const temporaryScripts = new Map();
  const secrets = [...Object.values(state.canaries.connectors).flatMap(Object.values), state.canaries.hostEnv, local.CODEBOUND_HOST_CANARY, state.canaries.hostFile,
    ...Object.values(state.users).flatMap(user => [user.key, user.password])].filter(value => typeof value === 'string' && value.length > 0);
  function leakFree(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    ensure(!secrets.some(secret => [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]
      .some(variant => text.includes(variant))), 'A credential/canary appeared in verification data; contents withheld');
  }
  async function request(path, token, method = 'GET', body) {
    const response = await fetch(state.url + path, { method, signal: AbortSignal.timeout(50_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    ensure(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'Verification API response exceeded its cap');
    return { status: response.status, data: JSON.parse(text) };
  }
  async function admin(port, path) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
    ensure(response.ok, 'Mock admin read failed');
    return response.json();
  }
  ensure((await fetch(state.url + '/health')).ok, 'Isolated backend is not healthy');
  // /health is deliberately excluded by AppLoggerModule.autoLogging.ignore.
  const beforeLog = statSync(team.logs.file).size;
  await fetch(state.url + '/__codebound_verification_log_probe/' + runId);
  for (let attempt = 0; attempt < 10 && statSync(team.logs.file).size <= beforeLog; attempt++) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  ensure(statSync(team.logs.file).size > beforeLog, 'Configured S2 log is not receiving current backend requests');
  async function login(name) {
    const user = state.users[name];
    const response = await request('/api/auth/login', null, 'POST', { email: user.email, password: user.password });
    ensure(response.status === 200 && typeof response.data.accessToken === 'string', 'Existing kit login failed');
    ensure(typeof response.data.user?.id === 'string' && response.data.user.id.length > 0, 'Login supplied no verified audit identity');
    const workspace = name === 'bob' ? 'B' : 'A';
    ensure(response.data.user?.organizationId === state.workspaces[workspace].organizationId, 'Authenticated workspace differs from the kit state');
    const bindings = await request('/api/codebound/bindings', response.data.accessToken);
    ensure(bindings.data.ok && Array.isArray(bindings.data.value?.items) && !bindings.data.value.nextCursor, 'Cannot resolve bounded approved bindings');
    return { name, workspace, token: response.data.accessToken, userId: response.data.user.id, bindings: bindings.data.value.items };
  }
  const bob = await login('bob'); const alice = await login('alice'); const carol = await login('carol');
  const binding = (actor, name) => {
    const matches = actor.bindings.filter(item => item.toolName === name);
    ensure(matches.length === 1, 'Required approved binding is absent or ambiguous');
    return matches[0].binding;
  };
  async function scan(record) {
    try {
      const output = execFileSync(process.execPath, [join(kit, 'harness/cli.mjs'), 'check', '--card', 'S2'],
        { cwd: kit, encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
      leakFree(output); ensure(/✔ S2/.test(output), 'S2 was not reported as passing');
      // Include the actual configured host marker even if kit state is stale.
      leakFree(readFileSync(team.logs.file, 'utf8')); record.s2 = 'PASS';
    } catch { record.s2 = 'FAIL'; throw new VerificationFailure('S2 failed or could not run; raw scan output withheld'); }
  }
  async function runCard(id, title, actor, job, supplementary = false) {
    const record = { id, title, actor, coverage: 'LIVE', checks: [], evidence: [] };
    (supplementary ? report.supplementary : report.cards).push(record);
    const check = (condition, label) => { record.checks.push({ label, passed: !!condition }); ensure(condition, label); };
    try { await job(record, check); record.status ??= 'PASS'; }
    catch (error) { record.status = 'FAIL'; record.reason = error instanceof VerificationFailure ? error.message : 'Verification infrastructure error; details withheld to protect credentials'; }
    try { await scan(record); } catch (error) { record.status = 'FAIL'; record.reason = error.message; }
    console.log(`${id}: ${record.status}; S2 ${record.s2}`);
  }
  async function auditRows(actor, toolId) {
    const response = await request('/api/audit/invocations?limit=100&status=ERROR' + (toolId ? '&toolId=' + encodeURIComponent(toolId) : ''), actor.token);
    ensure(response.status === 200 && Array.isArray(response.data), 'Cannot read caller-workspace audit records');
    leakFree(response.data); return response.data;
  }
  async function deniedAudit(actor, scope) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const rows = await auditRows(actor, scope.toolId);
      const match = rows.find(row => matchesDeniedAudit(row, { ...scope, organizationId: state.workspaces[actor.workspace].organizationId,
        userId: actor.userId, now: Date.now() }));
      if (match) return { id: match.id, status: match.status, callerWorkspace: actor.workspace,
        minimalAuthorizationPayload: JSON.stringify(match.input)==='{}' && match.output==null &&
          match.error==='FORBIDDEN: Tool access denied' && match.clientInfo==='mcp/authorization' };
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
  }
  async function script(actor, label, source, input = {}, observe) {
    const nonce = randomUUID();
    const saved = await request('/api/codebound/scripts', actor.token, 'POST', { definition: {
      name: `security_probe_${label}_${nonce}`, description: 'Temporary official CODEBOUND attack probe',
      source: `async function main(input, api) { await api.read({nonce:input.nonce}); ${source} }`,
      inputSchema: { type: 'object' }, outputSchema: {}, binding: binding(actor, 'mock_erp_ping'),
    } });
    ensure(saved.status === 201 && saved.data.ok, 'Cannot create temporary owner-scoped script');
    const savedScript = saved.data.value; const startedAt = Date.now();
    temporaryScripts.set(savedScript.id, { actor, script: savedScript });
    try {
      const pending = request('/api/codebound/scripts/execute', actor.token, 'POST', {
        scriptId: savedScript.id, expectedRevision: savedScript.revision, input: { ...input, nonce },
      });
      // Settle both before deleting the saved script, even if inspection fails.
      const settled = await Promise.allSettled([pending, observe ? observe() : Promise.resolve()]);
      ensure(settled.every(item => item.status === 'fulfilled'), 'Execution or Docker isolation inspection failed');
      const response = settled[0].value;
      leakFree(response.data);
      ensure(response.status === 200 && response.data.ok && response.data.value?.executionId, 'Script execution produced no terminal receipt');
      const log = await admin(4180, '/__log');
      ensure(log.entries.some(entry => entry.service === 'erp' && entry.path === '/v1/ping' && entry.tenant === actor.workspace && entry.query?.nonce === nonce), 'Official priming ping is absent or from wrong workspace');
      return { result: response.data.value, nonce, startedAt, elapsedMs: Date.now() - startedAt };
    } finally {
      const removed = await request('/api/codebound/scripts/' + encodeURIComponent(savedScript.id), actor.token, 'DELETE', { expectedRevision: savedScript.revision });
      ensure(removed.status === 200 && removed.data.ok, 'Temporary script cleanup failed');
      temporaryScripts.delete(savedScript.id);
    }
  }
  function receipt(record, executed) {
    record.evidence.push({ executionId: executed.result.executionId, nonce: executed.nonce, elapsedMs: executed.elapsedMs,
      status: executed.result.status, connectorCalls: executed.result.metrics.connectorCalls });
  }
  const successful = (check, result) => check(result.status === 'succeeded', 'Probe completed inside Docker');
  async function recovery(record, check) {
    const recovered = await script(bob, 'recovery', 'return {alive:true};'); receipt(record, recovered);
    check(recovered.result.status === 'succeeded' && recovered.result.output?.alive === true, 'Next script works after resource failure');
    check((await fetch(state.url + '/health')).ok, 'Backend remains healthy');
  }
  for (const id of ['A1', 'A2']) await runCard(id, id === 'A1' ? 'Foreign Payroll by name' : 'Foreign Payroll by internal ID', 'bob', async (record, check) => {
    const beforeIds = new Set((await auditRows(bob)).map(row => row.id)); const before = await admin(4180, '/__health');
    const executed = await script(bob, id, 'return await api.call(input.target, {});', {
      target: id === 'A2' ? state.workspaces.A.toolIds.mock_payroll_list_salaries : 'mock_payroll_list_salaries',
    }); receipt(record, executed);
    check(executed.result.status === 'failed' && executed.result.error?.code === 'FORBIDDEN', 'Foreign selection refused');
    const log = await admin(4180, `/__log?since=${before.seq}`);
    check(!log.entries.some(entry => entry.service === 'payroll'), 'No Payroll request reaches mocks');
    const audit = await deniedAudit(bob, { beforeIds, startedAt: executed.startedAt, executionId: executed.result.executionId });
    check(!!audit, 'Fresh denial audit belongs to Bob, workspace B and this exact execution'); record.evidence.push({ denialAudit: audit });
  });
  await runCard('A3', 'Read unbound connector environment', 'bob', async (record, check) => {
    check(bob.bindings.some(item => item.toolName === 'mock_supplier_list_catalogue'), 'Unbound Supplier exists in Bob workspace');
    const executed = await script(bob, 'A3', `const names=['MOCK_SUPPLIER_API_KEY','MOCK_SUPPLIER_URL','MOCK_CARRIER_TOKEN','MOCK_CARRIER_URL','MOCK_PAYROLL_TOKEN','MOCK_PAYROLL_URL'];
      return {processHasUnboundNames:names.some(name=>Object.hasOwn(process.env,name)),apiHasEnv:Reflect.has(api,'env'),apiHasSecrets:Reflect.has(api,'secrets'),
        globalEnvPresent:typeof env!=='undefined'||typeof globalThis.env!=='undefined'};`);
    receipt(record, executed); successful(check, executed.result); const output = executed.result.output;
    check(output.processHasUnboundNames === false && output.apiHasEnv === false && output.apiHasSecrets === false && output.globalEnvPresent === false,
      'Unbound variables absent from process, API and script-global namespaces');
  });
  await runCard('A4', 'TCP connection to metadata 169.254.169.254', 'bob', async (record, check) => {
    const executed = await script(bob, 'A4', `return await new Promise(resolve=>{
      const socket=process.getBuiltinModule('net').createConnection({host:'169.254.169.254',port:80});
      let done=false;const finish=event=>{if(done)return;done=true;socket.destroy();resolve({connected:event==='connect',event});};
      socket.setTimeout(1000);socket.once('connect',()=>finish('connect'));socket.once('error',()=>finish('error'));socket.once('timeout',()=>finish('timeout'));
    });`); receipt(record, executed); successful(check, executed.result);
    check(executed.result.output.connected === false && ['error','timeout'].includes(executed.result.output.event), 'Numeric metadata IP TCP connection blocked');
  });
  await runCard('A5', 'Outside and unbound Carrier network access', 'bob', async (record, check) => {
    const mocks = await admin(4180, '/__whoami'); const outside = await admin(4181, '/__whoami');
    check(mocks.addresses.length > 0 && outside.addresses.length > 0, 'Actual container IPs available for DNS-independent probes');
    const before = await admin(4180, '/__health'); const outsideBefore = await admin(4181, '/__health');
    const targets = ['http://codebound-outside:4199', `http://${outside.addresses[0]}:4199`, `http://${mocks.addresses[0]}:4103`];
    const executed = await script(bob, 'A5', `const connected=[];for(const target of input.targets){let reached=false;
      try{await fetch(target+'/probe?nonce='+encodeURIComponent(input.nonce),{signal:AbortSignal.timeout(700)});reached=true;}catch{}connected.push(reached);}return {connected};`, { targets });
    receipt(record, executed); successful(check, executed.result);
    check(executed.result.output.connected.length === targets.length && executed.result.output.connected.every(value => value === false), 'ERP-only script cannot reach Outside or Carrier by DNS/IP');
    const log = await admin(4180, `/__log?since=${before.seq}`); const outsideLog = await admin(4181, `/__log?since=${outsideBefore.seq}`);
    check(!log.entries.some(entry => entry.service === 'carrier' && entry.query?.nonce === executed.nonce) && outsideLog.entries.length === 0, 'No probe arrives at Carrier or Outside');
  });
  await runCard('A6', 'Host environment and host /etc canary', 'bob', async (record, check) => {
    check(typeof state.canaries.hostFile === 'string' && state.canaries.hostFile.length > 0 && typeof local.CODEBOUND_HOST_CANARY === 'string' && local.CODEBOUND_HOST_CANARY.length > 0 &&
      readFileSync(state.canaries.hostFilePath,'utf8').includes(state.canaries.hostFile),
    'Positive host-file and configured host-environment canaries exist');
    record.evidence.push({ configuredHostCanaryMatchesKitState: local.CODEBOUND_HOST_CANARY === state.canaries.hostEnv,
      actualConfiguredHostCanaryAlsoIncludedInLeakChecks: true });
    const executed = await script(bob, 'A6', `const fs=process.getBuiltinModule('fs');const readable=path=>{try{fs.readFileSync(path);return true;}catch{return false;}};
      return {hostEnvPresent:typeof process.env.CODEBOUND_HOST_CANARY!=='undefined',hostPathReadable:readable(input.path),
        hostEtcCanaryReadable:readable('/etc/codebound-canary'),containerEtcReadable:readable('/etc/passwd')};`, { path: state.canaries.hostFilePath });
    receipt(record, executed); successful(check, executed.result);
    check(executed.result.output.hostEnvPresent === false && executed.result.output.hostPathReadable === false && executed.result.output.hostEtcCanaryReadable === false, 'Host canaries inaccessible');
    record.evidence.push({ mode: 'host backend; Docker worker', containerEtcIsNotHostEtc: executed.result.output.containerEtcReadable === true });
  });
  await runCard('A7', 'Write A temporary file, then read from B', 'alice then bob', async (record, check) => {
    const docker = (...args) => execFileSync('docker', args, {encoding:'utf8',timeout:5000,windowsHide:true,maxBuffer:128*1024}).trim();
    const ids = () => docker('ps','--all','--filter','label=codebound.sandbox=true','--format','{{.ID}}').split(/\r?\n/).filter(Boolean);
    check(ids().length === 0, 'No pre-existing sandbox containers obscure A7 isolation evidence');
    const inspected = [];
    const inspectPrivate = async () => {
      for (let attempt=0;attempt<80;attempt++) {
        const active=ids();
        if (active.length) {
          check(active.length === 1, 'Exactly one container belongs to this sequential execution');
          const [container] = JSON.parse(docker('inspect',active[0]));
          const host=container.HostConfig;
          check(host.ReadonlyRootfs && host.NetworkMode==='none' && !host.Privileged &&
            host.CapDrop.includes('ALL') && host.SecurityOpt.includes('no-new-privileges=true'), 'Actual Docker isolation unchanged');
          check(host.Tmpfs?.['/tmp']==='rw,noexec,nosuid,nodev,size=8388608,mode=0700,uid=65534,gid=65534', 'Private /tmp tmpfs has fixed size, owner and restrictions');
          check(!(host.Binds?.length) && !(host.VolumesFrom?.length) && !container.Config.Volumes &&
            container.Mounts.every(mount=>mount.Type==='tmpfs' && mount.Destination==='/tmp'), 'No bind mounts, volumes or shared filesystem storage');
          check(host.Memory>0 && host.Memory===host.MemorySwap && host.PidsLimit>0 && host.NanoCpus>0, 'Memory, swap, PID and CPU ceilings remain enforced');
          inspected.push(active[0]); return;
        }
        await new Promise(resolveWait=>setTimeout(resolveWait,100));
      }
      throw new VerificationFailure('No live A7 Docker container could be inspected');
    };
    const marker = randomUUID(); const basename = `codebound-A-${runId}`;
    const writer = await script(alice, 'A7_writer', `const fs=process.getBuiltinModule('fs');const attempts=[];
      for(const directory of ['/tmp','/var/tmp','/dev/shm']){const path=directory+'/'+input.basename;
        try{fs.writeFileSync(path,input.marker,{flag:'wx',mode:384});await new Promise(resolve=>setTimeout(resolve,1000));return {wrote:true,verified:fs.readFileSync(path,'utf8')===input.marker,path};}
        catch(error){attempts.push({directory,errorCode:['EROFS','EACCES','ENOENT'].includes(error.code)?error.code:'OTHER'});}}
      return {wrote:false,verified:false,path:null,attempts};`, { marker, basename }, inspectPrivate);
    receipt(record, writer); successful(check, writer.result); const written = writer.result.output;
    check(ids().length===0, 'A container and its volatile tmpfs removed before B');
    const reader = await script(bob, 'A7_reader', `try{process.getBuiltinModule('fs').readFileSync(input.path);return {readable:true};}
      catch(error){await new Promise(resolve=>setTimeout(resolve,1000));return {readable:false,errorCode:['ENOENT','EACCES','EROFS'].includes(error.code)?error.code:'OTHER'};}`, { path: written.path ?? '/tmp/' + basename }, inspectPrivate);
    receipt(record, reader); successful(check, reader.result);
    check(reader.result.output.readable === false, 'B cannot read the A probe path');
    record.evidence.push({ writerCreatedAndReadBack: written.wrote === true && written.verified === true, writerAttempts: written.attempts ?? [], readerError: reader.result.output.errorCode });
    record.status = tempIsolationStatus(written, reader.result.output);
    record.checks.push({ label: 'Official positive control: A successfully wrote and read back its file', passed: written.wrote === true && written.verified === true });
    check(inspected.length===2 && new Set(inspected).size===2 && ids().length===0, 'A and B use distinct disposable containers; neither container nor tmpfs remains');
    record.evidence.push({ distinctContainerIds:inspected, privateTmpfsBytes:8388608, sharedMounts:false, containersRemoved:true });
    if (record.status === 'NOT_TESTED') {
      record.coverage = 'LIVE ATTEMPT; POSITIVE CONTROL UNAVAILABLE';
      record.reason = 'A cannot create a temporary file on its read-only filesystem; B negative read alone cannot certify official A7';
    }
    else check(record.status === 'PASS', 'A positive write/readback is isolated from B, which sees ENOENT');
  });
  for (const [id, title, source, limit] of [
    ['A8','Infinite CPU loop','while (true) {}','wallTime'],
    ['A9','Exhaust container memory','const blocks=[];while(true)blocks.push(Buffer.alloc(8*1024*1024,1));','memory'],
    ['A10','One million connector calls','for(let i=0;i<1000000;i++)await api.read({nonce:input.nonce});return {};','connectorCalls'],
  ]) await runCard(id, title, 'bob', async (record, check) => {
    const executed = await script(bob, id, source); receipt(record, executed);
    check(executed.result.status === 'failed' && executed.result.error?.code === 'RESOURCE_LIMIT' && executed.result.error?.limit === limit, 'Resource attack stops at its declared limit');
    check(executed.elapsedMs <= 45_000 && executed.result.metrics.connectorCalls <= 128, 'Wall-clock cleanup and connector ceilings respected');
    if (id === 'A10') check(executed.result.metrics.connectorCalls === 128, 'One-million-call attempt stops at 128 actual calls');
    await recovery(record, check);
  });
  await runCard('A11', 'Carol Staff Payroll denial and required audit', 'carol', async (record, check) => {
    const target = state.workspaces.A.toolIds.mock_payroll_list_salaries;
    const beforeIds = new Set((await auditRows(alice, target)).map(row => row.id));
    const client = new McpClient(`${state.url}/mcp/${state.workspaces.A.serverId}`, state.users.carol.key);
    const tools = await client.listTools(); leakFree(tools);
    check(tools.some(tool => tool.name === 'mock_erp_ping') && !tools.some(tool => tool.name === 'mock_payroll_list_salaries'), 'Carol key valid; Payroll absent from her live role surface');
    const nonce = randomUUID(); const ping = await client.callTool('mock_erp_ping', { nonce }); leakFree(ping);
    check(ping.ok, 'Carol primes authenticated MCP with ERP ping');
    const before = await admin(4180, '/__health'); const startedAt = Date.now();
    const denied = await client.callTool('mock_payroll_list_salaries', {untrustedArgument:randomUUID()}); leakFree(denied);
    check(!denied.ok && !denied.timedOut, 'Payroll refused, not allowed or timed out');
    const log = await admin(4180, `/__log?since=${before.seq}`);
    check(!log.entries.some(entry => entry.service === 'payroll'), 'No Carol Payroll request reaches mock');
    const primingLog = await admin(4180, '/__log');
    check(primingLog.entries.some(entry => entry.service === 'erp' && entry.tenant === 'A' && entry.query?.nonce === nonce), 'Carol priming nonce present in Alpha log');
    const audit = await deniedAudit(carol, { beforeIds, startedAt, toolId: target, serverId: state.workspaces.A.serverId });
    record.evidence.push({ nonce, denied: true, upstreamPayrollRequests: 0, denialAuditPresent: !!audit });
    check(!!audit, 'Fresh Payroll denial audit belongs to Carol, A and the addressed server'); record.evidence.push({ denialAudit: audit });
    check(audit.minimalAuthorizationPayload, 'Audit omits caller arguments, output and restricted definitions; denial text is fixed');
    const repeatedAt=Date.now();
    const repeated=await client.callTool('mock_payroll_list_salaries', {untrustedArgument:randomUUID()}); leakFree(repeated);
    check(!repeated.ok && !repeated.timedOut, 'Repeated Payroll request also refused');
    const repeatAudit=await deniedAudit(carol,{beforeIds:new Set([...beforeIds,audit.id]),startedAt:repeatedAt,toolId:target,serverId:state.workspaces.A.serverId});
    check(!!repeatAudit && repeatAudit.minimalAuthorizationPayload, 'Repeated denial has its own fresh minimal audit, not a coalesced earlier row');
    const finalLog=await admin(4180,`/__log?since=${before.seq}`);
    check(!finalLog.entries.some(entry=>entry.service==='payroll'), 'Neither Payroll attempt reaches the mock');
    record.evidence.push({repeatDenialAudit:repeatAudit,upstreamPayrollRequests:0});
  });
  report.cards.push({ id:'A12',title:'Cloud Host-script creation/import/execution',actor:'not run',coverage:'UNSUPPORTED OPTIONAL FUNCTIONALITY',status:'NOT_APPLICABLE',
    reason:'Host scripts are not implemented; this is self-hosted. No Cloud 404 execution was performed.',checks:[] });
  report.cards.push({ id:'A13',title:'Print injected secret; mask output/log/audit with ***',actor:'not run',coverage:'UNSUPPORTED OPTIONAL FUNCTIONALITY',status:'UNSUPPORTED',
    reason:'F5/secret injection absent. No real credential injected to fake coverage. Echo-rejection tests and fixed errors are not A13 masking.',checks:[] });
  for (const [id, source, expected] of [
    ['stderr_env','console.error(JSON.stringify(process.env));return {hasHostCanary:!!process.env.CODEBOUND_HOST_CANARY};','succeeded'],
    ['stdout_env','console.log(process.env);return {};','failed'],
    ['thrown_env','throw new Error(JSON.stringify(process.env));','failed'],
  ]) await runCard(id, 'Supplementary environment/error logging probe', 'bob', async (record, check) => {
    const executed = await script(bob, id, source); receipt(record, executed);
    check(executed.result.status === expected && (expected === 'succeeded' ? executed.result.output.hasHostCanary === false : executed.result.error?.code === 'SCRIPT_ERROR'), 'Existing supplementary check still passes');
  }, true);
  await runCard('foreign_manifest', 'Reject foreign binding before persistence', 'bob', async (_record, check) => {
    const denied = await request('/api/codebound/scripts', bob.token, 'POST', { definition: { name:'foreign_manifest_probe',description:'',source:'async function main(){return {};}',
      inputSchema:{},outputSchema:{},binding:binding(alice,'mock_payroll_list_salaries') } });
    leakFree(denied.data); check(denied.status === 403, 'Foreign manifest refused');
  }, true);
  // Retry only this invocation's own probe IDs; never delete workflows or old probes.
  for (const [id, entry] of temporaryScripts) {
    try {
      const removed = await request('/api/codebound/scripts/' + encodeURIComponent(id), entry.actor.token, 'DELETE', { expectedRevision: entry.script.revision });
      if (removed.status === 200 && removed.data.ok) temporaryScripts.delete(id);
    } catch { /* The final report explicitly retains a cleanup failure. */ }
  }
  report.finishedAt = new Date().toISOString();
  report.limits = { connectorCalls:128,wallTimeMs:30_000,memoryBytes:128*1024*1024 };
  report.scope = { setupReset:false,backendChanged:false,credentialsChanged:false,temporaryScriptsRemoved:temporaryScripts.size === 0,
    remainingTemporaryScriptIds:[...temporaryScripts.keys()],a7PositiveWriteRequired:true,a11RequiresAudit:true };
  report.fixtureNotes = { configuredHostEnvironmentCanaryMatchesKitState: local.CODEBOUND_HOST_CANARY === state.canaries.hostEnv,
    hostMarkerPolicy: 'Use the existing nonempty configured host marker for the presence test; scan both it and the kit marker; change neither.' };
  report.followUp = 'Run official npm run check afterward; this attack report does not substitute for acceptance.';
  const output = JSON.stringify(report,null,2)+'\n'; leakFree(output);
  writeFileSync(join(evidenceDirectory,'report.json'),output);
  writeFileSync(join(kit,'.codebound/f234-attack-cards-latest.json'),output);
  const rows = [...report.cards,...report.supplementary].map(card=>`| ${card.id}: ${card.title} | ${card.actor} | ${card.status} | ${card.coverage} | ${card.reason ?? 'All recorded live assertions passed.'} |`).join('\n');
  const markdown = `# Official CODEBOUND attack-card verification\n\nRun: ${runId}. Backend: localhost:4001; existing database: localhost:5434/codeboundkit.\n\n`+
    `Definitions: official cards/CARDS.md, SHA-256 ${report.officialCardsSha256}. No kit/checker/mock code or setup changed.\n\n`+
    `| Card/probe | Actor | Result | Evidence type | Meaning / limitation |\n|---|---|---|---|---|\n${rows}\n\n`+
    `Failures are not converted to passes. A7 requires a successful write/readback in A before B's ENOENT counts. A1/A2 require fresh exact-execution denial audits in B. A11 requires a fresh Carol/A/Payroll/server denial audit. This verifier never writes audit rows.\n\n`+
    `Every executed script first calls mock_erp_ping with a nonce verified in the correct tenant's log. Carol primes her direct MCP call similarly. S2 runs after every executed card and supplementary probe. Private JSON records all assertions and sanitized evidence.\n\n`+
    `A6 uses positive host-file/configured host-environment canaries in host-backend mode. Configured host marker matches kit state: ${report.fixtureNotes.configuredHostEnvironmentCanaryMatchesKitState}. Both values are checked for leaks without printing or changing either. The worker's /etc/passwd is not host /etc. A Docker-backend /etc mount was not separately tested.\n\n`+
    `Automated coverage is distinct from these authenticated live card runs: packages/backend/src/codebound/sandbox/docker-sandbox-runner.live.spec.ts includes overlapping private-tmpfs containers, size exhaustion, Docker CPU/OOM/PID/network/host-canary/cleanup. mcp-server/mcp-denial-audit.spec.ts checks fixed payloads, fresh repeated audits and refusal before session routing. Gateway policy/echo tests use database/HTTP mocks. None certifies a Cloud Host-script run or injected-secret *** masking. Record actual suite runs separately below.\n\n`+
    `Evidence: ${join(evidenceDirectory,'report.json')}. Latest JSON: ${join(kit,'.codebound/f234-attack-cards-latest.json')}. Only sanitized metadata is written; credentials and raw response/error bodies are withheld. Temporary probe scripts removed: ${temporaryScripts.size === 0}. Cleanup uses revision-aware authenticated APIs; workflows, credentials and setup are preserved.\n\n`+
    `Run official acceptance afterward and record it below; optional F5 is separate from mandatory and scan scores.\n`;
  writeFileSync(join(root,'docs/codebound/ATTACK_CARD_VERIFICATION_REPORT.md'),markdown);
  console.log(`Per-card report written; temporary scripts removed: ${temporaryScripts.size === 0}; unsupported optional cards not claimed passing.`);
  return temporaryScripts.size || report.cards.some(card=>['FAIL','NOT_TESTED'].includes(card.status)) || report.supplementary.some(card=>card.status!=='PASS') ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(code=>{process.exitCode=code;}).catch(error=>{
    console.error(error instanceof VerificationFailure ? error.message : 'Attack verification infrastructure failed; details withheld to protect credentials'); process.exitCode=1;
  });
}
