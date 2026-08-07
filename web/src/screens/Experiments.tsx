import { useMemo, useState, type ReactNode } from 'react';
import { Add, Check, Loader2, Target } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, fmtNum, fmtPct } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DisclosureSummary } from '@/components/disclosure';
import { cn } from '@/lib/utils';
import {
  SHIP_STAGES,
  SHIP_STAGE_LABELS,
  ShipStageBadge,
  deriveExperimentStage,
  experimentOutcome,
} from '../components/ship-lifecycle';
import type {
  Experiment,
  ExperimentReadiness,
  ExperimentResult,
  FeatureFlag,
  Metric,
} from '../api/types';

type DeliveryIntent = 'rollout' | 'experiment' | 'config';
type ScreenTab = 'experiments' | 'flags';
type DraftVariant = { id: number; key: string; rollout: string; payload: string };
type ExperimentOutcome = 'ship' | 'iterate' | 'stop' | 'inconclusive';

const INTENTS: Array<{ id: DeliveryIntent; title: string; body: string; action: string }> = [
  {
    id: 'rollout',
    title: 'Safe rollout',
    body: 'Move a change from 0% to 100% without running an A/B test.',
    action: 'Create rollout',
  },
  {
    id: 'experiment',
    title: 'A/B experiment',
    body: 'Compare control and treatment after a recorded exposure.',
    action: 'Prepare experiment',
  },
  {
    id: 'config',
    title: 'Remote config',
    body: 'Change a typed payload without redeploying the product.',
    action: 'Create config',
  },
];

function slugify(value: string): string {
  const normalized = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(normalized) ? normalized : normalized ? `change_${normalized}` : '';
}

export function Experiments() {
  const { client, project, env } = useStore();
  const [tab, setTab] = useState<ScreenTab>('experiments');
  const [intent, setIntent] = useState<DeliveryIntent | null>(null);
  const { data, error, loading, reload } = useAsync(async () => Promise.all([
    client!.flags(project!), client!.experiments(project!), client!.metrics(project!),
  ]), [project]);

  if (loading) return <Loading what="reading feature delivery…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!data) return null;
  const [flags, experiments, metrics] = data;
  const visibleFlags = flags.filter((flag) => flag.env === env || flag.env === null);
  const visibleExperiments = experiments.filter((experiment) => experiment.env === env || experiment.env === null);

  return (
    <div className="space-y-4 [&_button]:min-h-11 sm:[&_button]:min-h-9">
      <header className="max-w-2xl">
        <h1 className="serif text-3xl text-balance">Experiments &amp; flags</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Prepare and run traffic changes, then record the outcome after real exposure evidence.
        </p>
      </header>

      <Panel title="What do you want to do?">
        <div className="grid gap-3 md:grid-cols-3">
          {INTENTS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={cn(
                'rounded-lg border p-4 text-left text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                intent === option.id
                  ? 'border-brand-strong bg-primary/10'
                  : 'bg-background hover:border-primary/60 hover:bg-primary/5',
              )}
              aria-pressed={intent === option.id}
              onClick={() => setIntent((current) => current === option.id ? null : option.id)}
            >
              <span className="text-sm font-medium">{option.title}</span>
              <span className="mt-2 block text-sm leading-relaxed text-muted-foreground">{option.body}</span>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Add className="size-4 text-brand-strong" />{option.action}
              </span>
            </button>
          ))}
        </div>
      </Panel>

      {intent === 'experiment' && (
        <PrepareExperimentForm
          env={env}
          metrics={metrics}
          onCreated={() => { setIntent(null); setTab('experiments'); reload(); }}
          onCancel={() => setIntent(null)}
        />
      )}
      {(intent === 'rollout' || intent === 'config') && (
        <FlagForm
          intent={intent}
          env={env}
          flags={visibleFlags}
          onCreated={() => { setIntent(null); setTab('flags'); reload(); }}
          onCancel={() => setIntent(null)}
        />
      )}

      <div className="flex gap-1 rounded-lg border bg-muted/20 p-1" role="tablist" aria-label="Feature delivery views">
        <TabButton selected={tab === 'experiments'} onClick={() => setTab('experiments')}>
          Experiments <Badge variant="outline" className="ml-1">{visibleExperiments.length}</Badge>
        </TabButton>
        <TabButton selected={tab === 'flags'} onClick={() => setTab('flags')}>
          Feature flags <Badge variant="outline" className="ml-1">{visibleFlags.length}</Badge>
        </TabButton>
      </div>

      <div role="tabpanel">
        {tab === 'experiments'
          ? <ExperimentBoard experiments={visibleExperiments} flags={visibleFlags} env={env} onChanged={reload} />
          : <FlagsBoard flags={visibleFlags} env={env} onChanged={reload} />}
      </div>
    </div>
  );
}

function TabButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`flex min-h-10 flex-1 items-center justify-center rounded-md border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? 'border-brand-strong bg-primary/10 font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}

function PrepareExperimentForm({
  env,
  metrics,
  onCreated,
  onCancel,
}: {
  env: string;
  metrics: Metric[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client, project } = useStore();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [hypothesis, setHypothesis] = useState('');
  const [metricKey, setMetricKey] = useState('');
  const [controlPayload, setControlPayload] = useState('');
  const [treatmentPayload, setTreatmentPayload] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eligibleMetrics = metrics.filter((metric) => metric.status === 'active'
    && (metric.type === 'count' || metric.type === 'unique_actors')
    && (metric.source.data_source === undefined || metric.source.data_source === 'native'));
  const flagKey = key ? `${key}_flag` : '';

  const updateName = (value: string) => {
    setName(value);
    setKey(slugify(value));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsePayload = (value: string) => value.trim() ? JSON.parse(value) as Record<string, unknown> : undefined;
      const control = parsePayload(controlPayload);
      const treatment = parsePayload(treatmentPayload);
      await client!.prepareExperiment(project!, {
        env,
        control_variant_key: 'control',
        flag: {
          key: flagKey,
          name: `${name.trim()} delivery`,
          purpose: `Controls traffic while measuring whether ${hypothesis.trim().replace(/[.]$/, '').toLowerCase()}.`,
          variants: [
            { key: 'control', rollout_percentage: 50, ...(control ? { payload: control } : {}) },
            { key: 'treatment', rollout_percentage: 50, ...(treatment ? { payload: treatment } : {}) },
          ],
        },
        experiment: {
          key: key.trim(),
          name: name.trim(),
          hypothesis: hypothesis.trim(),
          primary_metric_key: metricKey,
        },
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not prepare experiment');
    } finally {
      setBusy(false);
    }
  };

  const valid = /^[a-z][a-z0-9_]*$/.test(key) && name.trim() && hypothesis.trim().length >= 10 && metricKey;

  return (
    <Panel title="Prepare an A/B experiment" right={<Badge variant="outline">{env}</Badge>}>
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <Field label="Change name">
            <Input aria-label="Experiment name" value={name} onChange={(event) => updateName(event.target.value)} placeholder="Shorter signup" />
          </Field>
          <Field label="What do you expect?">
            <textarea
              aria-label="Experiment hypothesis"
              value={hypothesis}
              onChange={(event) => setHypothesis(event.target.value)}
              placeholder="A shorter signup will increase completed activation."
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>
        </div>
        <div className="space-y-3">
          <Field label="Success metric">
            <Select value={metricKey} onValueChange={setMetricKey}>
              <SelectTrigger aria-label="Experiment primary metric"><SelectValue placeholder="Choose an active metric" /></SelectTrigger>
              <SelectContent>{eligibleMetrics.map((metric) => <SelectItem key={metric.id} value={metric.key}>{metric.name} · {metric.key}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {eligibleMetrics.length === 0 && <ErrorNote>Activate a count or unique-actor metric in Registry first.</ErrorNote>}
          <div className="rounded-md border bg-muted/20 p-3 text-sm leading-relaxed text-muted-foreground">
            Poolstatis creates one dedicated draft flag with 50/50 control and treatment. No traffic changes until readiness passes and you launch it.
          </div>
          <button type="button" className="text-sm text-foreground hover:underline" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? 'Hide keys and payloads' : 'Add payloads or edit keys'}
          </button>
        </div>
      </div>
      {advanced && (
        <div className="mt-4 grid gap-3 rounded-md border p-4 md:grid-cols-2">
          <Field label="Experiment key"><Input aria-label="Experiment key" value={key} onChange={(event) => setKey(slugify(event.target.value))} /></Field>
          <Field label="Flag key"><Input aria-label="Experiment flag key" value={flagKey} readOnly /></Field>
          <Field label="Control payload JSON"><Input aria-label="Control payload JSON" className="font-mono text-sm" value={controlPayload} onChange={(event) => setControlPayload(event.target.value)} placeholder='{"label":"Current"}' /></Field>
          <Field label="Treatment payload JSON"><Input aria-label="Treatment payload JSON" className="font-mono text-sm" value={treatmentPayload} onChange={(event) => setTreatmentPayload(event.target.value)} placeholder='{"label":"New"}' /></Field>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <span className="text-sm text-muted-foreground">Creates drafts only · selected environment: <code>{env}</code></span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || busy || eligibleMetrics.length === 0}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}Prepare drafts
          </Button>
        </div>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function FlagForm({
  intent,
  env,
  flags,
  onCreated,
  onCancel,
}: {
  intent: 'rollout' | 'config';
  env: string;
  flags: FeatureFlag[];
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { client, project } = useStore();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [purpose, setPurpose] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [variants, setVariants] = useState<DraftVariant[]>(intent === 'config'
    ? [{ id: 1, key: 'default', rollout: '100', payload: '{"enabled":true}' }]
    : [{ id: 1, key: 'control', rollout: '100', payload: '' }, { id: 2, key: 'enabled', rollout: '0', payload: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allocation = variants.reduce((total, variant) => total + (Number(variant.rollout) || 0), 0);
  const duplicate = flags.some((flag) => flag.key === key);

  const updateName = (value: string) => {
    setName(value);
    setKey(slugify(value));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = variants.map((variant) => ({
        key: variant.key.trim(),
        rollout_percentage: Number(variant.rollout),
        ...(variant.payload.trim() ? { payload: JSON.parse(variant.payload) as Record<string, unknown> } : {}),
      }));
      await client!.createFlag(project!, {
        key,
        name: name.trim(),
        purpose: purpose.trim(),
        env,
        status: 'draft',
        variants: parsed,
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not create feature flag');
    } finally {
      setBusy(false);
    }
  };

  const valid = /^[a-z][a-z0-9_]*$/.test(key)
    && name.trim()
    && purpose.trim().length >= 10
    && variants.length > 0
    && allocation <= 100
    && variants.every((variant) => /^[a-z][a-z0-9_]*$/.test(variant.key) && Number(variant.rollout) >= 0);

  return (
    <Panel title={intent === 'config' ? 'Create remote config' : 'Create safe rollout'} right={<Badge variant="outline">{env}</Badge>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name"><Input aria-label="Flag name" value={name} onChange={(event) => updateName(event.target.value)} placeholder={intent === 'config' ? 'Search limits' : 'New checkout'} /></Field>
        <Field label="Why are you changing this?">
          <Input aria-label="Flag purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Roll out the new checkout without risking all traffic." />
        </Field>
      </div>
      <div className="mt-4 rounded-md border bg-muted/20 p-3 text-sm leading-relaxed text-muted-foreground">
        This saves a draft in <code>{env}</code>. Drafts do not change product traffic.
      </div>
      <button type="button" className="mt-3 text-sm text-foreground hover:underline" onClick={() => setAdvanced((value) => !value)}>
        {advanced ? 'Hide allocation and payloads' : 'Review allocation and payloads'}
      </button>
      {advanced && (
        <div className="mt-3 space-y-2 rounded-md border p-4">
          <Field label="Flag key"><Input aria-label="Flag key" value={key} onChange={(event) => setKey(slugify(event.target.value))} /></Field>
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm text-muted-foreground">Variants · {allocation.toFixed(2)}%</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => setVariants((current) => [...current, { id: Date.now(), key: '', rollout: '0', payload: '' }])}><Add className="size-3.5" />Add</Button>
          </div>
          {variants.map((variant, index) => (
            <div key={variant.id} className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_7rem_1fr_auto]">
              <Input aria-label={`Variant ${index + 1} key`} value={variant.key} onChange={(event) => setVariants((current) => current.map((item) => item.id === variant.id ? { ...item, key: slugify(event.target.value) } : item))} />
              <Input aria-label={`Variant ${index + 1} rollout percentage`} type="number" min="0" max="100" value={variant.rollout} onChange={(event) => setVariants((current) => current.map((item) => item.id === variant.id ? { ...item, rollout: event.target.value } : item))} />
              <Input aria-label={`Variant ${index + 1} JSON payload`} className="font-mono text-sm" value={variant.payload} onChange={(event) => setVariants((current) => current.map((item) => item.id === variant.id ? { ...item, payload: event.target.value } : item))} placeholder="payload JSON" />
              <Button type="button" variant="ghost" size="sm" disabled={variants.length === 1} onClick={() => setVariants((current) => current.filter((item) => item.id !== variant.id))}>Remove</Button>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-4">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={submit} disabled={!valid || duplicate || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}Save draft
        </Button>
      </div>
      {duplicate && <div className="mt-3"><ErrorNote>A flag with this key already exists.</ErrorNote></div>}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function ExperimentBoard({
  experiments,
  flags,
  env,
  onChanged,
}: {
  experiments: Experiment[];
  flags: FeatureFlag[];
  env: string;
  onChanged: () => void;
}) {
  const groups = [
    ...SHIP_STAGES.map((stage) => ({
      key: stage,
      title: SHIP_STAGE_LABELS[stage],
      items: experiments.filter((experiment) => deriveExperimentStage(experiment) === stage),
    })),
  ].filter((group) => group.items.length > 0);

  if (experiments.length === 0) {
    return <Panel><EmptyState headline="No experiments" lead="choose A/B experiment above to prepare one safe draft" /></Panel>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <Panel key={group.key} title={<>{group.title} <span className="ml-1 font-sans text-sm font-normal text-muted-foreground">{group.items.length}</span></>}>
          <div className="divide-y rounded-md border">
            {group.items.map((experiment) => (
              <ExperimentCard
                key={experiment.id}
                experiment={experiment}
                flag={flags.find((flag) => flag.key === experiment.flag_key)}
                env={env}
                onChanged={onChanged}
              />
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function ExperimentCard({
  experiment,
  flag,
  env,
  onChanged,
}: {
  experiment: Experiment;
  flag?: FeatureFlag;
  env: string;
  onChanged: () => void;
}) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ExperimentReadiness | null>(null);
  const [result, setResult] = useState<ExperimentResult | null>(null);
  const [showDecision, setShowDecision] = useState(false);
  const legacyAllEnvironments = experiment.env === null;
  const stage = deriveExperimentStage(experiment);
  const outcome = experimentOutcome(experiment);

  const checkReadiness = async () => {
    setBusy(true); setError(null);
    try { setReadiness(await client!.experimentReadiness(project!, experiment.key, experiment.env ?? env)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not check readiness'); }
    finally { setBusy(false); }
  };
  const showResults = async () => {
    setBusy(true); setError(null);
    try { setResult(await client!.experimentResults(project!, experiment.key, experiment.env ?? env)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not load results'); }
    finally { setBusy(false); }
  };

  return (
    <article aria-label={experiment.name} className="p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,0.5fr)_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{experiment.name}</h3>
            <ShipStageBadge stage={stage} />
          </div>
          <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">{experiment.hypothesis}</p>
        </div>
        <div className="min-w-0">
          <div className={outcome.available ? 'text-sm font-medium' : 'text-sm font-medium text-muted-foreground'}>{outcome.title}</div>
          <p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">{outcome.detail}</p>
        </div>
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {busy && <Loader2 className="size-4 animate-spin" />}
          {!busy && !legacyAllEnvironments && experiment.status === 'draft' && <Button size="sm" onClick={checkReadiness}>Check readiness</Button>}
          {!busy && experiment.status !== 'draft' && <Button variant="outline" size="sm" onClick={showResults}>View evidence</Button>}
          {!busy && !legacyAllEnvironments && experiment.status === 'running' && <Button size="sm" onClick={() => setShowDecision(true)}>Record decision</Button>}
        </div>
      </div>
      {legacyAllEnvironments && (
        <p className="mt-3 text-sm text-muted-foreground">Legacy all-environment experiments are read only here. Review every environment before using the legacy conclude operation.</p>
      )}
      {result && <ResultEvidence result={result} />}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      {readiness && (
        <LaunchDialog
          experiment={experiment}
          readiness={readiness}
          onCancel={() => setReadiness(null)}
          onLaunched={() => { setReadiness(null); onChanged(); }}
        />
      )}
      {showDecision && (
        <DecisionDialog
          experiment={experiment}
          variants={result?.variants.map((variant) => variant.key) ?? flag?.variants.map((variant) => variant.key) ?? []}
          onCancel={() => setShowDecision(false)}
          onApplied={() => { setShowDecision(false); onChanged(); }}
        />
      )}
      <details className="mt-2 min-w-0">
        <DisclosureSummary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">Technical details</DisclosureSummary>
        <div className="grid min-w-0 gap-x-5 gap-y-1 border-l pl-3 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
          <span>Experiment <code className="break-all">{experiment.key}</code></span>
          <span>Raw status <code>{experiment.status}</code></span>
          <span>Environment <code>{experiment.env ?? 'legacy-all'}</code></span>
          <span>Success metric <code>{experiment.primary_metric_key}</code></span>
          <span>Delivery flag <code>{experiment.flag_key}</code></span>
          {experiment.control_variant_key && <span>Control <code>{experiment.control_variant_key}</code></span>}
          {flag && <span>Allocation {flag.variants.reduce((sum, variant) => sum + variant.rollout_percentage, 0)}% across {flag.variants.length} variants · flag {flag.status}</span>}
        </div>
      </details>
    </article>
  );
}

function LaunchDialog({
  experiment,
  readiness,
  onCancel,
  onLaunched,
}: {
  experiment: Experiment;
  readiness: ExperimentReadiness;
  onCancel: () => void;
  onLaunched: () => void;
}) {
  const { client, project } = useStore();
  const [codeReady, setCodeReady] = useState(false);
  const [identityReady, setIdentityReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launch = async () => {
    setBusy(true); setError(null);
    try { await client!.launchExperiment(project!, experiment.key); onLaunched(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'could not launch experiment'); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">Ready to start measuring?</DialogTitle>
          <DialogDescription>Launch atomically activates the dedicated flag, freezes the definition, and starts the post-exposure window.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {readiness.checks.map((check) => (
            <div key={check.key} className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${check.ready ? 'border-success/40 bg-success/10 text-success' : 'text-destructive'}`}>
                {check.ready ? <Check className="size-3.5" /> : '!'}
              </span>
              <span>{check.message}</span>
            </div>
          ))}
          <ConfirmCheck checked={codeReady} onChange={setCodeReady}>The guarded product code is deployed.</ConfirmCheck>
          <ConfirmCheck checked={identityReady} onChange={setIdentityReady}>The product uses one stable actor ID across sessions.</ConfirmCheck>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={launch} disabled={!readiness.ready || !codeReady || !identityReady || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}Launch experiment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DecisionDialog({
  experiment,
  variants,
  onCancel,
  onApplied,
}: {
  experiment: Experiment;
  variants: string[];
  onCancel: () => void;
  onApplied: () => void;
}) {
  const { client, project } = useStore();
  const [outcome, setOutcome] = useState<ExperimentOutcome>('inconclusive');
  const [rationale, setRationale] = useState('');
  const [shipVariant, setShipVariant] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setBusy(true); setError(null);
    try {
      await client!.applyExperimentDecision(project!, experiment.key, {
        decision: { outcome, rationale: rationale.trim() },
        ...(outcome === 'ship' && shipVariant !== 'none' ? { ship_variant_key: shipVariant } : {}),
      });
      onApplied();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not apply experiment decision');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">Record the decision</DialogTitle>
          <DialogDescription>Recording a decision concludes the measurement window. It does not change rollout unless you explicitly select a variant below.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Outcome">
            <Select value={outcome} onValueChange={(value) => { setOutcome(value as ExperimentOutcome); if (value !== 'ship') setShipVariant('none'); }}>
              <SelectTrigger aria-label="Experiment decision"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ship">Ship</SelectItem>
                <SelectItem value="iterate">Iterate</SelectItem>
                <SelectItem value="stop">Stop</SelectItem>
                <SelectItem value="inconclusive">Inconclusive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {outcome === 'ship' && (
            <Field label="Delivery after conclusion">
              <Select value={shipVariant} onValueChange={setShipVariant}>
                <SelectTrigger aria-label="Variant to ship"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Record only · keep current allocation</SelectItem>
                  {variants.map((variant) => <SelectItem key={variant} value={variant}>Ship {variant} to 100%</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Why?">
            <textarea aria-label="Experiment rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="State what the evidence supports and what remains uncertain." className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring" />
          </Field>
          {outcome === 'ship' && shipVariant !== 'none' && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
              This atomically concludes the experiment and moves <code>{shipVariant}</code> to 100% allocation.
            </div>
          )}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={apply} disabled={busy || rationale.trim().length < 10}>{busy && <Loader2 className="size-4 animate-spin" />}Apply decision</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultEvidence({ result }: { result: ExperimentResult }) {
  const totalExposed = result.variants.reduce((sum, variant) => sum + variant.exposed, 0);
  const state = totalExposed === 0 ? 'No exposures yet' : result.status === 'running' ? 'Collecting evidence' : 'Ready to review';
  return (
    <div className="mt-4 rounded-md border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{state}</div>
          <p className="mt-1 text-sm text-muted-foreground">{result.primary_metric.purpose}</p>
        </div>
        <Badge variant="outline">{result.snapshot_integrity.replaceAll('_', ' ')}</Badge>
      </div>
      {totalExposed === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">The server has not recorded an assigned actor after launch. Check the SDK evaluation path before interpreting conversion.</p>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {result.variants.map((variant) => (
            <div key={variant.key} className="rounded-md border bg-background p-3">
              <div className="flex items-center justify-between gap-2"><code className="text-sm">{variant.key}</code>{variant.key === result.control_variant_key && <Badge variant="outline">control</Badge>}</div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <EvidenceValue label="Exposed" value={fmtNum(variant.exposed)} />
                <EvidenceValue label="Converted" value={fmtNum(variant.converted)} />
                <EvidenceValue label="Rate" value={fmtPct(variant.conversion_rate)} />
                <EvidenceValue label="Uplift" value={variant.uplift_vs_control === null ? '—' : fmtPct(variant.uplift_vs_control)} />
                <EvidenceValue label="95% interval" value={`${fmtPct(variant.credible_interval.lower)}–${fmtPct(variant.credible_interval.upper)}`} />
                <EvidenceValue label="Chance best" value={fmtPct(variant.probability_best)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {result.secondary_metrics.length > 0 && (
        <details className="mt-4 rounded-md border bg-background p-3">
          <DisclosureSummary className="inline-flex cursor-pointer items-center text-sm font-medium">Guardrails and secondary metrics · {result.secondary_metrics.length}</DisclosureSummary>
          <div className="mt-3 space-y-3">
            {result.secondary_metrics.map((entry) => (
              <div key={entry.metric.key} className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground">{entry.metric.name}</div>
                <div className="mt-1">{entry.variants.map((variant) => `${variant.key}: ${fmtPct(variant.conversion_rate)}`).join(' · ')}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function EvidenceValue({ label, value }: { label: string; value: string }) {
  return <div><div className="text-muted-foreground">{label}</div><div className="mt-1 font-medium text-foreground tabular-nums">{value}</div></div>;
}

function ConfirmCheck({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 size-4 accent-primary" />
      <span>{children}</span>
    </label>
  );
}

function FlagsBoard({ flags, env, onChanged }: { flags: FeatureFlag[]; env: string; onChanged: () => void }) {
  const active = flags.filter((flag) => flag.status !== 'archived');
  const archived = flags.filter((flag) => flag.status === 'archived');
  if (flags.length === 0) return <Panel><EmptyState headline="No feature flags" lead="choose safe rollout or remote config above" /></Panel>;
  return (
    <Panel title="Feature flags">
      <div className="divide-y rounded-md border">
        {active.map((flag) => <FlagCard key={flag.id} flag={flag} env={env} onChanged={onChanged} />)}
      </div>
      {archived.length > 0 && (
        <details className="mt-4 rounded-md border p-3">
          <DisclosureSummary className="inline-flex cursor-pointer items-center text-sm font-medium">Archived · {archived.length}</DisclosureSummary>
          <div className="mt-3 divide-y">{archived.map((flag) => <FlagCard key={flag.id} flag={flag} env={env} onChanged={onChanged} />)}</div>
        </details>
      )}
    </Panel>
  );
}

function FlagCard({ flag, env, onChanged }: { flag: FeatureFlag; env: string; onChanged: () => void }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allocation = useMemo(() => flag.variants.reduce((sum, variant) => sum + variant.rollout_percentage, 0), [flag.variants]);
  const change = async (action: 'activate' | 'archive') => {
    setBusy(true); setError(null);
    try {
      if (action === 'activate') await client!.updateFlag(project!, flag.key, { status: 'active' });
      else await client!.archiveFlag(project!, flag.key);
      onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not update feature flag'); }
    finally { setBusy(false); }
  };
  return (
    <article aria-label={flag.name} className="grid min-w-0 gap-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_minmax(12rem,0.8fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{flag.name}</span><FlagStatus status={flag.status} /></div>
      </div>
      <div className="min-w-0 xl:col-span-2">
        <p className="break-words text-sm leading-relaxed">{flag.purpose}</p>
        <details className="mt-2 min-w-0">
          <DisclosureSummary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">Allocation &amp; technical details</DisclosureSummary>
          <div className="min-w-0 border-l pl-3 text-sm text-muted-foreground">
            <div>Flag <code className="break-all">{flag.key}</code> · environment <code>{flag.env ?? 'legacy-all'}</code> · {allocation}% allocated</div>
            <div className="mt-2 flex flex-wrap gap-1">{flag.variants.map((variant) => <Badge key={variant.key} variant="outline" className="font-mono text-sm">{variant.key} {variant.rollout_percentage}%</Badge>)}</div>
          </div>
        </details>
      </div>
      <div className="flex items-start justify-end">
        {flag.env === null
          ? <span className="text-sm text-muted-foreground">Read only · all envs</span>
          : flag.env !== env
            ? <span className="text-sm text-muted-foreground">Read only · {flag.env}</span>
            : busy ? <Loader2 className="size-4 animate-spin" /> : flag.status === 'draft'
          ? <Button size="sm" onClick={() => change('activate')}>Activate</Button>
          : flag.status === 'active'
            ? <Button variant="outline" size="sm" onClick={() => change('archive')}>Archive</Button>
            : <span className="text-sm text-muted-foreground">Read only</span>}
      </div>
      {error && <div className="md:col-span-2 xl:col-span-4"><ErrorNote>{error}</ErrorNote></div>}
    </article>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-sm font-medium text-muted-foreground">{label}</Label>{children}</div>;
}

function FlagStatus({ status }: { status: FeatureFlag['status'] }) {
  const variant = status === 'active' ? 'default' : status === 'archived' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}
