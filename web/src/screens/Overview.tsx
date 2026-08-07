import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading, fmtNum, fmtRelative } from '@/components/ui';
import { AnswerCanvas, type EvidenceTrust, type KpiItem } from '@/components/analytics';
import { formatDurationMs, webPageMetric, type WebAnalyticsResult } from '../analysis/operations';
import type { Funnel, MeasurementTrust, Metric, ObservedEvent, ProjectSchema } from '../api/types';
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
      const [intent, metrics, funnels, schema] = await Promise.all([
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
      const homeFunnel = pickHomeFunnel(funnels, intent?.primary_goal_id ?? null, funnelAnchor?.key ?? null);
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
      return { scope: homeScope, value: { intent, product, website, schema }, error: null as string | null };
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

  const { intent, product, website, schema } = homeData;
  const mode = intent?.project_mode ?? null;
  if (mode === 'website') return <WebsiteHome key={`${project}:${env}:website`} answer={website} product={product} schema={schema} project={project!} env={env} telemetryUserId={account?.user?.id} />;
  if (mode === 'product') return <ProductHome key={`${project}:${env}:product`} answer={product} schema={schema} project={project!} env={env} telemetryUserId={account?.user?.id} />;
  if (mode === 'both' && intent) {
    return <BothHome answer={prefersWebsite(intent.primary_goal_id) ? website : product} product={product} websiteFirst={prefersWebsite(intent.primary_goal_id)} schema={schema} env={env} telemetryUserId={account?.user?.id} />;
  }

  // A missing intent row is legacy/unset. Keep the project useful and never
  // redirect it into onboarding or silently assign a mode.
  return (
    <div className="space-y-5">
      <PageHeader
        title="Home"
        answer="Project mode is not set. Your existing answers and data remain available."
        action={<Button asChild className="h-11"><Link to={website.overview ? '/analyze/web' : '/analyze/product'} onClick={() => trackHomeAction('open_current_answer', account?.user?.id)}>Open current answer <ArrowRight className="size-4" /></Link></Button>}
      />
      <div className="rounded-panel border border-dashed bg-card px-4 py-3 text-sm text-muted-foreground">
        Legacy project · choose Website, Product, or Both later in Setup. Nothing has been inferred from historical data.
      </div>
      {website.overview
        ? <WebsiteAnswerCanvas answer={website} product={product} schema={schema} env={env} />
        : <ProductAnswerCanvas answer={product} schema={schema} env={env} />}
    </div>
  );
}

function WebsiteHome({ answer, product, schema, project, env, telemetryUserId }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; project: string; env: string; telemetryUserId?: string | null }) {
  const lead = websiteLead(answer);
  const dashboard = useDashboardLayout(`${project}:${env}:website`, WEBSITE_KPIS);
  const ready = Boolean(answer.metric);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Home"
        answer={lead}
        action={<div className="flex flex-wrap gap-2"><Button variant="outline" className="h-11" onClick={dashboard.toggle}>Customize dashboard</Button><Button asChild className="h-11"><Link to={ready ? '/analyze/web' : '/measurement'} onClick={() => trackHomeAction(ready ? 'open_web' : 'open_definitions', telemetryUserId)}>{ready ? 'Open Web' : 'Set up Web'} <ArrowRight className="size-4" /></Link></Button></div>}
      />
      {dashboard.open && <DashboardSettings ids={WEBSITE_KPIS} order={dashboard.order} onChange={dashboard.change} onReset={dashboard.reset} />}
      <WebsiteAnswerCanvas answer={answer} product={product} schema={schema} env={env} order={dashboard.order} />
    </div>
  );
}

function ProductHome({ answer, schema, project, env, telemetryUserId }: { answer: ProductAnswer; schema: ProjectSchema | null; project: string; env: string; telemetryUserId?: string | null }) {
  const lead = answer.metric
    ? `${answer.metric.name} is the clearest active outcome available for this project.`
    : 'Events may be arriving, but no active outcome is defined yet.';
  const definitions = productDashboardDefinitions(answer);
  const dashboard = useDashboardLayout(`${project}:${env}:product`, definitions);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Home"
        answer={lead}
        action={<div className="flex flex-wrap gap-2"><Button variant="outline" className="h-11" onClick={dashboard.toggle}>Customize dashboard</Button><Button asChild className="h-11"><Link to={answer.metric ? '/analyze/product' : '/registry'} onClick={() => trackHomeAction(answer.metric ? 'explore_product' : 'review_outcomes', telemetryUserId)}>{answer.metric ? 'Explore Product' : 'Review outcomes'} <ArrowRight className="size-4" /></Link></Button></div>}
      />
      {dashboard.open && <DashboardSettings ids={definitions} order={dashboard.order} onChange={dashboard.change} onReset={dashboard.reset} />}
      <ProductAnswerCanvas answer={answer} schema={schema} env={env} order={dashboard.order} />
    </div>
  );
}

function BothHome({
  answer,
  product,
  websiteFirst,
  schema,
  env,
  telemetryUserId,
}: {
  answer: WebsiteAnswer | ProductAnswer;
  product: ProductAnswer;
  websiteFirst: boolean;
  schema: ProjectSchema | null;
  env: string;
  telemetryUserId?: string | null;
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
        action={<Button asChild className="h-11"><Link to={identityLinked ? (websiteFirst ? '/analyze/web' : '/analyze/product') : '/measurement'} onClick={() => trackHomeAction(identityLinked ? 'open_primary_answer' : 'review_identity', telemetryUserId)}>{identityLinked ? 'Open primary answer' : 'Review identity'} <ArrowRight className="size-4" /></Link></Button>}
      />
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
        ? <WebsiteAnswerCanvas answer={answer as WebsiteAnswer} product={product} schema={schema} env={env} />
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

type DashboardDefinition = ReadonlyArray<{ id: string; label: string }>;

function productDashboardDefinitions(answer: ProductAnswer): DashboardDefinition {
  return answer.revenueMetric ? [...PRODUCT_KPIS, REVENUE_KPI] : PRODUCT_KPIS;
}

function WebsiteAnswerCanvas({ answer, product, schema, env, order = WEBSITE_KPIS.slice(0, 4).map((item) => item.id) }: { answer: WebsiteAnswer; product: ProductAnswer; schema: ProjectSchema | null; env: string; order?: string[] }) {
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
    const nextAction = answerUnavailable
      ? { title: 'Check recent activity', body: 'Open Events while the website answer retries.', href: '/data', label: 'Open events' }
      : { title: 'Connect website measurement', body: 'Activate the canonical page-view definition, then open one real page.', href: '/measurement', label: 'Set up Web' };
    return (
      <>
        <HomeKpiStrip items={orderDashboardItems(emptyItems, order)} />
        <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} />
        <HomeSummary
          funnel={product.funnel}
          funnelResult={product.funnelResult}
          activity={activity}
          nextAction={nextAction}
        />
      </>
    );
  }
  const { overview } = answer;
  return (
    <>
      <HomeKpiStrip items={orderDashboardItems([
        { id: 'visitors', label: 'Visitors', value: fmtNum(overview.summary.visitors), note: 'resolved people' },
        { id: 'sessions', label: 'Sessions', value: fmtNum(overview.summary.sessions), note: 'canonical sessions' },
        { id: 'page_views', label: 'Page views', value: fmtNum(overview.summary.page_views), note: 'accepted views' },
        { id: 'last_event', label: 'Last event', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'average_duration', label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? null : formatDurationMs(overview.summary.average_session_duration_ms), note: 'complete sessions' },
        { id: 'engaged_rate', label: 'Engagement rate', value: answer.overview.engagement.engaged_rate == null ? null : `${Math.round(answer.overview.engagement.engaged_rate * 100)}%`, note: 'measured sessions' },
        { id: 'bounce_rate', label: 'Bounce rate', value: answer.overview.engagement.bounce_rate == null ? null : `${Math.round(answer.overview.engagement.bounce_rate * 100)}%`, note: 'measured sessions' },
      ], order)} />
      <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? overview.summary.page_views} env={env} />
      <HomeSummary
        funnel={product.funnel}
        funnelResult={product.funnelResult}
        activity={activity}
        nextAction={nextHomeAction({ measurementReady: true, funnel: product.funnel, activity })}
      />
    </>
  );
}

function ProductAnswerCanvas({ answer, schema, env, order = productDashboardDefinitions(answer).slice(0, 4).map((item) => item.id) }: { answer: ProductAnswer; schema: ProjectSchema | null; env: string; order?: string[] }) {
  const activity = recentObservedEvents(schema);
  const lastEvent = activity?.[0] ?? null;
  const definitions = productDashboardDefinitions(answer);
  if (!answer.metric) {
    return (
      <>
        <HomeKpiStrip items={orderDashboardItems(definitions.map((item) => ({
          ...item,
          value: item.id === 'last_event' && lastEvent ? fmtRelative(lastEvent.last_seen) : null,
          fallback: item.id === 'last_event' ? activityFallback(activity) : 'Not configured',
          note: item.id === 'last_event' ? lastEvent?.event ?? activityNote(activity) : 'Define a measurable outcome',
        })), order)} />
        <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={null} env={env} />
        <HomeSummary
          funnel={answer.funnel}
          funnelResult={answer.funnelResult}
          activity={activity}
          nextAction={{ title: 'Define a product outcome', body: 'Activate one metric that represents meaningful product value.', href: '/registry', label: 'Review outcomes' }}
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
      <HomeKpiStrip items={orderDashboardItems([
        { id: 'outcome', label: answer.metric.name, value: metricValue, note: 'current 30-day outcome' },
        { id: 'people', label: 'Observed people', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_actors) : null, note: 'resolved actors' },
        { id: 'activation', label: 'Activation', value: finalStep?.conversion_from_start === null || finalStep?.conversion_from_start === undefined ? null : `${Math.round(finalStep.conversion_from_start * 100)}%`, note: answer.funnel?.name ?? 'saved funnel required' },
        { id: 'last_event', label: 'Last event', value: lastEvent ? fmtRelative(lastEvent.last_seen) : null, fallback: activityFallback(activity), note: lastEvent?.event ?? activityNote(activity) },
        { id: 'events', label: 'Event volume', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_events) : null, note: 'accepted observations' },
        ...(answer.revenueMetric ? [{ id: 'revenue', label: answer.revenueMetric.name, value: revenueValue, fallback: 'Unavailable', note: 'active revenue outcome' }] : []),
      ], order)} />
      <HomeEvidence trust={evidenceTrust(answer.trust, answer.trustUnavailable)} eventCount={answer.trust?.primary_metric.observed_events ?? null} env={env} />
      <HomeSummary
        funnel={answer.funnel}
        funnelResult={answer.funnelResult}
        activity={activity}
        nextAction={nextHomeAction({ measurementReady: true, funnel: answer.funnel, activity })}
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

interface HomeNextAction {
  title: string;
  body: string;
  href: string;
  label: string;
}

function HomeSummary({ funnel, funnelResult, activity, nextAction }: {
  funnel: Funnel | null;
  funnelResult: FunnelQueryResult | null;
  activity: ObservedEvent[] | null;
  nextAction: HomeNextAction;
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

      <div className="flex flex-col gap-3 border-t px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Next action</div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground"><span className="font-medium text-foreground">{nextAction.title}.</span> {nextAction.body}</p>
        </div>
        <Button asChild variant="outline" className="h-11 self-start sm:self-auto">
          <Link to={nextAction.href}>{nextAction.label} <ArrowRight className="size-4" /></Link>
        </Button>
      </div>
    </AnswerCanvas>
  );
}

function nextHomeAction(input: {
  measurementReady: boolean;
  funnel: Funnel | null;
  activity: ObservedEvent[] | null;
}): HomeNextAction {
  if (!input.measurementReady) {
    return { title: 'Connect measurement', body: 'Register one meaningful outcome before reading results.', href: '/setup', label: 'Open Setup' };
  }
  if (input.activity === null) {
    return { title: 'Check project data', body: 'Open Setup to verify the current environment and connection.', href: '/setup', label: 'Open Setup' };
  }
  if (input.activity.length === 0) {
    return { title: 'Send one real event', body: 'Run the product once and confirm that Poolstatis receives it.', href: '/setup', label: 'Open Setup' };
  }
  if (!input.funnel) {
    return { title: 'Define the first funnel', body: 'Connect recent activity to one measurable goal.', href: '/setup', label: 'Create with agent' };
  }
  return { title: 'Review the biggest drop-off', body: 'Open the saved funnel for the full step-by-step breakdown.', href: '/analyze/funnels', label: 'Review funnel' };
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

function useDashboardLayout(scope: string, definitions: DashboardDefinition) {
  const defaults = definitions.slice(0, 4).map((item) => item.id);
  const available = definitions.map((item) => item.id);
  const storageKey = `poolstatis.home.cards.${scope}`;
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<string[]>(() => readDashboardOrder(storageKey, defaults, available));
  const persist = (next: string[]) => {
    setOrder(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage can be blocked */ }
  };
  return {
    open,
    order,
    toggle: () => setOpen((value) => !value),
    change: (slot: number, id: string) => {
      const next = [...order];
      const previousSlot = next.indexOf(id);
      if (previousSlot === slot) return;
      if (previousSlot === -1) next[slot] = id;
      else [next[slot], next[previousSlot]] = [next[previousSlot]!, next[slot]!];
      persist(next);
    },
    reset: () => persist(defaults),
  };
}

function readDashboardOrder(storageKey: string, defaults: string[], available: string[]) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.length === 4 && new Set(saved).size === 4 && saved.every((id) => typeof id === 'string' && available.includes(id))) {
      return saved as string[];
    }
  } catch { /* use the useful default dashboard */ }
  return defaults;
}

function DashboardSettings({ ids, order, onChange, onReset }: {
  ids: DashboardDefinition;
  order: string[];
  onChange(slot: number, id: string): void;
  onReset(): void;
}) {
  return (
    <section role="region" aria-label="Dashboard settings" className="rounded-panel border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Dashboard settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose the order of the four answers shown first.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {order.map((id, slot) => (
          <label key={`${slot}:${id}`} className="grid gap-1.5 text-sm font-medium">
            Card {slot + 1}
            <select
              aria-label={`Card ${slot + 1}`}
              className="h-11 rounded-field border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={id}
              onChange={(event) => onChange(slot, event.target.value)}
            >
              {ids.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        ))}
      </div>
    </section>
  );
}

function orderDashboardItems<T extends KpiItem & { id: string }>(items: T[], order: string[]): KpiItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
}

function PageHeader({ title, answer, action }: { title: string; answer: string; action: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-3xl">
        <h1 className="serif text-3xl sm:text-4xl">{title}</h1>
        <p className="mt-2 text-base leading-relaxed text-muted-foreground">{answer}</p>
      </div>
      <div className="shrink-0">{action}</div>
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
  return trust.status === 'trusted' ? 'trusted' : 'partial';
}

function websiteLead(answer: WebsiteAnswer) {
  if (!answer.metric) return 'Traffic needs one canonical page-view definition before Poolstatis can answer.';
  if (answer.overviewUnavailable || !answer.overview) return 'Website answers are temporarily unavailable.';
  const source = answer.overview.breakdowns.source?.[0];
  return `${fmtNum(answer.overview.summary.visitors)} people visited.${source ? ` ${source.value} brought the most measured traffic.` : ''}`;
}
