'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { ApiError, codebound, type SavedScript, type ScriptBinding, type ScriptDefinition, type ScriptRun } from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';

const schema = '{"type":"object"}';
const initial = { name: '', description: '', source: 'async function main(input, api) {\n  const data = await api.read(input);\n  return { count: Array.isArray(data) ? data.length : Object.keys(data ?? {}).length };\n}', inputSchema: schema, outputSchema: schema, toolId: '' };
const control = 'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)]';

function message(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 409) return 'Revision conflict. Reload the script before saving or running again. Your edits are still shown.';
    if (error.status === 403) return 'Permission denied. Check your membership and connector permissions.';
    if (error.status === 404) return 'Script no longer available. Refresh the list.';
    if (error.status === 400) return 'Invalid script or input. Check JSON, source size and connector binding.';
    if (error.status === 401) return 'Your session expired. Sign in again.';
  }
  return 'Request failed. Check your connection and try again.';
}
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Record<string, unknown>;
}

export default function ScriptsPage() {
  const { token, user, isLoading } = useAuth();
  return <AppShell title="CODEBOUND Scripts" subtitle="Versioned workflows · approved REST tools · isolated Docker execution">
    <nav aria-label="CODEBOUND" className="mb-5 flex gap-2 text-sm">
      <span aria-current="page" className="rounded-lg bg-[var(--surface-2)] px-4 py-2 font-semibold">Scripts</span>
      <Link href="/scripts/runs" className="rounded-lg border border-[var(--border)] px-4 py-2 hover:bg-[var(--surface-2)]">Runs & insights</Link>
    </nav>
    {isLoading ? <p>Loading session…</p> : token && user ?
      <ScriptManager key={`${token}:${user.id}:${user.organizationId}`} token={token} /> : <p>Sign in to manage scripts.</p>}
  </AppShell>;
}

// Remount on identity/organization changes: never display the previous tenant's editor or result.
function ScriptManager({ token }: { token: string }) {
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [bindings, setBindings] = useState<ScriptBinding[]>([]);
  const [bindingCursor, setBindingCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [scriptCursor, setScriptCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<SavedScript | null>(null);
  const [form, setForm] = useState(initial);
  const [extraToolIds, setExtraToolIds] = useState<string[]>([]);
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<ScriptRun | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([codebound.list(token), codebound.bindings(token)]).then(([rows, page]) => {
      if (!active) return;
      setScripts(rows); setHasMore(rows.length === 20); setScriptCursor(rows.at(-1)?.id); setBindings(page.items); setBindingCursor(page.nextCursor);
    }).catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  function edit(script: SavedScript | null) {
    setSelected(script); setResult(null); setError(''); setConfirmDelete(false);
    setExtraToolIds(script?.additionalBindings?.map(binding => binding.toolId) ?? []);
    setForm(script ? { name: script.name, description: script.description, source: script.source,
      inputSchema: JSON.stringify(script.inputSchema, null, 2), outputSchema: JSON.stringify(script.outputSchema, null, 2), toolId: script.binding.toolId } : initial);
  }
  async function action(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save() {
    let definition: ScriptDefinition;
    try {
      const binding = bindings.find(b => b.binding.toolId === form.toolId)?.binding;
      // Existing binding remains usable only while persistence's live checks approve it.
      const chosen = binding ?? (selected?.binding.toolId === form.toolId ? selected.binding : undefined);
      if (!chosen) throw new Error('Select tool');
      // Preserve existing additional capabilities unless explicitly removed by the user.
      // Resolve fresh approved fingerprints where available; the backend always reauthorizes.
      const savedBindings = [selected?.binding, ...(selected?.additionalBindings ?? [])].filter(
        (value): value is ScriptDefinition['binding'] => !!value);
      const additionalBindings = extraToolIds.filter(id => id !== chosen.toolId).map(id => {
        const approved = bindings.find(tool => tool.binding.toolId === id)?.binding;
        const existing = savedBindings.find(tool => tool.toolId === id);
        if (!approved && !existing) throw new Error('Missing additional tool');
        return (approved ?? existing)!;
      });
      definition = { name: form.name, description: form.description, source: form.source,
        inputSchema: jsonObject(form.inputSchema), outputSchema: jsonObject(form.outputSchema),
        binding: chosen, additionalBindings };
    } catch { setError('Select authorized tools and enter valid JSON objects for both schemas.'); return; }
    await action(async () => {
      const saved = selected ? await codebound.update(token, selected, definition) : await codebound.create(token, definition);
      setScripts(rows => [...rows.filter(s => s.id !== saved.id), saved].sort((a, b) => a.id.localeCompare(b.id)));
      edit(saved);
    });
  }
  const dirty = !selected || form.name !== selected.name || form.description !== selected.description || form.source !== selected.source ||
    form.toolId !== selected.binding.toolId || form.inputSchema !== JSON.stringify(selected.inputSchema, null, 2) ||
    form.outputSchema !== JSON.stringify(selected.outputSchema, null, 2) ||
    JSON.stringify(extraToolIds.filter(id => id !== form.toolId)) !== JSON.stringify(
      (selected?.additionalBindings ?? []).map(binding => binding.toolId).filter(id => id !== form.toolId));

  return <div className="space-y-5">
    {error && <p role="alert" aria-label="Script error" className="rounded-lg border border-[var(--danger)] p-3 text-sm">{error}</p>}
    {loading ? <p role="status">Loading scripts…</p> : <div className="grid gap-6 lg:grid-cols-[250px_1fr]">
      <aside className="space-y-3">
        <Button disabled={busy} onClick={() => edit(null)}>New script</Button>
        <Button variant="secondary" disabled={busy} onClick={() => action(async () => {
          const [rows, page] = await Promise.all([codebound.list(token), codebound.bindings(token)]);
          setScripts(rows); setHasMore(rows.length === 20); setScriptCursor(rows.at(-1)?.id); setBindings(page.items); setBindingCursor(page.nextCursor);
        })}>Refresh list</Button>
        {!scripts.length && <p className="text-sm text-[var(--text-2)]">No saved scripts yet.</p>}
        <ul className="space-y-2">{scripts.map(s => <li key={s.id}><button disabled={busy} onClick={() => edit(s)}
          className={`${control} text-left ${selected?.id === s.id ? 'border-[var(--brand)]' : ''}`}>{s.name}<span className="block text-xs text-[var(--text-3)]">Revision {s.revision}</span></button></li>)}</ul>
        {hasMore && <Button variant="secondary" disabled={busy} onClick={() => action(async () => {
          const rows = await codebound.list(token, scriptCursor);
          setScripts(old => [...old, ...rows.filter(row => !old.some(s => s.id === row.id))]); setHasMore(rows.length === 20); setScriptCursor(rows.at(-1)?.id);
        })}>More scripts</Button>}
      </aside>
      <section className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h2 className="font-semibold">{selected ? `Edit script · revision ${selected.revision}` : 'Create script'}</h2>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block text-sm">Name<input className={control} maxLength={128} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label className="block text-sm">Description<input className={control} maxLength={1024} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
          <label className="block text-sm">Primary approved connector tool<select className={control} value={form.toolId} onChange={e => setForm({ ...form, toolId: e.target.value })}>
            <option value="">Select an authorized tool</option>
            {selected && !bindings.some(b => b.binding.toolId === selected.binding.toolId) && <option value={selected.binding.toolId}>Saved binding (authorization checked on save/run)</option>}
            {bindings.map(b => <option key={b.binding.toolId} value={b.binding.toolId}>{b.connectorName} / {b.toolName}</option>)}
          </select></label>
          {!bindings.length && <p className="text-sm">No eligible tools on this page. Add an owned REST connector or load more tools.</p>}
          <div className="rounded-lg border border-[var(--border)] p-3">
            <p className="text-sm font-semibold">Additional approved connector tools</p>
            <p className="mb-2 text-xs text-[var(--text-3)]">Saved tool bindings are preserved when editing. Only uncheck a tool if you intentionally want to remove its access.</p>
            <div className="grid gap-2 md:grid-cols-2">
              {bindings.filter(tool => tool.binding.toolId !== form.toolId).map(tool => (
                <label key={tool.binding.toolId} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={extraToolIds.includes(tool.binding.toolId)}
                    onChange={e => setExtraToolIds(ids => e.target.checked
                      ? [...ids.filter(id => id !== tool.binding.toolId), tool.binding.toolId]
                      : ids.filter(id => id !== tool.binding.toolId))} />
                  <span>{tool.connectorName} / {tool.toolName}</span>
                </label>
              ))}
              {extraToolIds.filter(id => id !== form.toolId && !bindings.some(tool => tool.binding.toolId === id)).map(id => (
                <label key={id} className="flex items-start gap-2 text-sm text-[var(--text-2)]">
                  <input type="checkbox" className="mt-1" checked
                    onChange={() => setExtraToolIds(ids => ids.filter(item => item !== id))} />
                  <span>Previously saved tool ({id.slice(0, 8)}…) — approval will be rechecked</span>
                </label>
              ))}
            </div>
          </div>
          {bindingCursor && <Button variant="secondary" onClick={() => action(async () => {
            const page = await codebound.bindings(token, bindingCursor); setBindings(old => [...old, ...page.items]); setBindingCursor(page.nextCursor);
          })}>More tools</Button>}
          <label className="block text-sm">JavaScript<textarea aria-label="JavaScript" className={`${control} font-mono`} rows={10} spellCheck={false} value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} /></label>
          <div className="grid gap-4 md:grid-cols-2">{(['inputSchema', 'outputSchema'] as const).map(key => <label key={key} className="block text-sm">{key === 'inputSchema' ? 'Input JSON schema' : 'Output JSON schema'}<textarea className={`${control} font-mono`} rows={4} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>)}</div>
          <p className="text-xs text-[var(--text-3)]">Schemas are saved as bounded JSON documents. Full JSON Schema semantics are not yet enforced. Never paste credentials into source or input.</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!form.name.trim() || !form.toolId} onClick={save}>Save script</Button>
            {selected && <Button variant="secondary" onClick={() => action(async () => edit(await codebound.get(token, selected.id)))}>Reload script</Button>}
            {selected && <Button variant="outlineDanger" onClick={() => setConfirmDelete(true)}>Delete script</Button>}
            {selected && confirmDelete && <><span className="self-center text-sm">Delete this script?</span><Button variant="danger" onClick={() => action(async () => {
              await codebound.remove(token, selected); setScripts(rows => rows.filter(s => s.id !== selected.id)); edit(null);
            })}>Confirm delete</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button></>}
          </div>
          <label className="block text-sm">Run input JSON<textarea aria-label="Run input JSON" className={`${control} font-mono`} rows={4} value={input} onChange={e => setInput(e.target.value)} /></label>
          <Button variant="secondary" disabled={!selected || dirty} onClick={() => {
            let parsed: Record<string, unknown>;
            try { parsed = jsonObject(input); } catch { setError('Run input must be a valid JSON object.'); return; }
            setResult(null);
            void action(async () => setResult(await codebound.run(token, selected!, parsed)));
          }}>Run saved script</Button>
          {dirty && <p className="text-xs text-[var(--text-3)]">Save changes before running.</p>}
        </fieldset>
        {busy && <p role="status">Working…</p>}
        {result && <div role="status">
          <p>Execution {result.status} · {result.executionId}</p>
          {result.metrics && <p className="mt-1 text-xs text-[var(--text-2)]">
            {result.metrics.connectorCalls} connector calls · {result.metrics.wallTimeMs.toFixed(0)} ms ·
            {' '}{result.metrics.connectorResponseBytes.toLocaleString()} B received ·
            {' '}{result.metrics.outputBytes.toLocaleString()} B returned
          </p>}
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-2)] p-3 text-sm">{JSON.stringify(result.status === 'succeeded' ? result.output : result.error, null, 2)}</pre>
          <Link href="/scripts/runs" className="mt-2 inline-block text-sm text-[var(--brand)] hover:underline">View run history and data insights →</Link>
        </div>}
      </section>
    </div>}
  </div>;
}
