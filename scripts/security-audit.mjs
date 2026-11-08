// SPDX-License-Identifier: AGPL-3.0-only
// Read-only dependency audit for all npm lockfiles shipped in this repository.
// npm audit uses the configured registry's advisory database; no fixes are
// applied automatically, and every finding remains reviewable in CI.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const checks = [
  { label: 'Application npm workspaces', directory: '.' },
  { label: 'Demo video director', directory: 'scripts/demo-video/director' },
  { label: 'Demo video mock API', directory: 'scripts/demo-video/mock-api' },
];
const levels = ['critical', 'high', 'moderate', 'low', 'info'];
const row = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ').slice(0, 250);
const all = [];
let failed = false;
for (const check of checks) {
  if (!existsSync(resolve(check.directory, 'package-lock.json'))) {
    console.error('Missing expected lockfile:', check.directory);
    failed = true;
    continue;
  }
  const audit = spawnSync('npm', ['audit', '--json', '--package-lock-only'], {
    cwd: resolve(check.directory), encoding: 'utf8', timeout: 120_000, maxBuffer: 24 * 1024 * 1024,
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  if (audit.error) {
    console.error('npm audit could not run for', check.directory, audit.error.message);
    failed = true;
    continue;
  }
  let result;
  try { result = JSON.parse(audit.stdout); }
  catch {
    console.error('npm audit returned no valid JSON for', check.directory,
      'exit:', audit.status, 'stderr:', audit.stderr.slice(0, 450));
    failed = true;
    continue;
  }
  if (!result.metadata?.vulnerabilities || !result.vulnerabilities || result.error) {
    console.error('npm audit failed to produce vulnerability results for', check.directory,
      'exit:', audit.status, 'error:', result.error?.code ?? 'unknown');
    failed = true;
    continue;
  }
  console.log('\n== ' + check.label + ' ==');
  console.log('Vulnerabilities:', JSON.stringify(result.metadata.vulnerabilities));
  const vulns = Object.entries(result.vulnerabilities)
    .map(([name, finding]) => ({ name, ...finding }))
    .sort((a, b) => levels.indexOf(a.severity) - levels.indexOf(b.severity) ||
      a.name.localeCompare(b.name));
  for (const v of vulns.slice(0, 80)) {
    const via = v.via?.filter(item => typeof item === 'object')
      .map(item => item.title || item.name).slice(0, 2).join(' / ') ?? '';
    const fix = typeof v.fixAvailable === 'object'
      ? 'requires ' + (v.fixAvailable.name ?? '?') + '@' + (v.fixAvailable.version ?? '?')
      : v.fixAvailable === true ? 'fix available' : 'no automatic fix';
    console.log('[' + v.severity + '] ' + v.name +
      ' (range ' + v.range + '; ' + fix + ') ' + via.slice(0, 180));
  }
  if (vulns.length > 80) console.log('... ' + (vulns.length - 80) + ' additional package findings');
  for (const v of vulns) all.push({ area: check.label, ...v });
  if ((result.metadata.vulnerabilities.critical ?? 0) + (result.metadata.vulnerabilities.high ?? 0) > 0) {
    failed = true;
  }
}
const counts = Object.fromEntries(levels.map(level => [level, all.filter(v => v.severity === level).length]));
console.log('\nTotal affected package entries by severity:', JSON.stringify(counts));
if (process.env.GITHUB_STEP_SUMMARY) {
  let markdown = '## npm lockfile security audit\n\n' +
    'This is a read-only npm advisory scan; GitHub CodeQL/Trivy findings are **separate**.\n\n' +
    '| Area | Dependency | Severity | Affected range | Fix |\n|---|---|---|---|---|\n';
  for (const v of all.slice(0, 150)) {
    const fix = typeof v.fixAvailable === 'object'
      ? (v.fixAvailable.name ?? '') + '@' + (v.fixAvailable.version ?? '')
      : v.fixAvailable ? 'available' : 'manual review';
    markdown += '| ' + row(v.area) + ' | ' + row(v.name) + ' | ' +
      row(v.severity) + ' | ' + row(v.range) + ' | ' + row(fix) + ' |\n';
  }
  if (!all.length) markdown += '| — | No npm advisory findings | — | — | — |\n';
  markdown += '\nHigh/critical results fail this check; no automatic changes are made.\n';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}
if (failed) process.exitCode = 1;
