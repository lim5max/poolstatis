import { useState } from 'react';
import { ErrorNote, EmptyState, FieldLabel, Loading, Panel, TableScroll, WarningNote } from '../components/ui';
import { useAsync, useStore } from '../store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OrganizationUsage } from '../api/types';

function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function whole(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function LedgerRail({ usage }: { usage: OrganizationUsage }) {
  const finite = (value: number) => Number.isFinite(value) ? value : 0;
  const hardLimit = usage.hard_limit === null ? null : finite(usage.hard_limit);
  const highestThreshold = finite(usage.warning_thresholds.at(-1) ?? 0);
  const scale = Math.max(hardLimit ?? 0, finite(usage.quantity), highestThreshold, 1);
  const progress = Math.max(0, Math.min(1, finite(usage.quantity) / scale));
  const hardLimitPosition = hardLimit === null ? null : Math.max(0, Math.min(1, hardLimit / scale));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div><FieldLabel>Accepted events stored</FieldLabel><div className="mono mt-1 text-2xl tabular-nums">{whole(usage.quantity)}</div></div>
        <div className="text-right text-xs text-muted-foreground">{usage.hard_limit === null ? 'No hard limit configured' : usage.quantity >= usage.hard_limit ? `Hard limit reached — ${whole(usage.hard_limit)} event limit` : `${whole(usage.hard_limit)} event limit`}</div>
      </div>
      <div className="relative h-8" data-testid="usage-ledger-rail" role="img" aria-label={`Usage ledger: ${whole(usage.quantity)} accepted events stored`}>
        <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-muted" />
        <div className="absolute left-0 top-3 h-2 rounded-full bg-primary transition-all motion-reduce:transition-none" style={{ width: `${progress * 100}%` }} />
        {usage.warning_thresholds.map((threshold) => {
          const position = Math.min(1, threshold / scale);
          const crossed = usage.quantity >= threshold;
          return <span key={threshold} className="absolute top-1 flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: `${position * 100}%` }} aria-label={`Warning threshold ${whole(threshold)}${crossed ? ', reached' : ''}`}>
            <span className={crossed ? 'size-2 rounded-full bg-amber-500' : 'size-2 rounded-full border bg-background'} />
            <span className="mono whitespace-nowrap text-xs text-muted-foreground">{whole(threshold)}</span>
          </span>;
        })}
        {hardLimitPosition !== null && <span className="absolute top-1 flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: `${hardLimitPosition * 100}%` }} aria-label={`Hard limit ${whole(hardLimit!)}`}><span className="h-4 w-px bg-destructive" /><span className="mono whitespace-nowrap text-xs text-muted-foreground">limit</span></span>}
      </div>
    </div>
  );
}

export function Usage() {
  const { client, tokenKind, account } = useStore();
  const [period, setPeriod] = useState(currentUtcMonth);
  const allowed = tokenKind === 'personal' || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const result = useAsync(() => client && allowed ? client.usage(period) : Promise.resolve(null), [client, allowed, period]);

  if (!allowed || !client) {
    return <Panel title="Usage"><EmptyState headline="Usage unavailable" lead="An organization owner or admin can read the workspace usage ledger." /></Panel>;
  }

  const usage = result.data;
  return (
    <div className="space-y-4">
      <Panel title="Usage ledger" right={<div className="space-y-1"><Label htmlFor="usage-period" className="text-xs text-muted-foreground">UTC month</Label><Input id="usage-period" aria-label="UTC month" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></div>}>
        {result.loading || (!usage && !result.error) ? <Loading what="Loading usage ledger…" /> : result.error ? <ErrorNote>{result.error}</ErrorNote> : usage && <LedgerRail usage={usage} />}
      </Panel>
      {usage?.warnings.map((warning) => <WarningNote key={warning.threshold}>Warning threshold reached: {whole(warning.threshold)} events.</WarningNote>)}
      {usage && (usage.projects.length === 0 ? <Panel title="Stored events"><EmptyState headline={`No stored events in ${usage.period}`} lead="Accepted events will appear here after durable ingest." /></Panel> : <Panel title="Stored events" right={<span className="mono text-xs text-muted-foreground">{usage.meter}</span>}>
        <TableScroll testId="usage-breakdown-scroll"><Table data-testid="usage-breakdown">
          <TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Environment</TableHead><TableHead className="text-right">Accepted events</TableHead></TableRow></TableHeader>
          <TableBody>{usage.projects.flatMap((project) => project.environments.map((environment, index) => <TableRow key={`${project.id}:${environment.env}`}>
            <TableCell>{index === 0 ? <><div className="font-medium">{project.name}</div><code className="mono text-xs text-muted-foreground">{project.slug}</code></> : <span className="text-muted-foreground">↳</span>}</TableCell>
            <TableCell><code className="mono text-xs">{environment.env}</code></TableCell>
            <TableCell className="mono text-right text-sm tabular-nums">{whole(environment.quantity)}</TableCell>
          </TableRow>))}</TableBody>
        </Table></TableScroll>
      </Panel>)}
    </div>
  );
}
