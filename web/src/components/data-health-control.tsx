import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { DataHealthVerifyResult, DataHealthWindow } from '../api/types';
import { useAsync, useStore } from '../store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorNote, Loading, Panel, TableScroll, fmtNum } from './ui';
import { DisclosureSummary } from './disclosure';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function DataHealthControl({ focusedSignature }: { focusedSignature?: string }) {
  const { client, project, env } = useStore();
  const health = useAsync(() => client!.dataHealth(project!, env), [project, env]);
  const [range, setRange] = useState<'last_24h' | 'last_7d'>('last_24h');
  const [verification, setVerification] = useState<Record<string, DataHealthVerifyResult>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<Record<string, string>>({});

  if (health.loading || !health.data) {
    return health.error ? <ErrorNote>{health.error}</ErrorNote> : <Loading what="Loading data flow…" />;
  }
  const data = health.data;
  const window = data.windows[range];

  const verify = async (signatureId: string) => {
    const issue = data.issue_signatures.find((candidate) => candidate.signature_id === signatureId);
    if (!issue) return;
    setVerifying(signatureId);
    setVerifyError((current) => ({ ...current, [signatureId]: '' }));
    try {
      const result = await client!.verifyDataHealthFix(project!, issue.verify_after_fix.body);
      setVerification((current) => ({ ...current, [signatureId]: result }));
    } catch (caught) {
      setVerifyError((current) => ({ ...current, [signatureId]: (caught as Error).message }));
    } finally {
      setVerifying(null);
    }
  };

  return <>
    <Panel
      title={<h3>Data flow</h3>}
      right={<div className="flex rounded-field border p-0.5" aria-label="Data flow range">
        <Button size="sm" variant={range === 'last_24h' ? 'secondary' : 'ghost'} onClick={() => setRange('last_24h')}>24h</Button>
        <Button size="sm" variant={range === 'last_7d' ? 'secondary' : 'ghost'} onClick={() => setRange('last_7d')}>7d</Button>
      </div>}
    >
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <FlowStat label="Accepted" value={window.accepted_total} note="durably stored" />
          <FlowStat label="Rejected" value={window.rejected_total} note="schema rejection occurrences" danger={window.rejected_total > 0} />
        </div>
        <DataFlowChart window={window} label={range === 'last_24h' ? '24 hours' : '7 days'} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Accepted uses durable ingest time. Rejected uses bounded warning occurrences
        {data.coverage.rejected_history_first_observed_at
          ? ` available from the first recorded occurrence at ${new Date(data.coverage.rejected_history_first_observed_at).toLocaleString()}.`
          : ' has no recorded occurrence in the available server history.'}
      </p>
    </Panel>

    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title={<h3>Improvements</h3>}>
        {data.improvements.length === 0
          ? <EmptyState headline="No current repair" lead="No bounded warning signature needs attention." />
          : <div className="space-y-3">
            {data.improvements.map((finding) => {
              const issue = data.issue_signatures.find((candidate) => candidate.signature_id === finding.signature_id)!;
              const result = verification[issue.signature_id];
              const error = verifyError[issue.signature_id];
              return <article
                key={issue.signature_id}
                className={cn(
                  'rounded-control border p-3',
                  focusedSignature === issue.signature_id && 'border-brand-strong ring-2 ring-primary/20',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{finding.title}</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {issue.novelty.state === 'new' && <Badge variant="outline">New in current 24h</Badge>}
                    <Badge variant={finding.severity === 'high' ? 'destructive' : 'secondary'}>{finding.severity}</Badge>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fmtNum(issue.count)} occurrence{issue.count === 1 ? '' : 's'} · last seen {new Date(issue.last_seen).toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {issue.novelty.state === 'new'
                    ? `${fmtNum(issue.novelty.current_window.count)} in current 24h · none in previous 24h`
                    : issue.novelty.state === 'recurring'
                      ? `${fmtNum(issue.novelty.current_window.count)} in current 24h · ${fmtNum(issue.novelty.comparison_baseline.count)} in previous 24h`
                      : 'No occurrence in current 24h · retained historical signature'}
                </p>
                {issue.registered_event_name && <code className="mt-2 block text-xs">{issue.registered_event_name}</code>}
                <p className="mt-2 break-words text-xs">
                  <span className="font-medium">Affected answers:</span> {finding.affected_answer_ids.join(', ')}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline"><Link to={finding.repair_action.href}>{finding.repair_action.label}</Link></Button>
                  <Button size="sm" onClick={() => void verify(issue.signature_id)} disabled={verifying === issue.signature_id}>
                    {verifying === issue.signature_id ? 'Verifying…' : 'Verify fix'}
                  </Button>
                </div>
                {result && <p className={cn('mt-2 text-xs font-medium', result.status === 'resolved' ? 'text-foreground' : 'text-destructive')} role="status">
                  {result.status === 'resolved'
                    ? 'No recurrence after this watermark'
                    : `${fmtNum(result.occurrences_since_watermark)} new occurrence${result.occurrences_since_watermark === 1 ? '' : 's'} after this watermark`}
                </p>}
                {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
                <details className="mt-2 text-xs text-muted-foreground">
                  <DisclosureSummary className="cursor-pointer">Evidence watermark</DisclosureSummary>
                  <code className="mt-1 block break-all">{issue.signature_id} · {issue.watermark.count} · {issue.watermark.last_seen}</code>
                  <code className="mt-1 block break-all">
                    Novelty baseline · {issue.novelty.comparison_baseline.from} to {issue.novelty.comparison_baseline.to} · {issue.novelty.comparison_baseline.count}
                  </code>
                </details>
              </article>;
            })}
          </div>}
      </Panel>

      <Panel title={<h3>Doing well</h3>}>
        {data.doing_well.length === 0
          ? <EmptyState headline="No healthy claim yet" lead="Poolstatis needs accepted evidence before making a positive claim." />
          : <div className="space-y-3">
            {data.doing_well.map((finding) => <article key={finding.code} className="rounded-control border border-success/30 bg-success/5 p-3">
              <div className="flex items-start gap-2">
                <span className="mt-1 size-2 shrink-0 rounded-full bg-success" />
                <div>
                  <h4 className="text-sm font-medium">{finding.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{finding.evidence}</p>
                </div>
              </div>
            </article>)}
          </div>}
      </Panel>
    </div>
  </>;
}

function FlowStat({ label, value, note, danger = false }: { label: string; value: number; note: string; danger?: boolean }) {
  return <div className="rounded-control border p-3">
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <div className={cn('serif mt-1 text-3xl tabular-nums', danger && 'text-destructive')}>{fmtNum(value)}</div>
    <div className="mt-1 text-xs text-muted-foreground">{note}</div>
  </div>;
}

function DataFlowChart({ window, label }: { window: DataHealthWindow; label: string }) {
  const width = 720;
  const height = 220;
  const inset = 22;
  const chartWidth = width - inset * 2;
  const chartHeight = height - inset * 2;
  const maxAccepted = Math.max(1, ...window.points.map((point) => point.accepted));
  const maxRejected = Math.max(1, ...window.points.map((point) => point.rejected));
  const x = (index: number) => inset + (window.points.length <= 1 ? 0 : (index / (window.points.length - 1)) * chartWidth);
  const yAccepted = (value: number) => inset + chartHeight - (value / maxAccepted) * chartHeight;
  const yRejected = (value: number) => inset + chartHeight - (value / maxRejected) * chartHeight;
  const acceptedPath = window.points.map((point, index) => `${x(index)},${yAccepted(point.accepted)}`).join(' ');
  const rejectedPath = window.points.map((point, index) => `${x(index)},${yRejected(point.rejected)}`).join(' ');
  return <div className="min-w-0">
    <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-brand-strong" />Accepted</span>
      <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 bg-destructive" />Rejected</span>
    </div>
    <svg
      role="img"
      aria-label={`Accepted and rejected observations for ${label}`}
      viewBox={`0 0 ${width} ${height}`}
      className="h-56 w-full overflow-visible"
    >
      {[0, 0.5, 1].map((part) => <line key={part} x1={inset} x2={width - inset} y1={inset + part * chartHeight} y2={inset + part * chartHeight} className="stroke-border" />)}
      {window.points.length > 0 && <>
        <polyline points={acceptedPath} fill="none" className="stroke-brand-strong" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        <polyline points={rejectedPath} fill="none" className="stroke-destructive" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {window.points.map((point, index) => point.rejected > 0 && <circle key={point.bucket} cx={x(index)} cy={yRejected(point.rejected)} r="4" className="fill-destructive" />)}
      </>}
    </svg>
    <div className="flex justify-between text-xs text-muted-foreground">
      <span>{new Date(window.from).toLocaleString()}</span>
      <span>{new Date(window.to).toLocaleString()}</span>
    </div>
    <details className="mt-3 rounded-control border">
      <DisclosureSummary className="cursor-pointer px-3 py-2 text-sm font-medium">View accepted and rejected data table</DisclosureSummary>
      <div className="border-t">
        <TableScroll>
          <Table aria-label={`Accepted and rejected observations for ${label}`}>
            <TableHeader><TableRow><TableHead>UTC bucket</TableHead><TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Rejected</TableHead></TableRow></TableHeader>
            <TableBody>{window.points.map((point) => <TableRow key={point.bucket}>
              <TableCell><code className="text-xs">{point.bucket}</code></TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtNum(point.accepted)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtNum(point.rejected)}</TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </TableScroll>
      </div>
    </details>
  </div>;
}
