import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Hint, Loading, Panel, RecoverableError, fmtNum } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MeasurementContract, MeasurementTrust, Metric, TrendResponse } from '../api/types';

interface MetricTrustRow {
  metric: Metric;
  trust: MeasurementTrust | null;
  error: string | null;
}

export function Measurement() {
  const { client, project, env } = useStore();
  const audit = useAsync(async () => {
    const [properties, identity, sources, metrics, contracts] = await Promise.all([
      client!.properties(project!),
      client!.actorLinks(project!, env),
      client!.sources(project!),
      client!.metrics(project!, { status: 'active' }),
      client!.contracts(project!),
    ]);
    const trust: MetricTrustRow[] = await Promise.all(metrics.map(async (metric) => {
      try {
        return {
          metric,
          trust: await client!.measurementTrust(project!, {
            metric_key: metric.key,
            env,
            since_days: 30,
            target_filters: [],
          }),
          error: null,
        };
      } catch (error) {
        return {
          metric,
          trust: null,
          error: error instanceof Error ? error.message : 'trust check failed',
        };
      }
    }));
    return { properties, identity, sources, trust, contracts };
  }, [project, env]);

  if (audit.loading) return <Loading what="checking measurement trust…" />;
  if (audit.error) return <RecoverableError onRetry={audit.reload}>{audit.error}</RecoverableError>;
  if (!audit.data) return null;
  const { properties, identity, sources, trust, contracts } = audit.data;

  return <div className="space-y-4">
    <Panel title="Measurement" right={<span className="text-xs text-muted-foreground">server evidence · {env}</span>}>
      <p className="max-w-3xl text-sm text-muted-foreground">Review what is decision-ready, then open only the metric that needs action.</p>
    </Panel>

    <TrustOverview rows={trust} properties={properties.length} activeLinks={identity.links.filter((link) => link.status === 'active').length} onRefresh={audit.reload} />

    <AcquisitionPanel metrics={trust.map((row) => row.metric)} env={env} />

    <ContractsPanel contracts={contracts} />

    <Panel title={<>Property meanings <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{properties.length}</span></>}>
      {properties.length === 0 ? <p className="text-sm text-muted-foreground">No decision properties are registered yet.</p> : <div className="overflow-x-auto">
        <Table><TableHeader><TableRow><TableHead>Property</TableHead><TableHead>Meaning</TableHead><TableHead>Type</TableHead><TableHead>Trust</TableHead><TableHead>Source</TableHead></TableRow></TableHeader>
          <TableBody>{properties.map((property) => <TableRow key={`${property.scope}:${property.key}`}>
            <TableCell><code className="text-xs">{property.scope}.{property.key}</code></TableCell>
            <TableCell className="max-w-lg text-sm text-muted-foreground">{property.purpose}</TableCell>
            <TableCell><Badge variant="outline" className="font-normal">{property.value_type}</Badge></TableCell>
            <TableCell><PropertyTrustBadge status={property.status} /></TableCell>
            <TableCell className="text-xs text-muted-foreground">{property.source}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>}
    </Panel>

    <Panel title="Identity links" right={<span className="text-xs text-muted-foreground">reversible · append-only audit</span>}>
      {identity.links.length === 0 ? <p className="text-sm text-muted-foreground">No anonymous-to-identified links have been recorded for <code>{env}</code>.</p> : <div className="overflow-x-auto">
        <Table><TableHeader><TableRow><TableHead>Source actor</TableHead><TableHead>Stable actor</TableHead><TableHead>Status</TableHead><TableHead>Created by</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader>
          <TableBody>{identity.links.map((link) => <TableRow key={link.id}>
            <TableCell><code className="text-xs">{link.source_distinct_id}</code></TableCell>
            <TableCell><code className="text-xs">{link.target_distinct_id}</code></TableCell>
            <TableCell><Badge variant={link.status === 'active' ? 'default' : 'secondary'}>{link.status}</Badge></TableCell>
            <TableCell className="text-xs text-muted-foreground">{link.created_by}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatDate(link.revoked_at ?? link.created_at)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>}
      <div className="mt-4 border-t pt-4 text-xs text-muted-foreground">{identity.audit.length} audit {identity.audit.length === 1 ? 'entry' : 'entries'} preserved in this environment.</div>
    </Panel>

    <Panel title="Data sources" right={<span className="text-xs text-muted-foreground">bounded read-only capabilities</span>}>
      {sources.length === 0 ? <p className="text-sm text-muted-foreground">Native ingest is the current data path. Configure PostHog through MCP or the Platform API when raw data should remain external.</p> : <div className="space-y-3">
        {sources.map((source) => <div key={source.id} className="rounded-md border bg-muted/20 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">{source.name}</div><div className="mt-1 text-xs text-muted-foreground"><code>{source.provider}</code> · project {source.external_project_id} · {source.host}</div></div><SourceBadge status={source.status} /></div>
          <div className="mt-3 flex flex-wrap gap-1.5">{Object.entries(source.capabilities).map(([capability, supported]) => <Hint key={capability} label={supported ? `${capability} is supported by the bounded adapter.` : `${capability} is explicitly unsupported; Poolstatis will return a capability error.`}><Badge variant={supported ? 'outline' : 'secondary'} className="cursor-help font-normal">{capability} · {supported ? 'yes' : 'no'}</Badge></Hint>)}</div>
          {source.last_error && <div className="mt-3 text-xs text-destructive">{source.last_error}</div>}
        </div>)}
      </div>}
    </Panel>
  </div>;
}

function TrustOverview({ rows, properties, activeLinks, onRefresh }: {
  rows: MetricTrustRow[]; properties: number; activeLinks: number; onRefresh: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const trusted = rows.filter((row) => row.trust?.status === 'trusted').length;
  const unavailable = rows.filter((row) => Boolean(row.error)).length;
  const untrusted = rows.length - trusted - unavailable;
  return <Panel title="Decision readiness" right={<Button variant="outline" size="sm" onClick={onRefresh}>Refresh evidence</Button>}>
    <div className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3" aria-live="polite">
      {[
        [`${trusted} trusted`, 'No trust blockers'],
        [`${untrusted} untrusted`, 'Review the first blocker'],
        [`${unavailable} unavailable`, 'Retry or inspect the source'],
      ].map(([value, label]) => <div key={value} className="bg-card p-4"><div className="serif text-2xl">{value}</div><div className="mt-1 text-xs text-muted-foreground">{label}</div></div>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">{rows.length} active metrics</Badge>
      <Badge variant="outline">{properties} properties</Badge>
      <Badge variant="outline">{activeLinks} active identity links</Badge>
    </div>
    {rows.length === 0 ? <div className="mt-4"><EmptyState headline="Nothing to assess" lead="activate a proposed metric in Registry first" /></div> : (
      <div className="mt-4 divide-y rounded-md border">
        {rows.map(({ metric, trust: result, error }) => {
          const expanded = open === metric.key;
          const finding = result?.blockers[0] ?? result?.warnings[0];
          return <section key={metric.key}>
            <div className="grid min-w-0 gap-3 p-4 md:grid-cols-[minmax(12rem,1.4fr)_auto_minmax(12rem,1fr)_auto] md:items-center">
              <div className="min-w-0"><div className="font-medium break-words">{metric.name}</div><code className="text-xs text-muted-foreground break-all">{metric.key}</code></div>
              <TrustBadge trusted={result?.status === 'trusted'} unavailable={Boolean(error)} />
              <div className="text-xs text-muted-foreground">
                {result ? <><div>{fmtNum(result.primary_metric.observed_events)} observations</div><div>{fmtNum(result.primary_metric.observed_actors)} actors · {pct(result.primary_metric.registered_coverage)} registered</div></> : 'Evidence unavailable'}
              </div>
              <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls={`trust-${metric.key}`} aria-label={`Review ${metric.name}`} onClick={() => setOpen(expanded ? null : metric.key)}>
                {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}Review
              </Button>
            </div>
            {expanded && <div id={`trust-${metric.key}`} className="grid gap-3 border-t bg-muted/20 p-4 md:grid-cols-2">
              <div><div className="text-xs font-medium text-muted-foreground">Purpose</div><p className="mt-1 text-sm">{metric.purpose}</p></div>
              <div>
                <div className="text-xs font-medium text-muted-foreground">{error ? 'Error' : finding ? 'Next action' : 'Status'}</div>
                {error ? <p className="mt-1 text-sm text-destructive">{error}</p> : finding ? <><p className="mt-1 text-sm">{finding.message}</p><p className="mt-1 text-xs text-muted-foreground">Next: {finding.next_action}</p></> : <p className="mt-1 text-sm text-emerald-600">No trust blockers in this window.</p>}
              </div>
            </div>}
          </section>;
        })}
      </div>
    )}
  </Panel>;
}

type AcquisitionDimension = '$utm_source' | '$utm_medium' | '$utm_campaign' | '$utm_term' | '$utm_content';
type AcquisitionResult = Record<AcquisitionDimension, TrendResponse>;

function AcquisitionPanel({ metrics, env }: { metrics: Metric[]; env: string }) {
  const { client, project } = useStore();
  const eligible = useMemo(() => metrics.filter((metric) => metric.status === 'active' && metric.type === 'count'), [metrics]);
  const preferred = eligible.find((metric) => metric.category === 'acquisition') ?? eligible[0];
  const [metricKey, setMetricKey] = useState(preferred?.key ?? '');
  const [period, setPeriod] = useState('30');
  const [result, setResult] = useState<AcquisitionResult | null>(null);
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = eligible.find((metric) => metric.key === metricKey) ?? preferred;
  const run = async () => {
    if (!selected) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const base = { metric: selected.key, date_from: `-${period}d`, interval: 'day' as const, env };
      const dimensions: AcquisitionDimension[] = details
        ? ['$utm_source', '$utm_medium', '$utm_campaign', '$utm_term', '$utm_content']
        : ['$utm_source', '$utm_medium', '$utm_campaign'];
      const responses = await Promise.all(dimensions.map((property) => client!.trend(project!, { ...base, breakdown: { property } })));
      setResult(Object.fromEntries(dimensions.map((dimension, index) => [dimension, responses[index]])) as AcquisitionResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not query acquisition breakdowns');
    } finally { setBusy(false); }
  };
  const event = selected ? String((selected.source as Record<string, unknown>).event ?? '') : '';
  return <Panel title="Acquisition / UTM" right={<span className="text-xs text-muted-foreground">registered metric query · {env}</span>}>
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-52 flex-1 space-y-1.5"><label className="text-xs font-medium text-muted-foreground">Count metric</label><Select value={selected?.key ?? ''} onValueChange={(value) => { setMetricKey(value); setResult(null); }} disabled={eligible.length === 0}><SelectTrigger aria-label="Acquisition metric"><SelectValue placeholder="Choose an active count metric" /></SelectTrigger><SelectContent>{eligible.map((metric) => <SelectItem key={metric.key} value={metric.key}>{metric.name} · {metric.key}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1.5"><label className="text-xs font-medium text-muted-foreground">Period</label><Select value={period} onValueChange={(value) => { setPeriod(value); setResult(null); }}><SelectTrigger aria-label="Acquisition period" className="w-28"><SelectValue /></SelectTrigger><SelectContent>{['7', '30', '90'].map((days) => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent></Select></div>
      <Button onClick={run} disabled={!selected || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Run UTM report</Button>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <button className="underline underline-offset-2 hover:text-foreground" aria-expanded={details} onClick={() => { setDetails((value) => !value); setResult(null); }}>{details ? 'Hide term and content' : 'Include term and content'}</button>
      {event && <Button variant="link" size="sm" asChild className="h-auto p-0"><Link to={`/data?tab=events&event=${encodeURIComponent(event)}`}>Open raw events</Link></Button>}
    </div>
    {eligible.length === 0 && <div className="mt-4"><EmptyState headline="No reportable count metric" lead="activate a count metric whose source event carries canonical UTM properties" /></div>}
    {busy && <div className="mt-4" role="status" aria-live="polite">Loading canonical UTM breakdowns…</div>}
    {error && <div className="mt-4"><ErrorNote>{error}. Check that the metric uses native events and that landing ingest is not blocked by CORS.</ErrorNote></div>}
    {result && <AcquisitionResults result={result} />}
  </Panel>;
}

function AcquisitionResults({ result }: { result: AcquisitionResult }) {
  const dimensions = Object.entries(result) as Array<[AcquisitionDimension, TrendResponse]>;
  const hasValues = dimensions.some(([, response]) => response.series.length > 0);
  if (!hasValues) return <div className="mt-4"><EmptyState headline="No attributed events in this window" lead="check raw events, metric source, and landing CORS; zero is preserved, not estimated" /></div>;
  return <div className="mt-4 grid gap-3 lg:grid-cols-3" aria-live="polite">
    {dimensions.map(([dimension, response]) => {
      const rows = aggregateBreakdown(response);
      const total = rows.reduce((sum, row) => sum + row.value, 0);
      return <div key={dimension} className="min-w-0 rounded-md border">
        <div className="border-b px-3 py-2"><code className="text-xs">{dimension}</code></div>
        <div className="divide-y">{rows.length === 0 ? <div className="p-3 text-xs text-muted-foreground">No values</div> : rows.slice(0, 6).map((row) => <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 px-3 py-2 text-sm"><span className="truncate" title={row.label}>{row.label}</span><span className="tabular-nums">{fmtNum(row.value)}</span><span className="w-10 text-right text-xs text-muted-foreground">{pct(total ? row.value / total : 0)}</span></div>)}</div>
      </div>;
    })}
  </div>;
}

function aggregateBreakdown(response: TrendResponse) {
  const values = new Map<string, number>();
  response.series.forEach((point) => {
    const raw = point.breakdown_value ?? '(none)';
    const label = raw === '(none)' ? 'Direct / unknown' : raw === '$other' ? 'Other' : raw;
    values.set(label, (values.get(label) ?? 0) + point.value);
  });
  return [...values.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function ContractsPanel({ contracts }: { contracts: MeasurementContract[] }) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true); setError(null);
    try {
      const exported = await client!.exportContracts(project!);
      const url = URL.createObjectURL(new Blob([exported.yaml], { type: 'text/yaml' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not export measurement contracts');
    } finally { setBusy(false); }
  };
  return <Panel title={<>Measurement contracts <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{contracts.length}</span></>} right={<Button variant="outline" size="sm" onClick={download} disabled={busy || contracts.length === 0}>{busy ? 'Exporting…' : 'Export poolstatis.yml'}</Button>}>
    <p className="mb-4 max-w-3xl text-sm text-muted-foreground">Repository-owned hypotheses define what a release is expected to change, which metric decides it, and which guardrails can stop it.</p>
    {contracts.length === 0 ? <p className="text-sm text-muted-foreground">No contracts have been applied. Validate and apply <code>poolstatis.yml</code> through MCP or the Platform API.</p> : <div className="overflow-x-auto">
      <Table><TableHeader><TableRow><TableHead>Contract</TableHead><TableHead>Hypothesis</TableHead><TableHead>Decision rule</TableHead><TableHead>Owner</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
        <TableBody>{contracts.map((contract) => <TableRow key={contract.id}>
          <TableCell className="min-w-48"><div className="font-medium">{contract.name}</div><code className="text-xs text-muted-foreground">{contract.key}</code><div className="mt-1 text-xs text-muted-foreground">revision {contract.revision}</div></TableCell>
          <TableCell className="min-w-72 max-w-lg text-sm text-muted-foreground">{contract.business_hypothesis}</TableCell>
          <TableCell className="min-w-64 text-xs"><div><code>{contract.primary_metric_key}</code> must {contract.expected_direction.replaceAll('_', ' ')}</div><div className="mt-1 text-muted-foreground">{contract.minimum_sample_size} actors · {contract.observation_window_days} days</div>{contract.guardrail_metric_keys.length > 0 && <div className="mt-1 text-muted-foreground">Guardrails: {contract.guardrail_metric_keys.join(', ')}</div>}</TableCell>
          <TableCell className="text-sm">{contract.decision_owner}</TableCell>
          <TableCell><Badge variant={contract.status === 'active' ? 'default' : 'outline'}>{contract.status}</Badge></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
  </Panel>;
}

function TrustBadge({ trusted, unavailable }: { trusted: boolean; unavailable: boolean }) {
  if (unavailable) return <Badge variant="secondary">unavailable</Badge>;
  return <Badge variant={trusted ? 'default' : 'destructive'}>{trusted ? 'trusted' : 'untrusted'}</Badge>;
}

function PropertyTrustBadge({ status }: { status: 'proposed' | 'trusted' | 'untrusted' }) {
  return <Hint label={status === 'trusted' ? 'Meaning and type were explicitly reviewed.' : status === 'proposed' ? 'Awaiting explicit semantic review.' : 'Known unsafe for decision filters.'}><Badge variant={status === 'trusted' ? 'default' : status === 'untrusted' ? 'destructive' : 'outline'} className="cursor-help">{status}</Badge></Hint>;
}

function SourceBadge({ status }: { status: 'configured' | 'verified' | 'error' | 'disabled' }) {
  return <Badge variant={status === 'verified' ? 'default' : status === 'error' ? 'destructive' : 'outline'}>{status}</Badge>;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
