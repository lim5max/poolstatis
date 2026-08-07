import { useState } from 'react';
import { EmptyState, ErrorNote, FieldLabel, Loading, Panel, RecoverableError, TableScroll, WarningNote } from '../components/ui';
import { useAsync, useStore } from '../store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OrganizationUsage, OrganizationUsageActivity } from '../api/types';

function currentUtcMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function whole(value: number | string): string {
  return new Intl.NumberFormat('en-US').format(typeof value === 'string' ? BigInt(value) : value);
}

function utcDate(daysAgo = 0): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function activityRange(days: number): { from: string; to: string } {
  return { from: utcDate(days - 1), to: utcDate() };
}

type UsageProject = OrganizationUsage['projects'][number] | OrganizationUsageActivity['projects'][number];

function UsageBreakdown({ projects, testId }: {
  projects: UsageProject[];
  testId: string;
}) {
  return (
    <TableScroll testId={testId}><Table>
      <TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Environment</TableHead><TableHead className="text-right">Accepted events</TableHead></TableRow></TableHeader>
      <TableBody>{projects.flatMap((project) => project.environments.map((environment, index) => <TableRow key={`${project.id}:${environment.env}`}>
        <TableCell>{index === 0 ? <><div className="font-medium">{project.name}</div><code className="mono text-sm text-muted-foreground">{project.slug}</code></> : <span className="text-muted-foreground">↳</span>}</TableCell>
        <TableCell><code className="mono text-sm">{environment.env}</code></TableCell>
        <TableCell className="mono text-right text-sm tabular-nums">{whole(environment.quantity)}</TableCell>
      </TableRow>))}</TableBody>
    </Table></TableScroll>
  );
}

export function validateUsageActivityRange(range: { from: string; to: string }): string | null {
  const pattern = /^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  if (!pattern.test(range.from) || !pattern.test(range.to)) return 'Choose both dates in YYYY-MM-DD format.';
  const fromMs = Date.parse(`${range.from}T00:00:00.000Z`);
  const toMs = Date.parse(`${range.to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)
    || new Date(fromMs).toISOString().slice(0, 10) !== range.from
    || new Date(toMs).toISOString().slice(0, 10) !== range.to) {
    return 'Choose valid UTC calendar dates.';
  }
  const days = Math.floor((toMs - fromMs) / 86_400_000) + 1;
  if (days < 1) return 'The start date must not be after the end date.';
  if (days > 93) return 'Choose a range of 93 days or fewer.';
  return null;
}

function ActivityPanel({ activity, loading, error, reload, range, preset, onPreset, onRange }: {
  activity: OrganizationUsageActivity | null | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
  range: { from: string; to: string };
  preset: number | null;
  onPreset: (days: number) => void;
  onRange: (range: { from: string; to: string }) => void;
}) {
  return (
    <Panel title={<h2>Accepted-event activity</h2>}>
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {[7, 30, 90].map((days) => (
            <Button
              key={days}
              variant={preset === days ? 'default' : 'outline'}
              aria-pressed={preset === days}
              onClick={() => onPreset(days)}
            >
              Last {days} days
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Label className="grid gap-1.5 text-sm text-muted-foreground">
            Activity from
            <Input aria-label="Activity from" type="date" value={range.from} onChange={(event) => onRange({ ...range, from: event.target.value })} />
          </Label>
          <Label className="grid gap-1.5 text-sm text-muted-foreground">
            Activity to
            <Input aria-label="Activity to" type="date" value={range.to} onChange={(event) => onRange({ ...range, to: event.target.value })} />
          </Label>
        </div>
      </div>
      <div className="pt-5">
        {loading || (!activity && !error) ? <Loading what="Loading accepted-event activity…" />
          : error ? error.startsWith('Choose ') || error.startsWith('The start date')
            ? <ErrorNote>{error}</ErrorNote>
            : <RecoverableError onRetry={reload}>{error}</RecoverableError>
            : activity && <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Accepted events stored</div>
                  <div className="mono mt-1 text-3xl tabular-nums">{whole(activity.quantity)}</div>
                </div>
                <p className="max-w-lg text-sm text-muted-foreground">Ledger ingestion from {activity.date_from} through {activity.date_to} UTC. This is activity, not a prorated billing limit.</p>
              </div>
              <div className="mt-5">
                {activity.projects.length === 0
                  ? <EmptyState headline="No accepted events in this range" lead="Choose another period or send one real event." />
                  : <UsageBreakdown projects={activity.projects} testId="usage-activity-breakdown-scroll" />}
              </div>
            </>}
      </div>
    </Panel>
  );
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
  const [range, setRange] = useState(() => activityRange(30));
  const [preset, setPreset] = useState<number | null>(30);
  const allowed = tokenKind === 'personal' || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const result = useAsync(() => client && allowed ? client.usage(period) : Promise.resolve(null), [client, allowed, period]);
  const rangeError = validateUsageActivityRange(range);
  const activity = useAsync(() => client && allowed && !rangeError ? client.usageActivity(range.from, range.to) : Promise.resolve(null), [client, allowed, range.from, range.to, rangeError]);

  if (!allowed || !client) {
    return <Panel title="Usage"><EmptyState headline="Usage unavailable" lead="An organization owner or admin can read the workspace usage ledger." /></Panel>;
  }

  const usage = result.data;
  return (
    <div className="space-y-4">
      <header>
        <h1 className="serif text-3xl sm:text-4xl">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">Accepted-event activity and the separate monthly workspace quota.</p>
      </header>
      <ActivityPanel
        activity={activity.data}
        loading={activity.loading}
        error={rangeError ?? activity.error}
        reload={activity.reload}
        range={range}
        preset={preset}
        onPreset={(days) => { setPreset(days); setRange(activityRange(days)); }}
        onRange={(next) => { setPreset(null); setRange(next); }}
      />
      <Panel title={<h2>Monthly quota</h2>} right={<div className="space-y-1"><Label htmlFor="usage-period" className="text-sm text-muted-foreground">UTC month</Label><Input id="usage-period" aria-label="UTC month" type="month" value={period} onChange={(event) => setPeriod(event.target.value)} /></div>}>
        {result.loading || (!usage && !result.error) ? <Loading what="Loading usage ledger…" /> : result.error ? <RecoverableError onRetry={result.reload}>{result.error}</RecoverableError> : usage && <LedgerRail usage={usage} />}
      </Panel>
      {usage?.warnings.map((warning) => <WarningNote key={warning.threshold}>Warning threshold reached: {whole(warning.threshold)} events.</WarningNote>)}
      {usage && (usage.projects.length === 0 ? <Panel title="Monthly breakdown"><EmptyState headline={`No stored events in ${usage.period}`} lead="Accepted events will appear here after durable ingest." /></Panel> : <Panel title="Monthly breakdown" right={<span className="mono text-sm text-muted-foreground">{usage.meter}</span>}>
        <UsageBreakdown projects={usage.projects} testId="usage-breakdown-scroll" />
      </Panel>)}
    </div>
  );
}
