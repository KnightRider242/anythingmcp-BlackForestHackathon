// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesDeniedAudit, tempIsolationStatus } from './verify-codebound-f234-attacks.mjs';
const now = Date.now();
const scope = () => ({ beforeIds:new Set(['old']),organizationId:'B',userId:'bob',executionId:'execution',startedAt:now,now:now+100,toolId:'ping',serverId:'server-B' });
const audit = () => ({ id:'new',organizationId:'B',userId:'bob',status:'ERROR',error:'FORBIDDEN',createdAt:new Date(now).toISOString(),
  input:{executionId:'execution'},clientInfo:'codebound/execution',toolId:'ping',mcpServerId:'server-B' });
test('correlates denied execution to caller, workspace, tool, server and receipt',()=>assert.equal(matchesDeniedAudit(audit(),scope()),true));
for(const [label,replacement] of [
  ['old ID',{id:'old'}],['wrong workspace',{organizationId:'A'}],['wrong caller',{userId:'alice'}],['successful call',{status:'SUCCESS'}],
  ['unrelated error',{error:'UPSTREAM_TIMEOUT'}],['other execution',{input:{executionId:'other'}}],['wrong correlation',{clientInfo:'codebound/other'}],
  ['other tool',{toolId:'other'}],['other server',{mcpServerId:'other'}],['old timestamp',{createdAt:new Date(now-60_000).toISOString()}],
  ['future timestamp',{createdAt:new Date(now+60_000).toISOString()}],
]) test(`rejects ${label} as denial evidence`,()=>assert.equal(matchesDeniedAudit({...audit(),...replacement},scope()),false));
test('MCP role denial still requires fresh actor/tool/server scope without a script receipt',()=>{
  const roleScope={...scope(),userId:'carol',organizationId:'A',toolId:'payroll',serverId:'server-A',executionId:undefined};
  assert.equal(matchesDeniedAudit({...audit(),userId:'carol',organizationId:'A',toolId:'payroll',mcpServerId:'server-A'},roleScope),true);
  assert.equal(matchesDeniedAudit(audit(),roleScope),false);
});
test('A7 cannot pass when the read-only writer never created a file',()=>{
  assert.equal(tempIsolationStatus({wrote:false,verified:false},{readable:false,errorCode:'ENOENT'}),'NOT_TESTED');
});
test('A7 requires A readback and B ENOENT; EACCES is not absence',()=>{
  assert.equal(tempIsolationStatus({wrote:true,verified:true},{readable:false,errorCode:'ENOENT'}),'PASS');
  assert.equal(tempIsolationStatus({wrote:true,verified:false},{readable:false,errorCode:'ENOENT'}),'FAIL');
  assert.equal(tempIsolationStatus({wrote:true,verified:true},{readable:false,errorCode:'EACCES'}),'NOT_TESTED');
  assert.equal(tempIsolationStatus({wrote:true,verified:true},{readable:true}),'FAIL');
});
