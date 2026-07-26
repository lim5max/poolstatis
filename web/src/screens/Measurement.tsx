import { useState } from 'react';
import { useAsync, useStore } from '../store';
import { ErrorNote, Hint, Loading, Panel, RecoverableError, Toolbar } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { MeasurementContract, MeasurementTrust, Metric } from '../api/types';

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
    <Panel title="Measurement trust" right={<span className="text-xs text-muted-foreground">real evidence · last 30 days</span>}>
      <p className="max-w-3xl text-sm text-muted-foreground">Check whether active metrics have enough source, identity, and property evidence for a decision.</p>
    </Panel>

    <Panel>
      <Toolbar
        left={<span className="text-sm">Environment <code>{env}</code></span>}
        center={<>
          <Badge variant="outline">{trust.length} active metrics</Badge>
          <Badge variant="outline">{properties.length} properties</Badge>
          <Badge variant="outline">{identity.links.filter((link) => link.status === 'active').length} active links</Badge>
        </>}
        right={<Button variant="outline" size="sm" onClick={audit.reload}>Refresh evidence</Button>}
      />
      {trust.length === 0 ? (
        <div className="p-5 text-sm text-muted-foreground">No active metric can be assessed yet. Review proposed metrics in Registry first.</div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Metric and purpose</TableHead><TableHead>Trust</TableHead><TableHead>Evidence</TableHead><TableHead>Blocker / next action</TableHead></TableRow></TableHeader>
            <TableBody>{trust.map(({ metric, trust: result, error }) => {
              const finding = result?.blockers[0] ?? result?.warnings[0];
              return <TableRow key={metric.key}>
                <TableCell className="min-w-64"><div className="font-medium">{metric.name}</div><code className="text-xs text-muted-foreground">{metric.key}</code><p className="mt-1 max-w-md text-xs text-muted-foreground">{metric.purpose}</p></TableCell>
                <TableCell><TrustBadge trusted={result?.status === 'trusted'} unavailable={Boolean(error)} /></TableCell>
                <TableCell className="min-w-48 text-xs text-muted-foreground">
                  {result ? <>
                    <div>{result.primary_metric.observed_events} observations · {result.primary_metric.observed_actors} actors</div>
                    <div>{pct(result.primary_metric.registered_coverage)} registered · {pct(result.identity.distinct_id_coverage)} identified</div>
                  </> : 'Unavailable'}
                </TableCell>
                <TableCell className="min-w-72 text-xs">
                  {error ? <span className="text-destructive">{error}</span> : finding ? <div><div>{finding.message}</div><div className="mt-1 text-muted-foreground">Next: {finding.next_action}</div></div> : <span className="text-emerald-600">No trust blockers in this evidence window.</span>}
                </TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>
      )}
    </Panel>

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
