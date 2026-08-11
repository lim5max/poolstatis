import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading, fmtNum, fmtRelative } from '@/components/ui';
import { AnswerCanvas, type EvidenceTrust, type KpiItem } from '@/components/analytics';
import { DisclosureSummary } from '@/components/disclosure';
import { formatDurationMs, webPageMetric, type WebAnalyticsResult } from '../analysis/operations';
import type { AttentionItem, ControlTowerAction, ControlTowerResult, Funnel, MeasurementTrust, Metric, ObservedEvent, ProjectSchema } from '../api/types';
import type { FunnelQueryResult, TrendQueryResult } from '../analysis/visualization';
import type { ProjectMode } from '../analysis/navigation';
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
  overviewUnavailable: boolean;
  trust: MeasurementTrust | null;
  trustUnavailable: boolean;
}

export function Overview() {
  const { account, client, project, env } = useStore();
  const homeScope = `${project ?? ''}\u0000${env}`;
  const home = useAsync(async () => {
    try {
      const [controlTower, intent, metrics, funnels, schema] = await Promise.all([
        client!.controlTower(project!, env, '30d'),
        readProjectIntent(client as unknown as IntentCapableClient, project!),
        client!.metrics(project!, { status: 'active' }),
        client!.funnels(project!),
        client!.schema(project!, env).catch(() => null),
      ]);
      const primaryMetric = pickPrimaryMetric(metrics, intent?.primary_goal_id ?? null);
      const revenueMetric = metrics.find((metric) => metric.category === 'revenue') ?? null;
      const pageMetric = webPageMetric(metrics);
      const funnelAnchor = intent?.project_mode === 'website'
        || (intent?.project_mode === 'both' && prefersWebsite(intent.primary_goal_id))
        ? pageMetric
        : primaryMetric;
      const homeFunnel = controlTower.home_funnel_key === undefined
        ? pickHomeFunnel(funnels, intent?.primary_goal_id ?? null, funnelAnchor?.key ?? null)
        : funnels.find((funnel) => funnel.key === controlTower.home_funnel_key) ?? null;
      const productAnswersEnabled = intent?.project_mode !== 'website';
      const websiteAnswersEnabled = intent?.project_mode !== 'product';
      const [product, website] = await Promise.all([
        readProductAnswer(
          client!, project!, env,
          productAnswersEnabled ? primaryMetric : null,
          productAnswersEnabled ? revenueMetric : null,
          homeFunnel,
        ),
        readWebsiteAnswer(client!, project!, env, websiteAnswersEnabled ? pageMetric : null),
      ]);
      return {
        scope: homeScope,
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
      return { scope: homeScope, value: null, error: (caught as Error).message };
    }
  }, [project, env]);

  const scopedHome = home.data?.scope === homeScope ? home.data : null;
  const homeData = scopedHome?.value ?? null;
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

  if (home.loading) return <Loading what="reading current answers…" />;
  if (scopedHome?.error) return <ErrorNote>{scopedHome.error}</ErrorNote>;
  if (!homeData) return <Loading what="reading current answers…" />;

  const { intent, product, website, schema, controlTower } = homeData;
  const mode = intent?.project_mode ?? null;
  const attention = controlTower.attention;
  if (mode === 'website') return <WebsiteHome key={`${project}:${env}:website`} answer={website} product={product} schema={schema} env={env} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
  if (mode === 'product') return <ProductHome key={`${project}:${env}:product`} answer={product} schema={schema} env={env} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
  if (mode === 'both' && intent) {
    return <BothHome answer={prefersWebsite(intent.primary_goal_id) ? website : product} product={product} websiteFirst={prefersWebsite(intent.primary_goal_id)} schema={schema} env={env} controlTower={controlTower} attention={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />;
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
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={account?.user?.id} onRetry={home.reload} />
      <details className="rounded-panel border bg-card">
        <DisclosureSummary className="flex min-h-11 cursor-pointer items-center px-4 py-3 text-sm font-medium">
          Project settings
        </DisclosureSummary>
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          Project mode is not set. Choose Website, Product, or Both later in Setup. Nothing has been inferred from historical data.
        </p>
      </details>
      {website.overview
        ? <WebsiteAnswerCanvas answer={website} product={product} schema={schema} env={env} onRetry={home.reload} />
        : <ProductAnswerCanvas answer={product} schema={schema} env={env} />}
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
    <section aria-labelledby="attention-title">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 id="attention-title" className="text-sm font-semibold">Needs attention</h2>
          <p className="mt-1 text-sm text-muted-foreground">Highest-impact server-backed signal first.</p>
        </div>
        <span className="font-mono text-sm text-muted-foreground">{items.length}</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {visibleItems.map((item, index) => (
          <AttentionCard key={item.id} item={item} primary={index === 0} telemetryUserId={telemetryUserId} onRetry={onRetry} />
        ))}
      </div>
      {remainingItems.length > 0 && (
        <details className="mt-3 rounded-panel border bg-card">
          <DisclosureSummary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
            <span>View all {items.length} signals</span>
            <span className="font-mono text-muted-foreground">+{remainingItems.length}</span>
          </DisclosureSummary>
          <div className="grid gap-3 border-t p-3 lg:grid-cols-3">
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
    <article className={`rounded-panel border bg-card p-4 ${item.severity === 'critical' || item.severity === 'high' ? 'border-destructive/45' : item.severity === 'medium' ? 'border-warning/45' : ''}`}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{severityLabel(item.severity)}</span>
        <span className="text-muted-foreground">{item.evidence.freshness === 'fresh' ? fmtRelative(item.evidence.as_of) : item.evidence.freshness}</span>
      </div>
      <h3 className="mt-3 text-lg font-semibold">{item.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.reason}</p>
      <p className="mt-3 border-t pt-3 text-sm"><span className="font-medium">Impact:</span> <span className="text-muted-foreground">{item.impact}</span></p>
      <AttentionAction action={item.primary_action} primary={primary} telemetryUserId={telemetryUserId} onRetry={onRetry} />
    </article>
  );
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
  if (action.kind === 'navigate') {
    return (
      <Button asChild variant={primary ? 'default' : 'outline'} className="mt-4 h-11 w-full sm:w-auto">
        <Link to={action.href} onClick={() => trackHomeAction(actionTelemetry(action.href), telemetryUserId)}>
          {action.label} <ArrowRight className="size-4" />
        </Link>
      </Button>
    );
  }
  if (action.kind === 'retry') {
    return <Button variant={primary ? 'default' : 'outline'} className="mt-4 h-11 w-full sm:w-auto" onClick={onRetry}>{action.label}</Button>;
  }
  return <Button variant={primary ? 'default' : 'outline'} className="mt-4 h-11 w-full sm:w-auto" disabled>{action.label}</Button>;
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

function WebsiteHome({ answer, product, schema, env, controlTower, attention, telemetryUserId, onRetry }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; env: string; controlTower: ControlTowerResult; attention: AttentionItem[]; telemetryUserId?: string | null; onRetry: () => void }) {
  const lead = websiteLead(answer);
  return (
    <div className="space-y-5">
      <PageHeader title="Home" answer={lead} />
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
      <WebsiteAnswerCanvas answer={answer} product={product} schema={schema} env={env} onRetry={onRetry} />
    </div>
  );
}

function ProductHome({ answer, schema, env, controlTower, attention, telemetryUserId, onRetry }: { answer: ProductAnswer; schema: ProjectSchema | null; env: string; controlTower: ControlTowerResult; attention: AttentionItem[]; telemetryUserId?: string | null; onRetry: () => void }) {
  const lead = answer.metric
    ? `${answer.metric.name} is the clearest active outcome available for this project.`
    : 'Events may be arriving, but no active outcome is defined yet.';
  return (
    <div className="space-y-5">
      <PageHeader title="Home" answer={lead} />
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
      <ProductAnswerCanvas answer={answer} schema={schema} env={env} />
    </div>
  );
}

function BothHome({
  answer,
  product,
  websiteFirst,
  schema,
  env,
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
  controlTower: ControlTowerResult;
  telemetryUserId?: string | null;
  attention: AttentionItem[];
  onRetry: () => void;
}) {
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
      <AttentionQueue result={controlTower} items={attention} telemetryUserId={telemetryUserId} onRetry={onRetry} />
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-control border bg-card p-1" aria-label="Both mode surfaces">
        <span className="flex min-h-11 items-center rounded-control bg-secondary px-4 text-sm font-medium">All</span>
        <Link className="flex min-h-11 items-center rounded-control px-4 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" to="/analyze/web">Website</Link>
        <Link className="flex min-h-11 items-center rounded-control px-4 text-sm text-muted-foreground hover:bg-muted hover:text-foreground" to="/analyze/product">Product</Link>
      </div>
      <div className="rounded-panel border border-warning/35 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
        {identityState === 'unavailable'
          ? 'No combined KPI is shown while the identity check is unavailable.'
          : identityLinked
            ? 'No combined KPI is shown until a goal-bearing funnel proves the exact linked path.'
            : 'Add stable identity evidence before comparing acquisition with product outcomes.'}
      </div>
      {websiteFirst
        ? <WebsiteAnswerCanvas answer={answer as WebsiteAnswer} product={product} schema={schema} env={env} onRetry={onRetry} />
        : <ProductAnswerCanvas answer={answer as ProductAnswer} schema={schema} env={env} />}
    </div>
  );
}

const WEBSITE_KPIS = [
  { id: 'visitors', label: 'Visitors' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'page_views', label: 'Page views' },
  { id: 'last_event', label: 'Last event' },
  { id: 'average_duration', label: 'Average duration' },
  { id: 'engaged_rate', label: 'Engagement rate' },
  { id: 'bounce_rate', label: 'Bounce rate' },
] as const;

const PRODUCT_KPIS = [
  { id: 'outcome', label: 'Primary outcome' },
  { id: 'people', label: 'Observed people' },
  { id: 'activation', label: 'Activation' },
  { id: 'last_event', label: 'Last event' },
  { id: 'events', label: 'Event volume' },
] as const;
const REVENUE_KPI = { id: 'revenue', label: 'Revenue' } as const;

function productDashboardDefinitions(answer: ProductAnswer) {
  return answer.revenueMetric ? [...PRODUCT_KPIS, REVENUE_KPI] : PRODUCT_KPIS;
}

function WebsiteAnswerCanvas({ answer, product, schema, env, onRetry }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; env: string; onRetry: () => void }) {
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
        <HomeKpiStrip items={emptyItems.slice(0, 4)} />
        <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} />
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
      <HomeKpiStrip items={[
        { id: 'visitors', label: 'Visitors', value: fmtNum(overview.summary.visitors), note: 'resolved people' },
        { id: 'sessions', label: 'Sessions', value: fmtNum(overview.summary.sessions), note: 'canonical sessions' },
        { id: 'page_views', label: 'Page views', value: fmtNum(overview.summary.page_views), note: 'accepted views' },
        { id: 'last_event', label: 'Last event', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'average_duration', label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? null : formatDurationMs(overview.summary.average_session_duration_ms), note: 'complete sessions' },
        { id: 'engaged_rate', label: 'Engagement rate', value: answer.overview.engagement.engaged_rate == null ? null : `${Math.round(answer.overview.engagement.engaged_rate * 100)}%`, note: 'measured sessions' },
        { id: 'bounce_rate', label: 'Bounce rate', value: answer.overview.engagement.bounce_rate == null ? null : `${Math.round(answer.overview.engagement.bounce_rate * 100)}%`, note: 'measured sessions' },
      ].slice(0, 4)} />
      <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? overview.summary.page_views} env={env} />
      <HomeSummary
        funnel={product.funnel}
        funnelResult={product.funnelResult}
        activity={activity}
      />
    </>
  );
}

function ProductAnswerCanvas({ answer, schema, env }: { answer: ProductAnswer; schema: ProjectSchema | null; env: string }) {
  const activity = recentObservedEvents(schema);
  const lastEvent = activity?.[0] ?? null;
  const definitions = productDashboardDefinitions(answer);
  if (!answer.metric) {
    return (
      <>
        <HomeKpiStrip items={definitions.map((item) => ({
          ...item,
          value: item.id === 'last_event' && lastEvent ? fmtRelative(lastEvent.last_seen) : null,
          fallback: item.id === 'last_event' ? activityFallback(activity) : 'Not configured',
          note: item.id === 'last_event' ? lastEvent?.event ?? activityNote(activity) : 'Define a measurable outcome',
        })).slice(0, 4)} />
        <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} />
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
      <HomeKpiStrip items={[
        { id: 'outcome', label: answer.metric.name, value: metricValue, note: 'current 30-day outcome' },
        { id: 'people', label: 'Observed people', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_actors) : null, note: 'resolved actors' },
        { id: 'activation', label: 'Activation', value: finalStep?.conversion_from_start === null || finalStep?.conversion_from_start === undefined ? null : `${Math.round(finalStep.conversion_from_start * 100)}%`, note: answer.funnel?.name ?? 'saved funnel required' },
        { id: 'last_event', label: 'Last event', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'events', label: 'Event volume', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_events) : null, note: 'accepted observations' },
        ...(answer.revenueMetric ? [{ id: 'revenue', label: answer.revenueMetric.name, value: revenueValue, fallback: 'Unavailable', note: 'active revenue outcome' }] : []),
      ].slice(0, 4)} />
      <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? null} env={env} />
      <HomeSummary
        funnel={answer.funnel}
        funnelResult={answer.funnelResult}
        activity={activity}
      />
    </>
  );
}

function HomeKpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-panel border bg-card lg:grid-cols-4" aria-label="Key outcomes" role="group">
      {items.map((item, index) => (
        <div
          key={`${item.label}:${index}`}
          className={`min-w-0 p-4 ${index % 2 === 1 ? 'border-l' : ''} ${index < 2 ? 'border-b' : ''} ${index > 0 ? 'lg:border-l' : 'lg:border-l-0'} lg:border-b-0`}
        >
          <dt className="text-sm font-medium text-muted-foreground">{item.label}</dt>
          <dd className={`mt-1 min-w-0 truncate text-2xl font-semibold tabular-nums sm:text-3xl ${item.value === null ? 'text-muted-foreground' : ''}`}>
            {item.value ?? item.fallback ?? 'Unavailable'}
          </dd>
          {item.note && <div className="mt-1 min-w-0 truncate text-sm text-muted-foreground" title={item.note}>{item.note}</div>}
        </div>
      ))}
    </dl>
  );
}

function HomeEvidence({ trust, eventCount, env }: { trust: EvidenceTrust; eventCount: number | null; env: string }) {
  const trustLabel = trust === 'trusted' ? 'Trusted' : trust === 'partial' ? 'Partial' : 'Unavailable';
  return (
    <div className="mt-3 text-sm text-muted-foreground">
      Observed · Last 30 days · {trustLabel} · {eventCount === null ? 'event count unavailable' : `${eventCount.toLocaleString()} events`} · <code>{env}</code>
    </div>
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
          <h2 id="home-activity-title" className="text-sm font-semibold">Recent activity</h2>
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
  return (
    <header>
      <div className="max-w-3xl">
        <h1 className="serif text-3xl sm:text-4xl">{title}</h1>
        <p className="mt-2 text-base leading-relaxed text-muted-foreground">{answer}</p>
      </div>
    </header>
  );
}

function homeAnswerTelemetry(data: {
  intent: ProjectIntentSummary | null;
  product: ProductAnswer;
  website: WebsiteAnswer;
}): { templateId: TelemetryHomeTemplate; trust: EvidenceTrust } {
  const mode = data.intent?.project_mode;
  if (mode === 'website') {
    return { templateId: 'website_overview', trust: evidenceTrust(data.website.trust, data.website.trustUnavailable) };
  }
  if (mode === 'product') {
    return { templateId: 'product_overview', trust: evidenceTrust(data.product.trust, data.product.trustUnavailable) };
  }
  if (mode === 'both' && data.intent) {
    const websiteFirst = prefersWebsite(data.intent.primary_goal_id);
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
): Promise<WebsiteAnswer> {
  if (!metric) return { metric: null, overview: null, overviewUnavailable: false, trust: null, trustUnavailable: false };
  const base = { metric: metric.key, date_from: '-30d', filters: [], env };
  const [overviewResult, trustResult] = await Promise.all([
    client.operationalQuery<WebAnalyticsResult>(project, { kind: 'web_analytics', ...base, dimensions: ['source', 'route', 'campaign'] })
      .then((overview) => ({ overview, unavailable: false }))
      .catch(() => ({ overview: null, unavailable: true })),
    client.measurementTrust(project, { metric_key: metric.key, env, since_days: 30, target_filters: [] })
      .then((trust) => ({ trust, unavailable: false }))
      .catch(() => ({ trust: null, unavailable: true })),
  ]);
  return {
    metric,
    overview: overviewResult.overview,
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
): Promise<ProductAnswer> {
  const [trend, revenueTrend, trustResult, funnelResult] = await Promise.all([
    metric
      ? client.query(project, { kind: 'trend', metric: metric.key, date_from: '-30d', date_to: null, interval: 'day', filters: [], env })
        .then((result) => result.kind === 'trend' ? result : null).catch(() => null)
      : Promise.resolve(null),
    revenueMetric
      ? client.query(project, { kind: 'trend', metric: revenueMetric.key, date_from: '-30d', date_to: null, interval: 'day', filters: [], env })
        .then((result) => result.kind === 'trend' ? result : null).catch(() => null)
      : Promise.resolve(null),
    metric
      ? client.measurementTrust(project, { metric_key: metric.key, env, since_days: 30, target_filters: [] })
        .then((trust) => ({ trust, unavailable: false }))
        .catch(() => ({ trust: null, unavailable: true }))
      : Promise.resolve({ trust: null, unavailable: false }),
    funnel
      ? client.query(project, { kind: 'funnel', funnel: funnel.key, date_from: '-30d', date_to: null, env })
        .then((result) => result.kind === 'funnel' ? result : null).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { metric, trend, revenueMetric, revenueTrend, trust: trustResult.trust, trustUnavailable: trustResult.unavailable, funnel, funnelResult };
}

function pickPrimaryMetric(metrics: Metric[], primaryGoal: string | null): Metric | null {
  if (!primaryGoal) return metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
  const tokens = primaryGoal.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  return metrics.find((metric) => {
    const haystack = `${metric.key} ${metric.name} ${metric.purpose} ${metric.category ?? ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }) ?? metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
}

function pickHomeFunnel(funnels: Funnel[], primaryGoal: string | null, anchorMetricKey: string | null): Funnel | null {
  const ordered = [...funnels].sort((left, right) => left.key.localeCompare(right.key));
  if (primaryGoal) {
    const exactGoalFunnel = ordered.find((funnel) => funnel.key === primaryGoal);
    if (exactGoalFunnel) return exactGoalFunnel;
  }
  if (anchorMetricKey) {
    const anchoredFunnel = ordered.find((funnel) => funnel.steps.some((step) => step.metric_key === anchorMetricKey));
    if (anchoredFunnel) return anchoredFunnel;
  }
  return ordered[0] ?? null;
}

function prefersWebsite(primaryGoal: string) {
  return /(website|traffic|page|campaign|referral|content|conversion)/i.test(primaryGoal);
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
