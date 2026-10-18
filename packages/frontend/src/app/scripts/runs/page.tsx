'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, CheckCircle2, Clock3, Database, Lightbulb, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { useAuth } from '@/lib/auth-context';
import { codebound, type CodeboundRunReceipt } from '@/lib/api';

function size(bytes: number): string {
  if (bytes < 1024) return bytes.toLocaleString() + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
}
function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not finished';
}
function rate(received: number, avoided: number): string {
  return received > 0 ? (100 * avoided / received).toFixed(1) + '%' : 'N/A';
}
function avoidedBytes(run: CodeboundRunReceipt): number {
  // Never count unsuccessful runs as savings or claim that this measures LLM tokens.
  return run.status === 'SUCCEEDED' ? Math.max(0, run.connectorResponseBytes - run.outputBytes) : 0;
}
function helpFor(code: string | null): string {
  switch (code) {
    case 'FORBIDDEN': return 'Connector access was denied. Check the script owner, live permissions and approved connector fingerprints.';
    case 'RESOURCE_LIMIT': return 'The execution reached a resource limit. Reduce requested pages, calls or output size before retrying.';
    case 'CONNECTOR_ERROR': return 'A connected service failed. Check the upstream service and retry when it is healthy.';
    case 'SANDBOX_UNAVAILABLE': return 'The isolated worker was unavailable. Check Docker, worker capacity and the sandbox image.';
    case 'VERSION_CONFLICT': return 'The script revision changed. Reload the latest version before executing again.';
    case 'SCRIPT_ERROR': return 'The script failed. Review its logic and the approved tool response formats.';
    case 'CANCELLED': return 'The execution was cancelled or interrupted.';
    default: return 'Inspect the error code and backend audit events. Sensitive inputs and upstream responses are intentionally not stored here.';
  }
}
function Status({ status }: { status: CodeboundRunReceipt['status'] }) {
  if (status === 'SUCCEEDED') return <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={15} /> Succeeded</span>;
  if (status === 'RUNNING') return <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400"><Clock3 size={15} /> Running</span>;
  return <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400"><XCircle size={15} /> {status === 'FAILED' ? 'Failed' : 'Cancelled'}</span>;
}
function Stat({ title, value, note, icon }: { title: string; value: string; note: string; icon: React.ReactNode }) {
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
    <div className="flex items-center justify-between text-xs text-[var(--text-2)]"><span>{title}</span>{icon}</div>
    <div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div>
    <p className="mt-1 text-xs text-[var(--text-3)]">{note}</p>
  </div>;
}

export default function CodeboundRunsPage() {
  const { token, user, isLoading } = useAuth();
  return <AppShell title="CODEBOUND Runs & Insights" subtitle="Private execution receipts · data reduction · rule-based diagnostics">
    <nav aria-label="CODEBOUND" className="mb-5 flex gap-2 text-sm">
      <Link href="/scripts" className="rounded-lg border border-[var(--border)] px-4 py-2 hover:bg-[var(--surface-2)]">Scripts</Link>
      <span aria-current="page" className="rounded-lg bg-[var(--surface-2)] px-4 py-2 font-semibold">Runs & insights</span>
    </nav>
    {isLoading ? <p>Loading session…</p> : token && user
      ? <RunsManager key={token + ':' + user.id + ':' + user.organizationId} token={token} />
      : <p>Sign in to view your execution history.</p>}
  </AppShell>;
}

function RunsManager({ token }: { token: string }) {
  const [runs, setRuns] = useState<CodeboundRunReceipt[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('ALL');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    codebound.runs(token).then(page => {
      if (!active) return;
      setRuns(page.items); setCursor(page.nextCursor); setSelectedId(page.items[0]?.executionId ?? null);
    }).catch(() => { if (active) setError('Unable to load execution receipts. Check your session and backend.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  async function refresh() {
    setBusy(true); setError('');
    try {
      const page = await codebound.runs(token);
      setRuns(page.items); setCursor(page.nextCursor);
      setSelectedId(old => page.items.some(run => run.executionId === old) ? old : page.items[0]?.executionId ?? null);
    } catch { setError('Could not refresh runs. Please retry.'); }
    finally { setBusy(false); }
  }
  async function more() {
    if (!cursor || busy) return;
    setBusy(true); setError('');
    try {
      const page = await codebound.runs(token, cursor);
      setRuns(old => [...old, ...page.items.filter(run => !old.some(existing => existing.executionId === run.executionId))]);
      setCursor(page.nextCursor);
    } catch { setError('Could not load older runs. Please retry.'); }
    finally { setBusy(false); }
  }

  const summary = useMemo(() => {
    const successes = runs.filter(run => run.status === 'SUCCEEDED');
    const received = successes.reduce((total, run) => total + run.connectorResponseBytes, 0);
    const returned = successes.reduce((total, run) => total + run.outputBytes, 0);
    const avoided = successes.reduce((total, run) => total + avoidedBytes(run), 0);
    return {
      successes: successes.length,
      failures: runs.filter(run => run.status === 'FAILED').length,
      received, returned, avoided,
      duration: successes.length ? successes.reduce((total, run) => total + run.wallTimeMs, 0) / successes.length : 0,
    };
  }, [runs]);

  const visible = useMemo(() => runs.filter(run => (
    (filter === 'ALL' || run.status === filter) &&
    ((run.scriptName ?? 'Deleted script').toLowerCase().includes(query.toLowerCase()) ||
      run.executionId.toLowerCase().includes(query.toLowerCase()))
  )), [runs, filter, query]);
  const selected = runs.find(run => run.executionId === selectedId) ?? null;

  const insights = useMemo(() => {
    const messages: { title: string; detail: string }[] = [];
    const forbidden = runs.filter(run => run.errorCode === 'FORBIDDEN').length;
    const limited = runs.filter(run => run.errorCode === 'RESOURCE_LIMIT').length;
    const slow = runs.filter(run => run.status === 'SUCCEEDED' && run.wallTimeMs > 20000).length;
    if (forbidden) messages.push({ title: 'Review connector permissions', detail: forbidden + ' loaded run(s) were denied. Check changed bindings and membership before retrying.' });
    if (limited) messages.push({ title: 'Reduce work per execution', detail: limited + ' loaded run(s) reached resource limits. Consider smaller pages or fewer tool calls.' });
    if (slow) messages.push({ title: 'Approaching the execution deadline', detail: slow + ' successful run(s) took more than 20 seconds of the 30-second budget.' });
    if (summary.received > 0 && summary.avoided / summary.received > 0.8) messages.push({
      title: 'Strong payload reduction', detail: 'Successful workflows reduced received connector data by ' + rate(summary.received, summary.avoided) + ' before returning results.'
    });
    if (!messages.length) messages.push({ title: 'No obvious issues in loaded receipts', detail: 'Run more workflows to build execution history and surface automatic recommendations.' });
    return messages;
  }, [runs, summary]);

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">Execution overview</h2>
        <p className="text-xs text-[var(--text-3)]">Metrics cover {runs.length} loaded run(s), not all-time usage.</p>
      </div>
      <button type="button" disabled={busy || loading} onClick={refresh}
        className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--surface-2)] disabled:opacity-50">
        <RefreshCw size={15} /> Refresh
      </button>
    </div>
    {error && <p role="alert" className="rounded-lg border border-[var(--danger)] p-3 text-sm">{error}</p>}
    {loading ? <p role="status">Loading run history…</p> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat title="Successful runs" value={String(summary.successes)} note={summary.failures + ' failed in loaded history'} icon={<CheckCircle2 size={17} />} />
        <Stat title="Connector data received" value={size(summary.received)} note="Across successful executions" icon={<Database size={17} />} />
        <Stat title="Results returned" value={size(summary.returned)} note="Final JSON payload bytes" icon={<ArrowDownRight size={17} />} />
        <Stat title="Potential payload reduction" value={rate(summary.received, summary.avoided)} note={size(summary.avoided) + ' fewer bytes than raw connector responses'} icon={<Activity size={17} />} />
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Data efficiency</h3>
          <span className="text-xs text-[var(--text-3)]">Average successful run: {Math.round(summary.duration).toLocaleString()} ms</span>
        </div>
        <p className="mt-1 text-xs text-[var(--text-3)]">Comparison of connector response bytes and returned output bytes for the loaded successful executions.</p>
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <div className="mb-1 flex justify-between"><span>Connector responses</span><span>{size(summary.received)}</span></div>
            <div className="h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: summary.received ? '100%' : '0%' }} />
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between"><span>Workflow outputs</span><span>{size(summary.returned)}</span></div>
            <div className="h-3 overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: summary.received ? String(Math.min(100, 100 * summary.returned / summary.received)) + '%' : '0%' }} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-[var(--text-3)]">
          This is potential payload reduction, not measured LLM token, cost or latency savings.
          The bytes were still transferred from the enterprise APIs to the trusted connector gateway.
        </p>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Workflow runs</h3>
            <div className="flex flex-wrap gap-2">
              <input aria-label="Search runs" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search workflow"
                className="w-36 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs" />
              <select aria-label="Filter runs by status" value={filter} onChange={event => setFilter(event.target.value)}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-xs">
                <option value="ALL">All statuses</option><option value="SUCCEEDED">Succeeded</option><option value="FAILED">Failed</option>
                <option value="RUNNING">Running</option><option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>
          <div className="mt-3 divide-y divide-[var(--border)]">
            {visible.map(run => <button key={run.executionId} type="button" onClick={() => setSelectedId(run.executionId)}
              aria-pressed={selectedId === run.executionId}
              className={'w-full px-2 py-3 text-left hover:bg-[var(--surface-2)] ' + (selectedId === run.executionId ? 'rounded-md bg-[var(--surface-2)]' : '')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{run.scriptName ?? 'Deleted script'}</span>
                <span className="text-xs"><Status status={run.status} /></span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-3)]">
                <span>Revision {run.revision}</span><span>{when(run.startedAt)}</span>
                <span>{run.status === 'SUCCEEDED' ? size(avoidedBytes(run)) + ' potential reduction' : (run.errorCode ?? 'In progress')}</span>
              </div>
            </button>)}
            {!visible.length && <p className="py-8 text-center text-sm text-[var(--text-3)]">No runs match your filters.</p>}
          </div>
          {cursor && <button type="button" disabled={busy} onClick={more}
            className="mt-3 w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--surface-2)] disabled:opacity-50">
            {busy ? 'Loading…' : 'Load older runs'}
          </button>}
        </section>

        <section className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-semibold">Run details</h3>
          {selected ? <div className="mt-4 space-y-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{selected.scriptName ?? 'Deleted script'}</span>
              <Status status={selected.status} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div><dt className="text-[var(--text-3)]">Revision</dt><dd className="mt-1 font-medium">{selected.revision}</dd></div>
              <div><dt className="text-[var(--text-3)]">Duration</dt><dd className="mt-1 font-medium">{Math.round(selected.wallTimeMs).toLocaleString()} ms</dd></div>
              <div><dt className="text-[var(--text-3)]">Started</dt><dd className="mt-1">{when(selected.startedAt)}</dd></div>
              <div><dt className="text-[var(--text-3)]">Finished</dt><dd className="mt-1">{when(selected.finishedAt)}</dd></div>
              <div><dt className="text-[var(--text-3)]">Connector calls</dt><dd className="mt-1 font-medium">{selected.connectorCalls}</dd></div>
              <div><dt className="text-[var(--text-3)]">Response bytes</dt><dd className="mt-1 font-medium">{size(selected.connectorResponseBytes)}</dd></div>
              <div><dt className="text-[var(--text-3)]">Output bytes</dt><dd className="mt-1 font-medium">{size(selected.outputBytes)}</dd></div>
              <div><dt className="text-[var(--text-3)]">Potential reduction</dt><dd className="mt-1 font-medium">{selected.status === 'SUCCEEDED' ? rate(selected.connectorResponseBytes, avoidedBytes(selected)) : 'N/A'}</dd></div>
            </dl>
            <div className="rounded-lg bg-[var(--surface-2)] p-3 text-xs">
              <p className="mb-2 font-semibold">Execution receipt</p>
              <div className="flex items-center gap-2"><CheckCircle2 size={14} /> Run created</div>
              <div className="my-1 ml-1.5 h-3 border-l border-[var(--border-strong)]" />
              <div className="flex items-center gap-2"><Activity size={14} /> {selected.connectorCalls} connector requests recorded</div>
              <div className="my-1 ml-1.5 h-3 border-l border-[var(--border-strong)]" />
              <div className="flex items-center gap-2">{selected.finishedAt ? <CheckCircle2 size={14} /> : <Clock3 size={14} />} {selected.finishedAt ? 'Execution finalized' : 'Execution in progress or interrupted'}</div>
            </div>
            {selected.errorCode && <div className="rounded-lg border border-rose-500/25 p-3 text-xs">
              <p className="font-semibold">Failure: {selected.errorCode}{selected.errorLimit ? ' (' + selected.errorLimit + ')' : ''}</p>
              <p className="mt-1 text-[var(--text-2)]">{helpFor(selected.errorCode)}</p>
            </div>}
            <div className="break-all font-mono text-[11px] text-[var(--text-3)]">ID: {selected.executionId}</div>
            <div className="flex items-center gap-2 text-xs text-[var(--text-3)]"><ShieldCheck size={15} /> No raw script inputs, connector responses or secrets in receipt history.</div>
          </div> : <p className="mt-4 text-sm text-[var(--text-3)]">Select a run to inspect its metrics.</p>}
        </section>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center gap-2"><Lightbulb size={17} /><h3 className="font-semibold">Smart insights</h3>
          <span className="text-xs text-[var(--text-3)]">Rule-based · no LLM or external data transfer</span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {insights.map(insight => <div key={insight.title} className="rounded-lg bg-[var(--surface-2)] p-3">
            <p className="text-sm font-medium">{insight.title}</p>
            <p className="mt-1 text-xs text-[var(--text-2)]">{insight.detail}</p>
          </div>)}
        </div>
      </section>
    </>}
  </div>;
}
