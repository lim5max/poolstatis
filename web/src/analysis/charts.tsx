import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DisclosureSummary } from '@/components/disclosure';
import { cn } from '@/lib/utils';
import {
  resolveManualRenderer,
  validateVisualizationSpec,
  type AnalysisQueryResult,
  type FunnelQueryResult,
  type LifecycleQueryResult,
  type RetentionQueryResult,
  type StickinessQueryResult,
  type TrendQueryResult,
  type VisualizationSpec,
} from './visualization';
import { chartSeriesStroke } from './chartTokens';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

const AXIS = {
  tickLine: false,
  axisLine: false,
  tick: { fill: 'var(--muted-foreground)', fontSize: 12 },
} as const;

function ChartFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="h-60 min-w-0 w-full" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%" minWidth={280} minHeight={220}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

function ChartTooltip() {
  return (
    <Tooltip
      cursor={{ fill: 'var(--muted)', opacity: 0.55 }}
      contentStyle={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-panel)',
        background: 'var(--popover)',
        color: 'var(--popover-foreground)',
        fontSize: 12,
      }}
      labelStyle={{ color: 'var(--foreground)', fontWeight: 600 }}
    />
  );
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

export function TrendChart({ result, label }: { result: TrendQueryResult; label: string }) {
  return (
    <ChartFrame label={label}>
      <AreaChart accessibilityLayer data={result.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="poolstatis-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.38} />
            <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} dataKey="bucket" tickFormatter={shortDate} minTickGap={28} tickMargin={10} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <ChartTooltip />
        <Area
          type="monotone"
          dataKey="value"
          name={label}
          stroke="var(--chart-1-stroke)"
          strokeWidth={2.25}
          fill="url(#poolstatis-trend-fill)"
          activeDot={{ r: 5, stroke: 'var(--chart-1-stroke)', strokeWidth: 2, fill: 'var(--chart-1)' }}
        />
      </AreaChart>
    </ChartFrame>
  );
}

export function BreakdownBars({ result }: { result: TrendQueryResult }) {
  const seriesKeys = [...new Set(result.series.map((point) => point.breakdown_value ?? 'unclassified'))];
  const rows = [...new Set(result.series.map((point) => point.bucket))].map((bucket) => {
    const row: Record<string, string | number> = { bucket };
    for (const key of seriesKeys) {
      row[key] = result.series.find((point) => point.bucket === bucket && (point.breakdown_value ?? 'unclassified') === key)?.value ?? 0;
    }
    return row;
  });
  return (
    <ChartFrame label="Grouped breakdown bars">
      <BarChart accessibilityLayer data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} dataKey="bucket" tickFormatter={shortDate} minTickGap={28} tickMargin={10} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <ChartTooltip />
        <Legend />
        {seriesKeys.map((key, index) => (
          <Bar
            key={key}
            dataKey={key}
            fill={CHART_COLORS[index % CHART_COLORS.length]}
            stroke={chartSeriesStroke(index)}
            strokeWidth={chartSeriesStroke(index) ? 1.5 : 0}
            radius={[4, 4, 0, 0]}
          />
        ))}
      </BarChart>
    </ChartFrame>
  );
}

export function FunnelChart({ result }: { result: FunnelQueryResult }) {
  return (
    <ChartFrame label="Funnel step actor counts">
      <BarChart accessibilityLayer data={result.steps} layout="vertical" margin={{ top: 8, right: 18, bottom: 0, left: 8 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} type="number" allowDecimals={false} />
        <YAxis {...AXIS} type="category" dataKey="label" width={112} tickMargin={8} />
        <ChartTooltip />
        <Bar dataKey="actors" name="Actors" fill="var(--chart-1)" stroke="var(--chart-1-stroke)" radius={[0, 6, 6, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

export function RetentionMatrix({ result }: { result: RetentionQueryResult }) {
  const periods = Math.max(0, ...result.cohorts.map((cohort) => cohort.retained_pct.length));
  return (
    <div className="overflow-x-auto" aria-label="Retention cohort matrix">
      <table className="w-full min-w-xl border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="px-2 py-2 text-left font-medium text-muted-foreground">Cohort</th>
            <th className="px-2 py-2 text-right font-medium text-muted-foreground">Actors</th>
            {Array.from({ length: periods }, (_, index) => (
              <th key={index} className="px-2 py-2 text-right font-medium text-muted-foreground">P{index}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((cohort) => (
            <tr key={cohort.cohort}>
              <th className="whitespace-nowrap px-2 py-2 text-left font-mono font-normal">{shortDate(cohort.cohort)}</th>
              <td className="px-2 py-2 text-right font-mono tabular-nums">{cohort.size}</td>
              {cohort.retained_pct.map((value, index) => {
                const mature = index < cohort.mature_periods;
                return (
                  <td
                    key={index}
                    className={cn(
                      'rounded-control px-2 py-2 text-right font-mono tabular-nums',
                      mature ? 'text-foreground' : 'border border-dashed text-muted-foreground',
                    )}
                    style={mature ? { background: `color-mix(in oklab, var(--chart-1) ${Math.max(8, Math.round(value * 58))}%, var(--card))` } : undefined}
                    title={mature ? `${Math.round(value * 100)}% retained` : 'Right-censored: this period has not fully elapsed'}
                  >
                    {mature ? `${Math.round(value * 100)}%` : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RetentionCurve({ result }: { result: RetentionQueryResult }) {
  const periods = Math.max(0, ...result.cohorts.map((cohort) => cohort.retained_pct.length));
  const data = Array.from({ length: periods }, (_, index) => {
    const mature = result.cohorts.filter((cohort) => index < cohort.mature_periods);
    const value = mature.length === 0 ? null : mature.reduce((sum, cohort) => sum + (cohort.retained_pct[index] ?? 0), 0) / mature.length;
    return { period: `P${index}`, retained: value === null ? null : Number((value * 100).toFixed(1)) };
  });
  return (
    <ChartFrame label="Average mature retention curve">
      <LineChart accessibilityLayer data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} dataKey="period" tickMargin={10} />
        <YAxis {...AXIS} width={44} domain={[0, 100]} unit="%" />
        <ChartTooltip />
        <Line type="monotone" dataKey="retained" name="Retained" stroke="var(--chart-1-stroke)" strokeWidth={2.25} connectNulls={false} />
      </LineChart>
    </ChartFrame>
  );
}

export function StickinessHistogram({ result }: { result: StickinessQueryResult }) {
  return (
    <ChartFrame label="Actor stickiness histogram">
      <BarChart accessibilityLayer data={result.bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} dataKey="intervals_active" tickMargin={10} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <ChartTooltip />
        <Bar dataKey="actors" name="Actors" fill="var(--chart-3)" radius={[5, 5, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}

export function LifecycleChart({ result }: { result: LifecycleQueryResult }) {
  return (
    <ChartFrame label="Stacked lifecycle actor counts">
      <BarChart accessibilityLayer data={result.series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis {...AXIS} dataKey="bucket" tickFormatter={shortDate} minTickGap={28} tickMargin={10} />
        <YAxis {...AXIS} width={44} allowDecimals={false} />
        <ChartTooltip />
        <Legend />
        <Bar dataKey="new" name="New" stackId="lifecycle" fill="var(--chart-1)" stroke="var(--chart-1-stroke)" strokeWidth={1.5} />
        <Bar dataKey="returning" name="Returning" stackId="lifecycle" fill="var(--chart-2)" />
        <Bar dataKey="resurrecting" name="Resurrecting" stackId="lifecycle" fill="var(--chart-3)" />
        <Bar dataKey="dormant" name="Dormant" stackId="lifecycle" fill="var(--chart-4)" />
      </BarChart>
    </ChartFrame>
  );
}

export function ManualVisualizationRenderer({ spec, result }: { spec: VisualizationSpec; result: AnalysisQueryResult }) {
  const validation = validateVisualizationSpec(spec);
  if (!validation.valid) {
    return <div role="alert" className="rounded-panel border border-destructive/35 bg-destructive/8 p-4 text-sm text-destructive">Visualization contract rejected: {validation.errors.join('; ')}</div>;
  }
  const renderer = resolveManualRenderer(spec.kind, result.kind);
  if (!renderer) {
    return <div role="alert" className="rounded-panel border border-destructive/35 bg-destructive/8 p-4 text-sm text-destructive">Result shape does not match the approved renderer.</div>;
  }

  return (
    <section className="overflow-hidden rounded-dialog border bg-card" aria-labelledby={`${spec.id}-title`}>
      <header className="border-b px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${spec.id}-title`} className="serif text-xl">{spec.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{spec.question}</p>
          </div>
          <TrustBadge status={spec.trust.status} />
        </div>
        <p className="mt-3 max-w-3xl text-sm"><span className="font-medium">Purpose:</span> {spec.purpose}</p>
      </header>

      <div className="px-2 py-4 sm:px-5">
        {result.kind === 'trend' && renderer === 'breakdown' && <BreakdownBars result={result} />}
        {result.kind === 'trend' && renderer === 'trend' && <TrendChart result={result} label={spec.display.series[0]?.label ?? spec.title} />}
        {result.kind === 'funnel' && renderer === 'funnel' && <FunnelChart result={result} />}
        {result.kind === 'retention' && renderer === 'retention_matrix' && <RetentionMatrix result={result} />}
        {result.kind === 'retention' && renderer === 'retention_curve' && <RetentionCurve result={result} />}
        {result.kind === 'stickiness' && renderer === 'stickiness' && <StickinessHistogram result={result} />}
        {result.kind === 'lifecycle' && renderer === 'lifecycle' && <LifecycleChart result={result} />}
      </div>

      <div className="grid border-t bg-muted/25 text-xs sm:grid-cols-2 lg:grid-cols-5">
        <EvidenceCell label="Scope"><code>{spec.project}</code> · <code>{spec.env}</code></EvidenceCell>
        <EvidenceCell label="Exact period">{formatUtcRange(spec.range.from, spec.range.to)}</EvidenceCell>
        <EvidenceCell label="Aggregation">{spec.evidence.aggregation}{spec.evidence.denominator ? ` / ${spec.evidence.denominator}` : ''}</EvidenceCell>
        <EvidenceCell label="Comparison">{spec.evidence.comparisonBasis}</EvidenceCell>
        <EvidenceCell label="Evidence">{spec.evidence.source} · sample {spec.evidence.sampleSize ?? 'unavailable'} · {spec.evidence.coverage}</EvidenceCell>
      </div>

      {spec.trust.blockers.length > 0 && (
        <div className="border-t px-4 py-3 text-xs sm:px-5">
          {spec.trust.blockers.map((blocker) => (
            <div key={blocker.code}><span className="font-medium">{blocker.message}</span>{blocker.nextAction && <span className="text-muted-foreground"> · Next: {blocker.nextAction}</span>}</div>
          ))}
        </div>
      )}

      <div role="group" aria-label="Visualization actions" className="flex items-center justify-end border-t px-4 py-3 sm:px-5">
        <Button asChild variant="outline" size="sm" className="h-11"><Link to="/registry">Open definition</Link></Button>
      </div>
      <details className="group border-t bg-muted/20">
        <DisclosureSummary className="flex min-h-11 cursor-pointer items-center px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
          Table fallback &amp; reproducible query
        </DisclosureSummary>
        <div className="space-y-4 border-t bg-card px-4 py-4 sm:px-5">
          <div className="overflow-x-auto"><ResultTable result={result} /></div>
          {'query' in spec.source && (
            <div>
              <div className="mb-2 text-sm font-medium text-muted-foreground">Query DSL</div>
              <pre className="max-h-80 overflow-auto rounded-panel bg-muted p-3 text-xs">{JSON.stringify(spec.source.query, null, 2)}</pre>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}

function EvidenceCell({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 border-b px-4 py-3 last:border-b-0 sm:border-r sm:[&:nth-last-child(-n+2)]:border-b-0 lg:border-b-0 lg:last:border-r-0"><div className="mb-1 font-medium text-muted-foreground">{label}</div><div className="break-words">{children}</div></div>;
}

function TrustBadge({ status }: { status: VisualizationSpec['trust']['status'] }) {
  const variant = status === 'trusted' ? 'default' : status === 'blocked' ? 'destructive' : 'outline';
  return <Badge variant={variant}>{status}</Badge>;
}

function ResultTable({ result }: { result: AnalysisQueryResult }) {
  if (result.kind === 'trend') {
    return <DataTable headers={['Bucket (UTC)', 'Series', 'Value']} rows={result.series.map((point) => [point.bucket, point.breakdown_value ?? 'total', point.value])} />;
  }
  if (result.kind === 'funnel') {
    return <DataTable headers={['Step', 'Metric', 'Purpose', 'Actors', 'From start']} rows={result.steps.map((step) => [step.label, step.metric_key, step.purpose, step.actors, formatPercent(step.conversion_from_start)])} />;
  }
  if (result.kind === 'retention') {
    return <DataTable headers={['Cohort (UTC)', 'Size', 'Mature periods', 'Retained counts']} rows={result.cohorts.map((cohort) => [cohort.cohort, cohort.size, cohort.mature_periods, cohort.retained.join(' · ')])} />;
  }
  if (result.kind === 'lifecycle') {
    return <DataTable headers={['Bucket (UTC)', 'New', 'Returning', 'Resurrecting', 'Dormant']} rows={result.series.map((point) => [point.bucket, point.new, point.returning, point.resurrecting, point.dormant])} />;
  }
  return <DataTable headers={['Intervals active', 'Actors']} rows={result.bins.map((bin) => [bin.intervals_active, bin.actors])} />;
}

function DataTable({ headers, rows }: { headers: string[]; rows: Array<Array<string | number>> }) {
  return (
    <Table>
      <TableHeader><TableRow>{headers.map((header) => <TableHead key={header}>{header}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{rows.map((row, index) => <TableRow key={index}>{row.map((cell, cellIndex) => <TableCell key={cellIndex} className="whitespace-normal font-mono text-xs">{cell}</TableCell>)}</TableRow>)}</TableBody>
    </Table>
  );
}

function formatPercent(value: number | null) {
  return value === null ? 'unavailable' : `${Math.round(value * 100)}%`;
}

function formatUtcRange(from: string, to: string) {
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  return `${format.format(new Date(from))} – ${format.format(new Date(to))} UTC`;
}
