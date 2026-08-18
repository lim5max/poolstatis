import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ErrorNote, KpiRail, Loading, PageHeading, fmtNum, fmtRelative } from '@/components/ui';
import { AnswerCanvas, type EvidenceTrust, type KpiItem } from '@/components/analytics';
import { AnalyticsDateRange } from '@/components/AnalyticsDateRange';
import { DisclosureSummary } from '@/components/disclosure';
import { TrendChart } from '../analysis/charts';
import { formatDurationMs, webPageMetric, type WebAnalyticsResult } from '../analysis/operations';
import type { AnalyticsRangeSelection, ResolvedAnalyticsRange } from '../analysis/ranges';
import { useAnalyticsRange } from '../analysis/useAnalyticsRange';
import type { AttentionItem, ControlTowerAction, ControlTowerResult, Funnel, MeasurementTrust, Metric, ObservedEvent, ProjectSchema } from '../api/types';
import type { FunnelQueryResult, TrendQueryResult } from '../analysis/visualization';
import { analyticsNavigationTarget, type ProjectMode } from '../analysis/navigation';
import { useAsync, useStore } from '../store';
import {
  claimProductTelemetryOnce,
  captureProductTelemetry,
  type TelemetryHomeAction,
  type TelemetryHomeTemplate,
} from '../productTelemetry';

interface ProjectIntentSummary {
  project_mode: ProjectMode;
  goal_ids: string[];
  primary_goal_id: string;
}

interface IntentCapableClient {
  projectIntent?: (slug: string) => Promise<{ intent: ProjectIntentSummary | null }>;
}

interface ProductAnswer {
  metric: Metric | null;
  trend: TrendQueryResult | null;
  revenueMetric: Metric | null;
  revenueTrend: TrendQueryResult | null;
  trust: MeasurementTrust | null;
  trustUnavailable: boolean;
  funnel: Funnel | null;
  funnelResult: FunnelQueryResult | null;
}

interface WebsiteAnswer {
  metric: Metric | null;
  overview: WebAnalyticsResult | null;
  trend: TrendQueryResult | null;
  overviewUnavailable: boolean;
  trust: MeasurementTrust | null;
  trustUnavailable: boolean;
}

export function Overview() {
  const { account, client, project, env } = useStore();
  const { selection, resolved: range, setSelection } = useAnalyticsRange();
  const homeIdentity = `${project ?? ''}\u0000${env}`;
  const homeScope = `${project ?? ''}\u0000${env}\u0000${range.from}\u0000${range.to}`;
  const home = useAsync(async () => {
    try {
      const [controlTower, intent, metrics, funnels, schema] = await Promise.all([
        client!.controlTower(project!, env, '30d'),
        readProjectIntent(client as unknown as IntentCapableClient, project!),
        client!.metrics(project!, { status: 'active' }),
        client!.funnels(project!),
        client!.schema(project!, env).catch(() => null),
      ]);
      const primaryMetric = controlTower.home_metric_key
        ? metrics.find((metric) => metric.key === controlTower.home_metric_key) ?? null
        : null;
      const revenueMetric = metrics.find((metric) => metric.category === 'revenue') ?? null;
      const pageMetric = webPageMetric(metrics);
      const homeFunnel = controlTower.home_funnel_key
        ? funnels.find((funnel) => funnel.key === controlTower.home_funnel_key) ?? null
        : null;
      const productAnswersEnabled = intent?.project_mode !== 'website';
      const websiteAnswersEnabled = intent?.project_mode !== 'product';
      const [product, website] = await Promise.all([
        readProductAnswer(
          client!, project!, env,
          productAnswersEnabled ? primaryMetric : null,
          productAnswersEnabled ? revenueMetric : null,
          homeFunnel,
          range,
        ),
        readWebsiteAnswer(client!, project!, env, websiteAnswersEnabled ? pageMetric : null, range),
      ]);
      return {
        scope: homeScope,
        identity: homeIdentity,
        range,
        value: {
          intent,
          product,
          website,
          schema,
          controlTower,
        },
        error: null as string | null,
      };
    } catch (caught) {
      return { scope: homeScope, identity: homeIdentity, range, value: null, error: (caught as Error).message };
    }
  }, [project, env, range.from, range.to], { keepPreviousData: true });

  const exactHome = home.data?.scope === homeScope ? home.data : null;
  const renderedHome = exactHome ?? (
    home.loading && home.data?.identity === homeIdentity ? home.data : null
  );
  const homeData = renderedHome?.value ?? null;
  const renderedRange = renderedHome?.range ?? range;
  const refreshing = home.loading && !exactHome && Boolean(homeData);
  const answerTelemetry = homeData ? homeAnswerTelemetry(homeData) : null;
  useEffect(() => {
    if (!answerTelemetry || !project) return;
    const viewKey = `home:${project}:${env}:${answerTelemetry.templateId}:${answerTelemetry.trust}`;
    if (!claimProductTelemetryOnce(viewKey)) return;
    captureProductTelemetry('home.answer_viewed', {
      template_id: answerTelemetry.templateId,
      trust: answerTelemetry.trust,
    }, { distinctId: account?.user?.id });
  }, [account?.user?.id, answerTelemetry?.templateId, answerTelemetry?.trust, env, project]);

  if (home.loading && !homeData) return <Loading what="reading current answers…" />;
  if (exactHome?.error) return <ErrorNote>{exactHome.error}</ErrorNote>;
  if (!homeData) return <Loading what="reading current answers…" />;

  const { intent, product, website, schema, controlTower } = homeData;
  const mode = intent?.project_mode ?? null;
  const attention = controlTower.attention;
  if (mode === 'website') return <WebsiteHome key={`${project}:${env}:website`} answer={website} product={product} schema={schema} env={env} range={renderedRange} selection={selection} onSelectionChange={setSelection} refreshing={refreshing} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
  if (mode === 'product') return <ProductHome key={`${project}:${env}:product`} answer={product} schema={schema} env={env} range={renderedRange} selection={selection} onSelectionChange={setSelection} refreshing={refreshing} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
  if (mode === 'both' && intent) {
    const websiteFirst = controlTower.home_answer_surface === 'website';
    return <BothHome answer={websiteFirst ? website : product} product={product} websiteFirst={websiteFirst} schema={schema} env={env} range={renderedRange} selection={selection} onSelectionChange={setSelection} refreshing={refreshing} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
  }

  // A missing intent row is legacy/unset. Keep the project useful and never
  // redirect it into onboarding or silently assign a mode.
  return (
    <div className="space-y-5">
      <PageHeader
        title="Home"
        answer={website.overview
          ? websiteLead(website)
          : product.metric
            ? `${product.metric.name} is the clearest active outcome available for this project.`
            : controlTower.answer.takeaway}
      />
      {website.overview
        ? <WebsiteAnswerCanvas answer={website} product={product} schema={schema} env={env} range={renderedRange} selection={selection} onSelectionChange={setSelection} refreshing={refreshing} onRetry={home.reload} />
        : <ProductAnswerCanvas answer={product} schema={schema} env={env} range={renderedRange} selection={selection} onSelectionChange={setSelection} refreshing={refreshing} />}
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />
    </div>
  );
}

function AttentionQueue({ result, items, telemetryUserId, onRetry }: {
  result: ControlTowerResult;
  items: AttentionItem[];
  telemetryUserId?: string | null;
  onRetry: () => void;
}) {
  const visibleItems = items.length > 0 ? items.slice(0, 3) : [guardrailItem(result)];
  const remainingItems = items.slice(3);
  return (
    <section aria-labelledby="attention-title" className="overflow-hidden rounded-panel border bg-card">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <h2 id="attention-title" className="text-base font-semibold">Needs attention</h2>
        <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">{items.length}</span>
      </div>
      <div className="divide-y border-t">
        {visibleItems.map((item, index) => (
          <AttentionCard key={item.id} item={item} primary={index === 0} telemetryUserId={telemetryUserId} onRetry={onRetry} />
        ))}
      </div>
      {remainingItems.length > 0 && (
        <details className="border-t">
          <DisclosureSummary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
            <span>View all {items.length} signals</span>
            <span className="font-mono text-muted-foreground">+{remainingItems.length}</span>
          </DisclosureSummary>
          <div className="divide-y border-t">
            {remainingItems.map((item) => (
              <AttentionCard key={item.id} item={item} primary={false} telemetryUserId={telemetryUserId} onRetry={onRetry} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function AttentionCard({ item, primary, telemetryUserId, onRetry }: {
  item: AttentionItem;
  primary: boolean;
  telemetryUserId?: string | null;
  onRetry: () => void;
}) {
  return (
    <article className={`grid min-w-0 gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center ${item.severity === 'critical' || item.severity === 'high' ? 'border-l-4 border-l-destructive' : item.severity === 'medium' ? 'border-l-4 border-l-warning' : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{severityLabel(item.severity)}</span>
          <span aria-hidden="true">·</span>
          <span>{item.evidence.freshness === 'fresh' ? fmtRelative(item.evidence.as_of) : item.evidence.freshness}</span>
        </div>
        <h3 className="mt-2 text-lg font-semibold">{item.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.reason}</p>
        {item.delta && (
          <p className="mt-2 text-sm">
            <span className="font-medium">{item.rule_id === 'funnel.biggest_loss' ? 'Overall funnel conversion:' : 'Change:'}</span>{' '}
            <span className="text-muted-foreground">{attentionDeltaLabel(item.delta)}</span>
          </p>
        )}
      </div>
      <AttentionAction action={item.primary_action} primary={primary} telemetryUserId={telemetryUserId} onRetry={onRetry} />
    </article>
  );
}

function attentionDeltaLabel(delta: NonNullable<AttentionItem['delta']>): string {
  if (delta.value === null) return `Unavailable · ${delta.comparison_label}`;
  const rounded = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Math.abs(delta.value));
  const signed = delta.value > 0 ? `+${rounded}` : delta.value < 0 ? `-${rounded}` : rounded;
  const unit = delta.unit === 'percentage_point' ? 'pp' : delta.unit === 'percent' ? '%' : '';
  return `${signed}${unit ? ` ${unit}` : ''} · ${delta.comparison_label}`;
}

function guardrailItem(result: ControlTowerResult): AttentionItem {
  return {
    id: 'control-tower.evaluated',
    rule_id: 'control-tower.evaluated',
    rule_version: 1,
    severity: 'info',
    state: result.answer.state === 'unavailable' || result.answer.state === 'error' ? 'unavailable' : 'resolved',
    title: result.answer.headline,
    reason: result.answer.takeaway,
    impact: result.answer.why_it_matters,
    affected: [],
    evidence: result.evidence,
    primary_action: result.primary_action,
  };
}

function AttentionAction({ action, primary, telemetryUserId, onRetry }: {
  action: ControlTowerAction;
  primary: boolean;
  telemetryUserId?: string | null;
  onRetry: () => void;
}) {
  const location = useLocation();
  if (action.kind === 'navigate') {
    return (
      <Button asChild variant={primary ? 'default' : 'outline'} className="h-auto min-h-11 w-full whitespace-normal py-2 lg:w-auto">
        <Link to={analyticsNavigationTarget(action.href, location.search)} onClick={() => trackHomeAction(actionTelemetry(action.href), telemetryUserId)}>
          {action.label} <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }
  if (action.kind === 'retry') {
    return <Button variant={primary ? 'default' : 'outline'} className="h-auto min-h-11 w-full whitespace-normal py-2 lg:w-auto" onClick={onRetry}>{action.label}</Button>;
  }
  return <Button variant={primary ? 'default' : 'outline'} className="h-auto min-h-11 w-full whitespace-normal py-2 lg:w-auto" disabled>{action.label}</Button>;
}

function severityLabel(severity: AttentionItem['severity']) {
  if (severity === 'critical') return 'Critical';
  if (severity === 'high' || severity === 'medium') return 'Attention';
  if (severity === 'low') return 'Watch';
  return 'Evaluated';
}

function actionTelemetry(href: string): TelemetryHomeAction {
  if (href === '/analyze/web') return 'open_web';
  if (href === '/analyze/product' || href === '/analyze/funnels') return 'explore_product';
  if (href === '/registry') return 'review_outcomes';
  if (href === '/measurement') return 'open_definitions';
  return 'open_current_answer';
}

function WebsiteHome({ answer, product, schema, env, range, selection, onSelectionChange, refreshing, controlTower, attention, telemetryUserId, onRetry }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; env: string; range: ResolvedAnalyticsRange; selection: AnalyticsRangeSelection; onSelectionChange: (selection: AnalyticsRangeSelection) => void; refreshing: boolean; controlTower: ControlTowerResult; attention: AttentionItem[]; telemetryUserId?: string | null; onRetry: () => void }) {
  const lead = websiteLead(answer);
  return (
    <div className="space-y-5">
      <PageHeader title="Home" answer={lead} />
      <WebsiteAnswerCanvas answer={answer} product={product} schema={schema} env={env} range={range} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} onRetry={onRetry} />
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
    </div>
  );
}

function ProductHome({ answer, schema, env, range, selection, onSelectionChange, refreshing, controlTower, attention, telemetryUserId, onRetry }: { answer: ProductAnswer; schema: ProjectSchema | null; env: string; range: ResolvedAnalyticsRange; selection: AnalyticsRangeSelection; onSelectionChange: (selection: AnalyticsRangeSelection) => void; refreshing: boolean; controlTower: ControlTowerResult; attention: AttentionItem[]; telemetryUserId?: string | null; onRetry: () => void }) {
  const lead = answer.metric
    ? `${answer.metric.name} is the clearest active outcome available for this project.`
    : 'Events may be arriving, but no active outcome is defined yet.';
  return (
    <div className="space-y-5">
      <PageHeader title="Home" answer={lead} />
      <ProductAnswerCanvas answer={answer} schema={schema} env={env} range={range} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} />
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
    </div>
  );
}

function BothHome({
  answer,
  product,
  websiteFirst,
  schema,
  env,
  range,
  selection,
  onSelectionChange,
  refreshing,
  controlTower,
  telemetryUserId,
  attention,
  onRetry,
}: {
  answer: WebsiteAnswer | ProductAnswer;
  product: ProductAnswer;
  websiteFirst: boolean;
  schema: ProjectSchema | null;
  env: string;
  range: ResolvedAnalyticsRange;
  selection: AnalyticsRangeSelection;
  onSelectionChange: (selection: AnalyticsRangeSelection) => void;
  refreshing: boolean;
  controlTower: ControlTowerResult;
  telemetryUserId?: string | null;
  attention: AttentionItem[];
  onRetry: () => void;
}) {
  const location = useLocation();
  const identityState = schema === null
    ? 'unavailable'
    : schema.identity.active_links > 0
      ? 'linked'
      : 'unlinked';
  const identityLinked = identityState === 'linked';
  return (
    <div className="space-y-5">
      <PageHeader
        title="Home"
        answer={identityState === 'unavailable'
          ? 'Identity evidence is unavailable right now, so Poolstatis will not claim a cross-surface path.'
          : identityLinked
            ? 'Identity evidence exists. Poolstatis still requires a registered cross-surface funnel before claiming an acquisition-to-activation path.'
            : 'Website and product activity are not linked yet.'}
      />
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-control border bg-card p-1" aria-label="Both mode surfaces">
        <span className="flex min-h-11 items-center rounded-control bg-secondary px-4 text-sm font-medium">All</span>
        <Link className="flex min-h-11 items-center rounded-control px-4 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" to={analyticsNavigationTarget('/analyze/web', location.search)}>Website</Link>
        <Link className="flex min-h-11 items-center rounded-control px-4 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" to={analyticsNavigationTarget('/analyze/product', location.search)}>Product</Link>
      </div>
      <div className="rounded-panel border border-warning/35 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
        {identityState === 'unavailable'
          ? 'No combined KPI is shown while the identity check is unavailable.'
          : identityLinked
            ? 'No combined KPI is shown until a goal-bearing funnel proves the exact linked path.'
            : 'Add stable identity evidence before comparing acquisition with product outcomes.'}
      </div>
      {websiteFirst
        ? <WebsiteAnswerCanvas answer={answer as WebsiteAnswer} product={product} schema={schema} env={env} range={range} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} onRetry={onRetry} />
        : <ProductAnswerCanvas answer={answer as ProductAnswer} schema={schema} env={env} range={range} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} />}
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
    </div>
  );
}

const WEBSITE_KPIS = [
  { id: 'visitors', label: 'Visitors' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'page_views', label: 'Page views' },
  { id: 'last_event', label: 'Last event · 30d' },
  { id: 'average_duration', label: 'Average duration' },
  { id: 'engaged_rate', label: 'Engagement rate' },
  { id: 'bounce_rate', label: 'Bounce rate' },
] as const;

const PRODUCT_KPIS = [
  { id: 'outcome', label: 'Primary outcome' },
  { id: 'people', label: 'Observed people' },
  { id: 'activation', label: 'Activation' },
  { id: 'last_event', label: 'Last event · 30d' },
  { id: 'events', label: 'Event volume' },
] as const;
const REVENUE_KPI = { id: 'revenue', label: 'Revenue' } as const;

function productDashboardDefinitions(answer: ProductAnswer) {
  return answer.revenueMetric ? [...PRODUCT_KPIS, REVENUE_KPI] : PRODUCT_KPIS;
}

function WebsiteAnswerCanvas({ answer, product, schema, env, range, selection, onSelectionChange, refreshing, onRetry }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; env: string; range: ResolvedAnalyticsRange; selection: AnalyticsRangeSelection; onSelectionChange: (selection: AnalyticsRangeSelection) => void; refreshing: boolean; onRetry: () => void }) {
  const activity = recentObservedEvents(schema);
  const lastEvent = activity?.[0] ?? null;
  const answerUnavailable = Boolean(answer.metric && !answer.overview);
  const emptyItems: Array<KpiItem & { id: string }> = WEBSITE_KPIS.map((item) => ({
    ...item,
    value: item.id === 'last_event' && lastEvent ? fmtRelative(lastEvent.last_seen) : null,
    fallback: item.id === 'last_event' ? activityFallback(activity) : answerUnavailable ? 'Unavailable' : 'Not configured',
    note: item.id === 'last_event' ? lastEvent?.event ?? activityNote(activity) : answerUnavailable ? 'Website answer unavailable' : 'Connect website measurement',
  }));
  if (!answer.metric || !answer.overview) {
    return (
      <>
        <HomeKpiStrip title="Website overview" items={emptyItems.slice(0, 4)} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} />
        <HomeSummary
          funnel={product.funnel}
          funnelResult={product.funnelResult}
          activity={activity}
        />
        {answerUnavailable && <Button variant="outline" className="h-11" onClick={onRetry}>Retry website answers</Button>}
      </>
    );
  }
  const { overview } = answer;
  return (
    <>
      <HomeKpiStrip title="Website overview" selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? overview.summary.page_views} env={env} items={[
        { id: 'visitors', label: 'Visitors', value: fmtNum(overview.summary.visitors), note: 'resolved people' },
        { id: 'sessions', label: 'Sessions', value: fmtNum(overview.summary.sessions), note: 'canonical sessions' },
        { id: 'page_views', label: 'Page views', value: fmtNum(overview.summary.page_views), note: 'accepted views' },
        { id: 'last_event', label: 'Last event · 30d', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'average_duration', label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? null : formatDurationMs(overview.summary.average_session_duration_ms), note: 'complete sessions' },
        { id: 'engaged_rate', label: 'Engagement rate', value: answer.overview.engagement.engaged_rate == null ? null : `${Math.round(answer.overview.engagement.engaged_rate * 100)}%`, note: 'measured sessions' },
        { id: 'bounce_rate', label: 'Bounce rate', value: answer.overview.engagement.bounce_rate == null ? null : `${Math.round(answer.overview.engagement.bounce_rate * 100)}%`, note: 'measured sessions' },
      ].slice(0, 4)} />
      {answer.trend && (
        <HomeTrend result={answer.trend} title="Website traffic" label="Website traffic trend" range={range} />
      )}
      <HomeSummary
        funnel={product.funnel}
        funnelResult={product.funnelResult}
        activity={activity}
      />
    </>
  );
}

function ProductAnswerCanvas({ answer, schema, env, range, selection, onSelectionChange, refreshing }: { answer: ProductAnswer; schema: ProjectSchema | null; env: string; range: ResolvedAnalyticsRange; selection: AnalyticsRangeSelection; onSelectionChange: (selection: AnalyticsRangeSelection) => void; refreshing: boolean }) {
  const activity = recentObservedEvents(schema);
  const lastEvent = activity?.[0] ?? null;
  const definitions = productDashboardDefinitions(answer);
  if (!answer.metric) {
    return (
      <>
        <HomeKpiStrip title="Product overview" selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} items={definitions.map((item) => ({
          ...item,
          value: item.id === 'last_event' && lastEvent ? fmtRelative(lastEvent.last_seen) : null,
          fallback: item.id === 'last_event' ? activityFallback(activity) : 'Not configured',
          note: item.id === 'last_event' ? lastEvent?.event ?? activityNote(activity) : 'Define a measurable outcome',
        })).slice(0, 4)} />
        <HomeSummary
          funnel={answer.funnel}
          funnelResult={answer.funnelResult}
          activity={activity}
        />
      </>
    );
  }
  const metricValue = metricAnswerValue(answer.metric, answer.trend, answer.trust);
  const revenueValue = answer.revenueMetric
    ? metricAnswerValue(answer.revenueMetric, answer.revenueTrend, null)
    : null;
  const finalStep = answer.funnelResult?.steps.at(-1) ?? null;
  return (
    <>
      <HomeKpiStrip title={answer.metric.name} selection={selection} onSelectionChange={onSelectionChange} refreshing={refreshing} trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? null} env={env} items={[
        { id: 'outcome', label: answer.metric.name, value: metricValue, note: `${range.label} outcome` },
        { id: 'people', label: 'Observed people', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_actors) : null, note: 'resolved actors' },
        { id: 'activation', label: 'Activation', value: finalStep?.conversion_from_start === null || finalStep?.conversion_from_start === undefined ? null : `${Math.round(finalStep.conversion_from_start * 100)}%`, note: answer.funnel?.name ?? 'saved funnel required' },
        { id: 'last_event', label: 'Last event · 30d', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'events', label: 'Event volume', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_events) : null, note: 'accepted observations' },
        ...(answer.revenueMetric ? [{ id: 'revenue', label: answer.revenueMetric.name, value: revenueValue, fallback: 'Unavailable', note: 'active revenue outcome' }] : []),
      ].slice(0, 4)} />
      {answer.trend && (
        <HomeTrend result={answer.trend} title={answer.metric.name} label={`${answer.metric.name} trend`} range={range} />
      )}
      <HomeSummary
        funnel={answer.funnel}
        funnelResult={answer.funnelResult}
        activity={activity}
      />
    </>
  );
}

function HomeKpiStrip({ title, items, selection, onSelectionChange, refreshing, trust, eventCount, env }: {
  title: string;
  items: KpiItem[];
  selection: AnalyticsRangeSelection;
  onSelectionChange: (selection: AnalyticsRangeSelection) => void;
  refreshing: boolean;
  trust: EvidenceTrust;
  eventCount: number | null;
  env: string;
}) {
  const trustLabel = trust === 'trusted' ? 'Trusted' : trust === 'partial' ? 'Partial' : 'Unavailable';
  return <section className="overflow-hidden rounded-panel border bg-card" aria-busy={refreshing}>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className={`size-2 shrink-0 rounded-full ${trust === 'trusted' ? 'bg-success' : trust === 'partial' ? 'bg-warning' : 'bg-muted-foreground/60'}`} aria-hidden="true" />
          <span>{trustLabel} · {eventCount === null ? 'event count unavailable' : `${eventCount.toLocaleString()} events`} · <code>{env}</code></span>
          {refreshing && <span role="status">Updating…</span>}
        </div>
      </div>
      <AnalyticsDateRange value={selection} onChange={onSelectionChange} />
    </div>
    <KpiRail className="rounded-none border-0 shadow-none" items={items.map((item) => ({
      label: item.label,
      value: item.value ?? item.fallback ?? 'Unavailable',
      detail: item.note,
    }))} />
  </section>;
}

function HomeTrend({ result, title, label, range }: { result: TrendQueryResult; title: string; label: string; range: ResolvedAnalyticsRange }) {
  return (
    <AnswerCanvas className="mt-5">
      <div className="flex items-center justify-between gap-4 px-5 pt-5">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">{range.label}</span>
      </div>
      <div className="p-5 pt-3">
        <TrendChart result={result} label={label} />
      </div>
    </AnswerCanvas>
  );
}

function HomeSummary({ funnel, funnelResult, activity }: {
  funnel: Funnel | null;
  funnelResult: FunnelQueryResult | null;
  activity: ObservedEvent[] | null;
}) {
  return (
    <AnswerCanvas className="mt-5">
      <div className="grid min-w-0 lg:grid-cols-2">
        <section className="min-w-0 p-4 sm:p-5" aria-labelledby="home-funnel-title">
          <h2 id="home-funnel-title" className="text-sm font-semibold">Funnel snapshot</h2>
          {funnel ? (
            <>
              <div className="mt-3 text-lg font-semibold">{funnel.name}</div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{funnel.goal}</p>
              <ol className="mt-4 grid gap-3">
                {funnel.steps.map((step, index) => {
                  const result = funnelResult?.steps[index];
                  return (
                    <li key={`${step.metric_key}:${index}`} className="grid min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-2 text-sm">
                      <span className="font-mono text-muted-foreground">{index + 1}</span>
                      <span className="min-w-0 truncate" title={step.label}>{step.label}</span>
                      <span className="text-right font-mono tabular-nums text-muted-foreground">
                        {result ? funnelStepValue(result.actors, result.conversion_from_start) : 'Unavailable'}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <div className="mt-3">
              <div className="font-medium">No funnel saved</div>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Define the shortest path to a meaningful outcome.</p>
            </div>
          )}
        </section>

        <section className="min-w-0 border-t p-4 sm:p-5 lg:border-l lg:border-t-0" aria-labelledby="home-activity-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="home-activity-title" className="text-sm font-semibold">Recent activity</h2>
            <span className="text-sm text-muted-foreground">Last 30 days</span>
          </div>
          {activity === null ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Event activity is unavailable right now.</p>
          ) : activity.length === 0 ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">No events were observed in the last 30 days.</p>
          ) : (
            <ol className="mt-2 divide-y">
              {activity.slice(0, 4).map((event) => (
                <li key={event.event} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-3 text-sm">
                  <code className="min-w-0 truncate" title={event.event}>{event.event}</code>
                  <span className="font-mono tabular-nums">{fmtNum(event.count)} events</span>
                  <span className="col-span-2 mt-1 text-muted-foreground">Last seen {fmtRelative(event.last_seen)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </AnswerCanvas>
  );
}

function recentObservedEvents(schema: ProjectSchema | null): ObservedEvent[] | null {
  if (schema === null) return null;
  return [...(schema.observed_events_30d ?? [])]
    .sort((left, right) => timestampValue(right.last_seen) - timestampValue(left.last_seen));
}

function timestampValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activityFallback(activity: ObservedEvent[] | null) {
  return activity === null ? 'Unavailable' : 'No events';
}

function activityNote(activity: ObservedEvent[] | null) {
  return activity === null ? 'Event feed unavailable' : 'No events in 30 days';
}

function funnelStepValue(actors: number, conversionFromStart: number | null) {
  if (conversionFromStart === null) return `${fmtNum(actors)} people`;
  return `${Math.round(conversionFromStart * 1_000) / 10}% from start`;
}

function PageHeader({ title, answer }: { title: string; answer: string }) {
  return <PageHeading
    title={title}
    lead={answer}
  />;
}

function homeAnswerTelemetry(data: {
  intent: ProjectIntentSummary | null;
  product: ProductAnswer;
  website: WebsiteAnswer;
  controlTower: ControlTowerResult;
}): { templateId: TelemetryHomeTemplate; trust: EvidenceTrust } {
  const mode = data.intent?.project_mode;
  if (mode === 'website') {
    return { templateId: 'website_overview', trust: evidenceTrust(data.website.trust, data.website.trustUnavailable) };
  }
  if (mode === 'product') {
    return { templateId: 'product_overview', trust: evidenceTrust(data.product.trust, data.product.trustUnavailable) };
  }
  if (mode === 'both' && data.intent) {
    const websiteFirst = data.controlTower.home_answer_surface === 'website';
    return websiteFirst
      ? { templateId: 'both_website', trust: evidenceTrust(data.website.trust, data.website.trustUnavailable) }
      : { templateId: 'both_product', trust: evidenceTrust(data.product.trust, data.product.trustUnavailable) };
  }
  return data.website.overview
    ? { templateId: 'legacy_website', trust: evidenceTrust(data.website.trust, data.website.trustUnavailable) }
    : { templateId: 'legacy_product', trust: evidenceTrust(data.product.trust, data.product.trustUnavailable) };
}

function trackHomeAction(actionId: TelemetryHomeAction, distinctId: string | null | undefined) {
  captureProductTelemetry('home.next_action_clicked', { action_id: actionId }, { distinctId });
}

async function readProjectIntent(client: IntentCapableClient, project: string): Promise<ProjectIntentSummary | null> {
  if (!client.projectIntent) return null;
  try { return (await client.projectIntent(project)).intent; } catch { return null; }
}

async function readWebsiteAnswer(
  client: NonNullable<ReturnType<typeof useStore>['client']>,
  project: string,
  env: string,
  metric: Metric | null,
  range: ResolvedAnalyticsRange,
): Promise<WebsiteAnswer> {
  if (!metric) return { metric: null, overview: null, trend: null, overviewUnavailable: false, trust: null, trustUnavailable: false };
  const base = { metric: metric.key, date_from: range.from, date_to: range.to, filters: [], env };
  const [overviewResult, trend, trustResult] = await Promise.all([
    client.operationalQuery<WebAnalyticsResult>(project, { kind: 'web_analytics', ...base, dimensions: ['source', 'route', 'campaign'] })
      .then((overview) => ({ overview, unavailable: false }))
      .catch(() => ({ overview: null, unavailable: true })),
    client.query(project, { kind: 'trend', metric: metric.key, date_from: range.from, date_to: range.to, interval: 'day', filters: [], env })
      .then((result) => result.kind === 'trend' ? result : null).catch(() => null),
    client.measurementTrust(project, { metric_key: metric.key, env, since_days: Math.min(range.days, 365), target_filters: [] })
      .then((trust) => ({ trust, unavailable: false }))
      .catch(() => ({ trust: null, unavailable: true })),
  ]);
  return {
    metric,
    overview: overviewResult.overview,
    trend,
    overviewUnavailable: overviewResult.unavailable,
    trust: trustResult.trust,
    trustUnavailable: trustResult.unavailable,
  };
}

async function readProductAnswer(
  client: NonNullable<ReturnType<typeof useStore>['client']>,
  project: string,
  env: string,
  metric: Metric | null,
  revenueMetric: Metric | null,
  funnel: Funnel | null,
  range: ResolvedAnalyticsRange,
): Promise<ProductAnswer> {
  const [trend, revenueTrend, trustResult, funnelResult] = await Promise.all([
    metric
      ? client.query(project, { kind: 'trend', metric: metric.key, date_from: range.from, date_to: range.to, interval: 'day', filters: [], env })
        .then((result) => result.kind === 'trend' ? result : null).catch(() => null)
      : Promise.resolve(null),
    revenueMetric
      ? client.query(project, { kind: 'trend', metric: revenueMetric.key, date_from: range.from, date_to: range.to, interval: 'day', filters: [], env })
        .then((result) => result.kind === 'trend' ? result : null).catch(() => null)
      : Promise.resolve(null),
    metric
      ? client.measurementTrust(project, { metric_key: metric.key, env, since_days: Math.min(range.days, 365), target_filters: [] })
        .then((trust) => ({ trust, unavailable: false }))
        .catch(() => ({ trust: null, unavailable: true }))
      : Promise.resolve({ trust: null, unavailable: false }),
    funnel
      ? client.query(project, { kind: 'funnel', funnel: funnel.key, date_from: range.from, date_to: range.to, env })
        .then((result) => result.kind === 'funnel' ? result : null).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { metric, trend, revenueMetric, revenueTrend, trust: trustResult.trust, trustUnavailable: trustResult.unavailable, funnel, funnelResult };
}

function metricAnswerValue(metric: Metric, trend: TrendQueryResult | null, trust: MeasurementTrust | null) {
  if (metric.type === 'unique_actors') return trust ? fmtNum(trust.primary_metric.observed_actors) : null;
  if (!trend) return null;
  return fmtNum(trend.series.reduce((sum, point) => sum + point.value, 0));
}

function evidenceTrust(trust: MeasurementTrust | null, unavailable: boolean): EvidenceTrust {
  if (unavailable || !trust) return 'unavailable';
  return trust.status === 'trusted' ? 'trusted' : 'blocked';
}

function websiteLead(answer: WebsiteAnswer) {
  if (!answer.metric) return 'Traffic needs one canonical page-view definition before Poolstatis can answer.';
  if (answer.overviewUnavailable || !answer.overview) return 'Website answers are temporarily unavailable.';
  const source = answer.overview.breakdowns.source?.[0];
  return `${fmtNum(answer.overview.summary.visitors)} people visited.${source ? ` ${source.value} brought the most measured traffic.` : ''}`;
}
