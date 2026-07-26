import { useState } from 'react';
import { Add, Loader2, Target } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, fmtNum, fmtPct } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { Experiment, ExperimentResult, FeatureFlag, Metric } from '../api/types';

type DraftVariant = { id: number; key: string; rollout: string; payload: string };

export function Experiments() {
  const { client, project, env } = useStore();
  const { data, error, loading, reload } = useAsync(async () => Promise.all([
    client!.flags(project!), client!.experiments(project!), client!.metrics(project!),
  ]), [project]);

  if (loading) return <Loading what="reading feature delivery…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!data) return null;
  const [flags, experiments, metrics] = data;

  return (
    <div className="space-y-4">
      <Panel title="Feature delivery" right={<span className="text-xs text-muted-foreground">deterministic rollout + measured outcome</span>}>
        <p className="max-w-3xl text-sm text-muted-foreground">Use flags for controlled rollout. Start an experiment only when its registered outcome metric and exposure are ready.</p>
      </Panel>
      <FlagForm flags={flags} onCreated={reload} />
      <FlagsTable flags={flags} onChanged={reload} />
      <ExperimentForm flags={flags} metrics={metrics} onCreated={reload} />
      <ExperimentsTable experiments={experiments} env={env} onChanged={reload} />
    </div>
  );
}

function FlagForm({ flags, onCreated }: { flags: FeatureFlag[]; onCreated: () => void }) {
  const { client, project } = useStore();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');
  const [variants, setVariants] = useState<DraftVariant[]>([
    { id: 1, key: 'control', rollout: '50', payload: '' },
    { id: 2, key: 'test', rollout: '50', payload: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allocation = variants.reduce((total, variant) => total + (Number(variant.rollout) || 0), 0);
  const add = () => setVariants((current) => [...current, { id: Math.max(0, ...current.map((variant) => variant.id)) + 1, key: '', rollout: '0', payload: '' }]);
  const update = (id: number, patch: Partial<DraftVariant>) => setVariants((current) => current.map((variant) => variant.id === id ? { ...variant, ...patch } : variant));
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const parsed = variants.map((variant) => ({
        key: variant.key.trim(),
        rollout_percentage: Number(variant.rollout),
        ...(variant.payload.trim() ? { payload: JSON.parse(variant.payload) as Record<string, unknown> } : {}),
      }));
      await client!.createFlag(project!, { key: key.trim(), name: name.trim(), purpose: purpose.trim(), status, variants: parsed });
      setKey(''); setName(''); setPurpose(''); setStatus('draft');
      setVariants([{ id: 1, key: 'control', rollout: '50', payload: '' }, { id: 2, key: 'test', rollout: '50', payload: '' }]);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create feature flag');
    } finally { setBusy(false); }
  };
  const duplicate = flags.some((flag) => flag.key === key.trim());
  const valid = /^[a-z][a-z0-9_]*$/.test(key.trim()) && name.trim() && purpose.trim().length >= 10 && variants.length > 0 && allocation <= 100 && variants.every((variant) => /^[a-z][a-z0-9_]*$/.test(variant.key.trim()) && Number.isFinite(Number(variant.rollout)) && Number(variant.rollout) >= 0);

  return (
    <Panel title="New feature flag">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Key"><Input aria-label="Flag key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="checkout_copy" /></Field>
        <Field label="Name"><Input aria-label="Flag name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Checkout copy" /></Field>
        <Field label="Purpose" className="md:col-span-2"><textarea aria-label="Flag purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Safely test a clearer call to action at checkout." className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></Field>
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><Label className="text-xs text-muted-foreground">Variants · {allocation.toFixed(2)}% allocated</Label><Button type="button" variant="outline" size="sm" onClick={add}><Add className="size-3.5" /> Add variant</Button></div>
        {variants.map((variant, index) => (
          <div key={variant.id} className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_7rem_1fr_auto]">
            <Input aria-label={`Variant ${index + 1} key`} value={variant.key} onChange={(event) => update(variant.id, { key: event.target.value })} placeholder="control" />
            <Input aria-label={`Variant ${index + 1} rollout percentage`} type="number" min="0" max="100" value={variant.rollout} onChange={(event) => update(variant.id, { rollout: event.target.value })} />
            <Input aria-label={`Variant ${index + 1} JSON payload`} value={variant.payload} onChange={(event) => update(variant.id, { payload: event.target.value })} placeholder='payload JSON (optional)' className="font-mono text-xs" />
            <Button type="button" variant="ghost" size="sm" disabled={variants.length === 1} onClick={() => setVariants((current) => current.filter((entry) => entry.id !== variant.id))}>Remove</Button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-md border p-1"><button type="button" onClick={() => setStatus('draft')} className={`rounded px-3 py-1.5 text-xs ${status === 'draft' ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>Draft</button><button type="button" onClick={() => setStatus('active')} className={`rounded px-3 py-1.5 text-xs ${status === 'active' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>Active</button></div>
        <div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{duplicate ? 'Key already exists' : allocation > 100 ? 'Allocation cannot exceed 100%' : 'SDK exposures are automatic'}</span><Button onClick={submit} disabled={!valid || duplicate || busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}Create flag</Button></div>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function FlagsTable({ flags, onChanged }: { flags: FeatureFlag[]; onChanged: () => void }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (key: string, action: 'activate' | 'archive') => {
    setBusy(key); setError(null);
    try {
      if (action === 'activate') await client!.updateFlag(project!, key, { status: 'active' });
      else await client!.archiveFlag(project!, key);
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'could not update feature flag'); }
    finally { setBusy(null); }
  };
  return <Panel title={<>Feature flags <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{flags.length}</span></>}>
    {flags.length === 0 ? <EmptyState headline="No feature flags" lead="create a draft before deploying guarded code" /> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Flag</TableHead><TableHead>Purpose</TableHead><TableHead>Allocation</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{flags.map((flag) => <TableRow key={flag.id}><TableCell><div className="font-medium">{flag.name}</div><code className="text-xs text-muted-foreground">{flag.key}</code></TableCell><TableCell className="max-w-sm text-xs text-muted-foreground">{flag.purpose}</TableCell><TableCell><div className="flex flex-wrap gap-1">{flag.variants.map((variant) => <Badge key={variant.key} variant="outline" className="font-mono text-xs">{variant.key} {variant.rollout_percentage}%</Badge>)}</div></TableCell><TableCell><FlagStatus status={flag.status} /></TableCell><TableCell className="text-right">{busy === flag.key ? <Loader2 className="inline size-4 animate-spin" /> : flag.status === 'draft' ? <Button size="sm" onClick={() => change(flag.key, 'activate')}>Activate</Button> : flag.status === 'active' ? <Button variant="outline" size="sm" onClick={() => change(flag.key, 'archive')}>Archive</Button> : <span className="text-xs text-muted-foreground">immutable</span>}</TableCell></TableRow>)}</TableBody></Table></div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function ExperimentForm({ flags, metrics, onCreated }: { flags: FeatureFlag[]; metrics: Metric[]; onCreated: () => void }) {
  const { client, project } = useStore();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const eligibleFlags = flags.filter((flag) => flag.status === 'active');
  const eligibleMetrics = metrics.filter((metric) => metric.status === 'active' && (metric.type === 'count' || metric.type === 'unique_actors'));
  const [flagKey, setFlagKey] = useState('');
  const [metricKey, setMetricKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await client!.createExperiment(project!, { key: key.trim(), name: name.trim(), hypothesis: hypothesis.trim(), flag_key: flagKey, primary_metric_key: metricKey });
      setKey(''); setName(''); setHypothesis(''); setFlagKey(''); setMetricKey(''); onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'could not create experiment'); }
    finally { setBusy(false); }
  };
  const valid = /^[a-z][a-z0-9_]*$/.test(key.trim()) && name.trim() && hypothesis.trim().length >= 10 && flagKey && metricKey;
  return <Panel title="New experiment"><div className="grid gap-3 md:grid-cols-2"><Field label="Key"><Input aria-label="Experiment key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="checkout_copy_test" /></Field><Field label="Name"><Input aria-label="Experiment name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Checkout copy test" /></Field><Field label="Flag"><Select value={flagKey} onValueChange={setFlagKey}><SelectTrigger aria-label="Experiment flag"><SelectValue placeholder="Choose active flag" /></SelectTrigger><SelectContent>{eligibleFlags.map((flag) => <SelectItem key={flag.id} value={flag.key}>{flag.key}</SelectItem>)}</SelectContent></Select></Field><Field label="Primary metric"><Select value={metricKey} onValueChange={setMetricKey}><SelectTrigger aria-label="Experiment primary metric"><SelectValue placeholder="Choose active event metric" /></SelectTrigger><SelectContent>{eligibleMetrics.map((metric) => <SelectItem key={metric.id} value={metric.key}>{metric.key}</SelectItem>)}</SelectContent></Select></Field><Field label="Hypothesis" className="md:col-span-2"><textarea aria-label="Experiment hypothesis" value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} placeholder="Changing the checkout copy will increase completed purchases." className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></Field></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-muted-foreground">An experiment starts only when its flag allocates exactly 100%.</span><Button onClick={submit} disabled={!valid || busy || eligibleFlags.length === 0 || eligibleMetrics.length === 0}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}Create experiment</Button></div>{error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}</Panel>;
}

function ExperimentsTable({ experiments, env, onChanged }: { experiments: Experiment[]; env: string; onChanged: () => void }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ExperimentResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [concluding, setConcluding] = useState<Experiment | null>(null);
  const start = async (key: string) => { setBusy(key); setError(null); try { await client!.startExperiment(project!, key); onChanged(); } catch (err) { setError(err instanceof Error ? err.message : 'could not start experiment'); } finally { setBusy(null); } };
  const showResult = async (key: string) => { setBusy(key); setError(null); try { const result = await client!.experimentResults(project!, key, env); setResults((current) => ({ ...current, [key]: result })); } catch (err) { setError(err instanceof Error ? err.message : 'could not load experiment result'); } finally { setBusy(null); } };
  const conclude = async (decision: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string }) => {
    if (!concluding) return;
    setBusy(concluding.key); setError(null);
    try { await client!.concludeExperiment(project!, concluding.key, decision); setConcluding(null); onChanged(); }
    catch (err) { setError(err instanceof Error ? err.message : 'could not conclude experiment'); }
    finally { setBusy(null); }
  };
  return <Panel title={<>Experiments <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{experiments.length}</span></>}>
    {experiments.length === 0 ? <EmptyState headline="No experiments" lead="create a hypothesis against an active feature flag" /> : <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Experiment</TableHead><TableHead>Hypothesis</TableHead><TableHead>Flag / metric</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{experiments.map((experiment) => <ExperimentRow key={experiment.id} experiment={experiment} busy={busy === experiment.key} result={results[experiment.key]} onStart={start} onResult={showResult} onConclude={setConcluding} />)}</TableBody></Table></div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    {concluding && <ConcludeDialog experiment={concluding} busy={busy === concluding.key} onCancel={() => setConcluding(null)} onConfirm={conclude} />}
  </Panel>;
}

function ExperimentRow({ experiment, busy, result, onStart, onResult, onConclude }: { experiment: Experiment; busy: boolean; result?: ExperimentResult; onStart: (key: string) => void; onResult: (key: string) => void; onConclude: (experiment: Experiment) => void }) {
  return <><TableRow><TableCell><div className="font-medium">{experiment.name}</div><code className="text-xs text-muted-foreground">{experiment.key}</code></TableCell><TableCell className="max-w-sm text-xs text-muted-foreground">{experiment.hypothesis}</TableCell><TableCell><code className="block text-xs">{experiment.flag_key}</code><code className="block text-xs text-muted-foreground">{experiment.primary_metric_key}</code></TableCell><TableCell><ExperimentStatus status={experiment.status} /></TableCell><TableCell className="text-right">{busy ? <Loader2 className="inline size-4 animate-spin" /> : experiment.status === 'draft' ? <Button size="sm" onClick={() => onStart(experiment.key)}>Start</Button> : <div className="inline-flex gap-2"><Button variant="outline" size="sm" onClick={() => onResult(experiment.key)}>Results</Button>{experiment.status === 'running' && <Button size="sm" onClick={() => onConclude(experiment)}>Conclude</Button>}</div>}</TableCell></TableRow>{result && <TableRow className="bg-muted/30"><TableCell colSpan={5}><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Variant</TableHead><TableHead>Exposed</TableHead><TableHead>Converted</TableHead><TableHead>Rate</TableHead><TableHead>Uplift</TableHead><TableHead>95% interval</TableHead><TableHead>Chance to win</TableHead></TableRow></TableHeader><TableBody>{result.variants.map((variant) => <TableRow key={variant.key}><TableCell><code>{variant.key}</code></TableCell><TableCell>{fmtNum(variant.exposed)}</TableCell><TableCell>{fmtNum(variant.converted)}</TableCell><TableCell>{fmtPct(variant.conversion_rate)}</TableCell><TableCell>{variant.uplift_vs_control === null ? '—' : fmtPct(variant.uplift_vs_control)}</TableCell><TableCell>{fmtPct(variant.credible_interval.lower)}–{fmtPct(variant.credible_interval.upper)}</TableCell><TableCell>{fmtPct(variant.probability_best)}</TableCell></TableRow>)}</TableBody></Table></div></TableCell></TableRow>}</>;
}

function ConcludeDialog({ experiment, busy, onCancel, onConfirm }: { experiment: Experiment; busy: boolean; onCancel: () => void; onConfirm: (decision: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string }) => void }) {
  const [outcome, setOutcome] = useState<'ship' | 'iterate' | 'stop' | 'inconclusive'>('ship');
  const [rationale, setRationale] = useState('');
  return <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}><DialogContent><DialogHeader><DialogTitle className="serif font-normal text-xl">Conclude {experiment.name}?</DialogTitle><DialogDescription>This freezes the experiment window; future events do not alter its result.</DialogDescription></DialogHeader><div className="space-y-3"><Field label="Decision"><Select value={outcome} onValueChange={(value) => setOutcome(value as typeof outcome)}><SelectTrigger aria-label="Experiment decision"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ship">Ship winner</SelectItem><SelectItem value="iterate">Iterate</SelectItem><SelectItem value="stop">Stop</SelectItem><SelectItem value="inconclusive">Inconclusive</SelectItem></SelectContent></Select></Field><Field label="Rationale"><textarea aria-label="Experiment rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="The treatment improved conversion with sufficient confidence." className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50" /></Field></div><DialogFooter><Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button><Button onClick={() => onConfirm({ outcome, rationale: rationale.trim() })} disabled={busy || rationale.trim().length < 10}>{busy && <Loader2 className="size-4 animate-spin" />}Conclude experiment</Button></DialogFooter></DialogContent></Dialog>;
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}><Label className="text-xs font-medium text-muted-foreground">{label}</Label>{children}</div>;
}

function FlagStatus({ status }: { status: FeatureFlag['status'] }) {
  const variant = status === 'active' ? 'default' : status === 'archived' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}

function ExperimentStatus({ status }: { status: Experiment['status'] }) {
  const variant = status === 'running' ? 'default' : status === 'concluded' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}
