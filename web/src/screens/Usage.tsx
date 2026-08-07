import { useState } from 'react';
import { EmptyState, ErrorNote, FieldLabel, Loading, Panel, RecoverableError, TableScroll, WarningNote } from '../components/ui';
import { useAsync, useStore } from '../store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { OrganizationUsage, OrganizationUsageActivity, OrganizationUsageRange } from '../api/types';

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

type MonthRangePreset = 'current' | 'last' | 'last-3' | 'last-6';

function offsetUtcMonth(period: string, offset: number): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const index = year * 12 + month - 1 + offset;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
}

export function usageMonthPresetRange(preset: MonthRangePreset, current = currentUtcMonth()): { from: string; to: string } {
  if (preset === 'last') {
    const last = offsetUtcMonth(current, -1);
    return { from: last, to: last };
  }
  if (preset === 'last-3') return { from: offsetUtcMonth(current, -2), to: current };
  if (preset === 'last-6') return { from: offsetUtcMonth(current, -5), to: current };
  return { from: current, to: current };
}

export function validateUsageMonthRange(range: { from: string; to: string }): string | null {
  const pattern = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
  if (!pattern.test(range.from) || !pattern.test(range.to)) return 'Choose both months in YYYY-MM format.';
  const index = (period: string) => {
    const [year, month] = period.split('-').map(Number) as [number, number];
    return year * 12 + month - 1;
  };
  const months = index(range.to) - index(range.from) + 1;
  if (months < 1) return 'The start month must not be after the end month.';
  if (months > 12) return 'Choose a range of 12 months or fewer.';
  return null;
}

type UsageProject = OrganizationUsage['projects'][number]
  | OrganizationUsageActivity['projects'][number]
  | OrganizationUsageRange['periods'][number]['projects'][number];

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

const MONTH_PRESETS: Array<{ key: MonthRangePreset; label: string }> = [
  { key: 'current', label: 'Current month' },
  { key: 'last', label: 'Last month' },
  { key: 'last-3', label: 'Last 3 months' },
  { key: 'last-6', label: 'Last 6 months' },
];

function MonthRangePanel({ usage, loading, error, reload, range, preset, onPreset, onRange }: {
  usage: OrganizationUsageRange | null | undefined;
  loading: boolean;
  error: string | null;
  reload: () => void;
  range: { from: string; to: string };
  preset: MonthRangePreset | null;
  onPreset: (preset: MonthRangePreset) => void;
  onRange: (range: { from: string; to: string }) => void;
}) {
  return (
    <Panel title={<h2>Monthly usage history</h2>}>
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {MONTH_PRESETS.map((option) => (
            <Button
              key={option.key}
              variant={preset === option.key ? 'default' : 'outline'}
              aria-pressed={preset === option.key}
              onClick={() => onPreset(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Label className="grid gap-1.5 text-sm text-muted-foreground">
            Month from
            <Input aria-label="Usage month from" type="month" value={range.from} onChange={(event) => onRange({ ...range, from: event.target.value })} />
          </Label>
          <Label className="grid gap-1.5 text-sm text-muted-foreground">
            Month to
            <Input aria-label="Usage month to" type="month" value={range.to} onChange={(event) => onRange({ ...range, to: event.target.value })} />
          </Label>
        </div>
      </div>
      <div className="pt-5">
        {loading || (!usage && !error) ? <Loading what="Loading monthly usage…" />
          : error ? error.startsWith('Choose ') || error.startsWith('The start month')
            ? <ErrorNote>{error}</ErrorNote>
            : <RecoverableError onRetry={reload}>{error}</RecoverableError>
            : usage && <>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Accepted events stored</div>
                  <div className="mono mt-1 text-3xl tabular-nums">{whole(usage.quantity)}</div>
                </div>
                <p className="max-w-lg text-sm text-muted-foreground">
                  Grouped by UTC ingest month. Historical backfills count when stored; the current entitlement below is not historical.
                </p>
              </div>
              <div className="mt-5 divide-y rounded-panel border">
                {usage.periods.map((period) => (
                  <section key={period.period} className="p-4" aria-label={`Usage for ${period.period}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium">{period.period}</h3>
                      <span className="mono text-sm tabular-nums">{whole(period.quantity)} events</span>
                    </div>
                    {BigInt(period.unattributed_quantity) !== 0n && (
                      <WarningNote>{whole(period.unattributed_quantity)} events without retained project attribution</WarningNote>
                    )}
                    {period.warnings.map((warning) => (
                      <WarningNote key={warning.threshold}>
                        {whole(warning.threshold)} event threshold reached at {whole(warning.quantity)} events
                      </WarningNote>
                    ))}
                    <div className="mt-3">
                      {period.projects.length === 0
                        ? <p className="text-sm text-muted-foreground">No retained project breakdown for this month.</p>
                        : <UsageBreakdown projects={period.projects} testId={`usage-range-breakdown-${period.period}`} />}
                    </div>
                  </section>
                ))}
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
  const currentPeriod = currentUtcMonth();
  const [activitySelection, setActivitySelection] = useState(() => activityRange(30));
  const [activityPreset, setActivityPreset] = useState<number | null>(30);
  const [monthSelection, setMonthSelection] = useState(() => usageMonthPresetRange('current', currentPeriod));
  const [monthPreset, setMonthPreset] = useState<MonthRangePreset | null>('current');
  const allowed = tokenKind === 'personal' || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const result = useAsync(() => client && allowed ? client.usage(currentPeriod) : Promise.resolve(null), [client, allowed, currentPeriod]);
  const activityError = validateUsageActivityRange(activitySelection);
  const activity = useAsync(
    () => client && allowed && !activityError ? client.usageActivity(activitySelection.from, activitySelection.to) : Promise.resolve(null),
    [client, allowed, activitySelection.from, activitySelection.to, activityError],
  );
  const monthError = validateUsageMonthRange(monthSelection);
  const monthly = useAsync(
    () => client && allowed && !monthError ? client.usageRange(monthSelection.from, monthSelection.to) : Promise.resolve(null),
    [client, allowed, monthSelection.from, monthSelection.to, monthError],
  );

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
        error={activityError ?? activity.error}
        reload={activity.reload}
        range={activitySelection}
        preset={activityPreset}
        onPreset={(days) => { setActivityPreset(days); setActivitySelection(activityRange(days)); }}
        onRange={(next) => { setActivityPreset(null); setActivitySelection(next); }}
      />
      <MonthRangePanel
        usage={monthly.data}
        loading={monthly.loading}
        error={monthError ?? monthly.error}
        reload={monthly.reload}
        range={monthSelection}
        preset={monthPreset}
        onPreset={(next) => {
          setMonthPreset(next);
          setMonthSelection(usageMonthPresetRange(next, currentPeriod));
        }}
        onRange={(next) => { setMonthPreset(null); setMonthSelection(next); }}
      />
      <Panel title={<h2>Current monthly quota</h2>} right={<span className="mono text-sm text-muted-foreground">{currentPeriod} UTC</span>}>
        {result.loading || (!usage && !result.error) ? <Loading what="Loading usage ledger…" /> : result.error ? <RecoverableError onRetry={result.reload}>{result.error}</RecoverableError> : usage && <LedgerRail usage={usage} />}
      </Panel>
      {usage?.warnings.map((warning) => <WarningNote key={warning.threshold}>Warning threshold reached: {whole(warning.threshold)} events.</WarningNote>)}
      {usage && (usage.projects.length === 0 ? <Panel title="Current-month breakdown"><EmptyState headline={`No stored events in ${usage.period}`} lead="Accepted events will appear here after durable ingest." /></Panel> : <Panel title="Current-month breakdown" right={<span className="mono text-sm text-muted-foreground">{usage.meter}</span>}>
        <UsageBreakdown projects={usage.projects} testId="usage-breakdown-scroll" />
      </Panel>)}
    </div>
  );
}
