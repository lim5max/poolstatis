import { useState } from 'react';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, TableScroll, WarningNote } from '../components/ui';
import { useAsync, useStore } from '../store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DisclosureSummary } from '@/components/disclosure';
import type { OrganizationUsage, OrganizationUsageActivity, OrganizationUsageRange, UsageControlResult } from '../api/types';

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

function formatForecastDate(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(value));
}

function UsageHero({ usage, planName, onReviewContributors }: { usage: UsageControlResult; planName: string | null; onReviewContributors: () => void }) {
  const capped = usage.cap.state === 'finite' && usage.cap.value !== null;
  const quantity = typeof usage.answer.primary_value?.value === 'number' ? usage.answer.primary_value.value : null;
  const progress = capped && quantity !== null && usage.cap.value! > 0
    ? Math.max(0, Math.min(1, quantity / usage.cap.value!))
    : null;
  const status = capped
    ? usage.cap.remaining === 0 ? 'Hard limit reached' : `${whole(usage.cap.remaining ?? 0)} events remaining`
    : 'No hard cap configured';
  const hardLimitForecast = usage.threshold_forecasts.find((threshold) => threshold.percent === 100);
  const hardLimitDate = hardLimitForecast?.state === 'projected'
    ? formatForecastDate(hardLimitForecast.reached_or_projected_at)
    : null;
  const forecastNote = usage.pace.confidence === 'insufficient'
    ? `Forecast unavailable · ${usage.pace.observed_days} observed days`
    : hardLimitDate
      ? `Projected ${hardLimitDate}`
      : capped
        ? 'No in-cycle breach projected'
        : 'Volume forecast, not exhaustion';
  return (
    <Panel title={<h2>Current cycle</h2>} right={<span className="font-mono text-sm text-muted-foreground">{usage.cycle.from.slice(0, 7)} UTC</span>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">{planName ? `${planName} plan` : 'Workspace entitlement'} · {usage.meter}</div>
          <h2 className="mt-2 text-xl font-semibold">{usage.answer.headline}</h2>
          <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
            <div className="font-mono text-4xl font-semibold tabular-nums">{usage.answer.primary_value?.formatted ?? 'Unavailable'}</div>
            <div className="pb-1 text-sm text-muted-foreground">of {capped ? whole(usage.cap.value!) : 'no enforced maximum'}</div>
          </div>
          <div className="mt-4" {...(capped ? { role: 'img', 'aria-label': `${Math.round(progress! * 100)} percent of the configured hard limit used` } : {})}>
            {progress !== null && <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all motion-reduce:transition-none" style={{ width: `${progress * 100}%` }} /></div>}
            <div className="mt-2 text-sm font-medium">{status}</div>
            {!capped && <p className="mt-1 text-sm text-muted-foreground">This is not shown as unlimited and no full progress state is implied.</p>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <UsageFact label="Current pace" value={usage.pace.events_per_day_7d === null ? 'Unavailable' : `${whole(Math.round(usage.pace.events_per_day_7d))} / day`} note={`${usage.pace.observed_days} observed ingest days`} />
          <UsageFact label="Projected cycle end" value={usage.pace.projected_cycle_end === null ? 'Unavailable' : whole(Math.round(usage.pace.projected_cycle_end))} note={forecastNote} />
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">{usage.cap.consequence_at_100_percent ?? 'Accepted events continue to be metered; configure an entitlement server-side if enforcement is required.'}</p>
        <Button className="h-11 shrink-0" onClick={onReviewContributors}>Review contributors</Button>
      </div>
    </Panel>
  );
}

function UsageFact({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="rounded-control border bg-muted/20 p-3"><div className="text-sm text-muted-foreground">{label}</div><div className="mt-1 font-mono text-xl tabular-nums">{value}</div><div className="mt-1 text-sm text-muted-foreground">{note}</div></div>;
}

function CurrentContributors({ usage }: { usage: UsageControlResult }) {
  return (
    <Panel title={<h2 id="usage-contributors-title">Current contributors</h2>} right={<span className="text-sm text-muted-foreground">Current UTC cycle</span>}>
      {usage.contributors.length === 0 ? <EmptyState headline={`No stored events in ${usage.cycle.from.slice(0, 7)}`} lead="Accepted events will appear here after durable ingest." /> : (
        <TableScroll testId="usage-breakdown-scroll"><Table>
          <TableHeader><TableRow><TableHead>Project</TableHead><TableHead>Environment</TableHead><TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">7-day change</TableHead><TableHead>Last ingest</TableHead></TableRow></TableHeader>
          <TableBody>{usage.contributors.map((project) => (
            <TableRow key={`${project.project_slug}:${project.environment}`}>
              <TableCell><div className="font-medium">{project.project_name}</div><code className="text-sm text-muted-foreground">{project.project_slug}</code></TableCell>
              <TableCell><code className="text-sm">{project.environment}</code></TableCell>
              <TableCell className="text-right font-mono tabular-nums">{whole(project.accepted_events)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{project.share === null ? 'Unavailable' : `${Math.round(project.share * 1_000) / 10}%`}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{project.change_7d === null ? 'Unavailable' : `${project.change_7d >= 0 ? '+' : ''}${Math.round(project.change_7d * 1_000) / 10}%`}</TableCell>
              <TableCell>{project.last_ingest_at ? fmtUsageRelative(project.last_ingest_at) : 'Unavailable'}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table></TableScroll>
      )}
    </Panel>
  );
}

function fmtUsageRelative(value: string): string {
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta)) return 'Unavailable';
  const minutes = Math.max(0, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const THRESHOLD_MEANING = {
  50: 'Information',
  75: 'Attention',
  90: 'Action recommended',
  100: 'Enforced consequence',
} as const;

function UsageThresholds({ usage }: { usage: UsageControlResult }) {
  return (
    <Panel title={<h2>Thresholds and consequence</h2>}>
      <div className="divide-y rounded-panel border">
        {usage.threshold_forecasts.map((threshold) => (
          <div key={threshold.percent} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
            <div><span className="font-mono tabular-nums">{threshold.percent}%</span><span className="ml-2 text-muted-foreground">{THRESHOLD_MEANING[threshold.percent]}</span></div>
            <span className={threshold.state === 'reached' || threshold.state === 'projected' ? 'font-medium text-warning' : 'text-muted-foreground'}>
              {threshold.state === 'reached' ? `Reached${formatForecastDate(threshold.reached_or_projected_at) ? ` ${formatForecastDate(threshold.reached_or_projected_at)}` : ''}`
                : threshold.state === 'projected' ? `Projected ${formatForecastDate(threshold.reached_or_projected_at)}`
                  : threshold.state === 'not_applicable' ? 'Not applicable without a cap' : 'Not projected'}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">{usage.cap.consequence_at_100_percent ?? 'Hard-limit consequence is not configured.'}</p>
    </Panel>
  );
}

export function Usage() {
  const { client, tokenKind, account } = useStore();
  const currentPeriod = currentUtcMonth();
  const [activitySelection, setActivitySelection] = useState(() => activityRange(30));
  const [activityPreset, setActivityPreset] = useState<number | null>(30);
  const [monthSelection, setMonthSelection] = useState(() => usageMonthPresetRange('current', currentPeriod));
  const [monthPreset, setMonthPreset] = useState<MonthRangePreset | null>('current');
  const [historyOpen, setHistoryOpen] = useState(false);
  const allowed = tokenKind === 'personal' || (tokenKind === 'user' && (account?.membership.role === 'owner' || account?.membership.role === 'admin'));
  const result = useAsync(() => client && allowed ? client.usageControl(currentPeriod) : Promise.resolve(null), [client, allowed, currentPeriod]);
  const activityError = validateUsageActivityRange(activitySelection);
  const activity = useAsync(
    () => client && allowed && historyOpen && !activityError ? client.usageActivity(activitySelection.from, activitySelection.to) : Promise.resolve(null),
    [client, allowed, historyOpen, activitySelection.from, activitySelection.to, activityError],
  );
  const monthError = validateUsageMonthRange(monthSelection);
  const monthly = useAsync(
    () => client && allowed && historyOpen && !monthError ? client.usageRange(monthSelection.from, monthSelection.to) : Promise.resolve(null),
    [client, allowed, historyOpen, monthSelection.from, monthSelection.to, monthError],
  );

  if (!allowed || !client) {
    return <Panel title="Usage"><EmptyState headline="Usage unavailable" lead="An organization owner or admin can read the workspace usage ledger." /></Panel>;
  }

  const usage = result.data;
  return (
    <div className="space-y-4">
      <header>
        <h1 className="serif text-3xl sm:text-4xl">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">Plan, current pace, forecast, contributors, and enforced consequences.</p>
      </header>
      {result.loading || (!usage && !result.error) ? <Loading what="Loading usage ledger…" /> : result.error ? <RecoverableError onRetry={result.reload}>{result.error}</RecoverableError> : usage && (
        <>
          <UsageHero
            usage={usage}
            planName={account?.billing?.plan?.name ?? null}
            onReviewContributors={() => document.getElementById('usage-contributors-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          />
          {usage.attention.map((item) => <WarningNote key={item.id}>{item.title}: {item.impact}</WarningNote>)}
          <div aria-labelledby="usage-contributors-title"><CurrentContributors usage={usage} /></div>
          <UsageThresholds usage={usage} />
        </>
      )}
      <details className="rounded-panel border bg-card" onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <DisclosureSummary className="flex min-h-14 cursor-pointer items-center px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">Historical ledger and custom ranges</DisclosureSummary>
        <div className="space-y-4 border-t p-4 sm:p-5">
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
        </div>
      </details>
    </div>
  );
}
