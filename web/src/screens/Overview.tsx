import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, Loading, fmtNum } from '@/components/ui';
import { AnswerCanvas, EvidenceLine, KpiStrip, RankedRows, type EvidenceTrust } from '@/components/analytics';
import { TrendChart } from '../analysis/charts';
import { formatDurationMs, webPageMetric, type WebAnalyticsResult } from '../analysis/operations';
import type { Funnel, MeasurementTrust, Metric, ProjectSchema } from '../api/types';
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
  trust: MeasurementTrust | null;
  trustUnavailable: boolean;
  funnel: Funnel | null;
  funnelResult: FunnelQueryResult | null;
}

interface WebsiteAnswer {
  metric: Metric | null;
  overview: WebAnalyticsResult | null;
  trend: TrendQueryResult | null;
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
      const pageMetric = webPageMetric(metrics);
      const [product, website] = await Promise.all([
        readProductAnswer(client!, project!, env, primaryMetric, funnels[0] ?? null),
        readWebsiteAnswer(client!, project!, env, pageMetric),
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
  if (mode === 'website') return <WebsiteHome answer={website} env={env} telemetryUserId={account?.user?.id} />;
  if (mode === 'product') return <ProductHome answer={product} env={env} telemetryUserId={account?.user?.id} />;
  if (mode === 'both' && intent) {
    return <BothHome answer={prefersWebsite(intent.primary_goal_id) ? website : product} websiteFirst={prefersWebsite(intent.primary_goal_id)} schema={schema} env={env} telemetryUserId={account?.user?.id} />;
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
        ? <WebsiteAnswerCanvas answer={website} env={env} />
        : <ProductAnswerCanvas answer={product} env={env} />}
    </div>
  );
}

function WebsiteHome({ answer, env, telemetryUserId }: { answer: WebsiteAnswer; env: string; telemetryUserId?: string | null }) {
  const lead = websiteLead(answer);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Website performance"
        answer={lead}
        action={<Button asChild className="h-11"><Link to="/analyze/web" onClick={() => trackHomeAction('open_web', telemetryUserId)}>Open Web <ArrowRight className="size-4" /></Link></Button>}
      />
      <WebsiteAnswerCanvas answer={answer} env={env} />
    </div>
  );
}

function ProductHome({ answer, env, telemetryUserId }: { answer: ProductAnswer; env: string; telemetryUserId?: string | null }) {
  const lead = answer.metric
    ? `${answer.metric.name} is the clearest active outcome available for this project.`
    : 'Events may be arriving, but no active outcome is defined yet.';
  return (
    <div className="space-y-5">
      <PageHeader
        title="Product performance"
        answer={lead}
        action={<Button asChild className="h-11"><Link to={answer.metric ? '/analyze/product' : '/registry'} onClick={() => trackHomeAction(answer.metric ? 'explore_product' : 'review_outcomes', telemetryUserId)}>{answer.metric ? 'Explore Product' : 'Review outcomes'} <ArrowRight className="size-4" /></Link></Button>}
      />
      <ProductAnswerCanvas answer={answer} env={env} />
    </div>
  );
}

function BothHome({
  answer,
  websiteFirst,
  schema,
  env,
  telemetryUserId,
}: {
  answer: WebsiteAnswer | ProductAnswer;
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
        title="Website and product"
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
        ? <WebsiteAnswerCanvas answer={answer as WebsiteAnswer} env={env} />
        : <ProductAnswerCanvas answer={answer as ProductAnswer} env={env} />}
    </div>
  );
}

function WebsiteAnswerCanvas({ answer, env }: { answer: WebsiteAnswer; env: string }) {
  if (!answer.metric || !answer.overview) {
    return (
      <AnswerCanvas>
        <EmptyState
          headline="Website traffic is not configured"
          lead="Activate the canonical web page-view definition, then open one real page."
          action={<Button asChild><Link to="/measurement">Open Definitions</Link></Button>}
        />
      </AnswerCanvas>
    );
  }
  const { overview, trend } = answer;
  const sources = overview.breakdowns.source ?? [];
  const pages = overview.breakdowns.route ?? [];
  return (
    <>
      <KpiStrip items={[
        { label: 'Visitors', value: fmtNum(overview.summary.visitors), note: 'resolved people' },
        { label: 'Sessions', value: fmtNum(overview.summary.sessions), note: 'canonical sessions' },
        { label: 'Page views', value: fmtNum(overview.summary.page_views), note: 'accepted views' },
        { label: 'Average duration', value: overview.summary.average_session_duration_ms === null ? null : formatDurationMs(overview.summary.average_session_duration_ms), note: 'complete sessions' },
      ]} />
      <EvidenceLine
        className="mt-3"
        trust={evidenceTrust(answer.trust, answer.trustUnavailable)}
        eventCount={answer.trust?.primary_metric.observed_events ?? overview.summary.page_views}
        env={env}
      >
        Canonical page views are counted from the active <code>{answer.metric.key}</code> definition for the current 30-day window. Visitor and session rules come from the server response.
      </EvidenceLine>
      <AnswerCanvas className="mt-5">
        <div className="grid min-w-0 gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(17rem,1fr)]">
          <section className="min-w-0" aria-labelledby="website-trend-title">
            <h2 id="website-trend-title" className="text-sm font-semibold">Traffic trend</h2>
            <p className="mt-1 text-xs text-muted-foreground">Page views · last 30 days · {env}</p>
            <div className="mt-3">
              {trend && trend.series.length > 0
                ? <TrendChart result={trend} label="Page views" />
                : <EmptyState headline="No traffic in this period" lead="Open a real page after tracking is installed." />}
            </div>
          </section>
          <div className="grid content-start gap-5 border-t pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
            <RankedRows title="Top sources" rows={sources.slice(0, 5).map((row) => ({ key: row.value, label: row.value, value: fmtNum(row.visitors) }))} empty="No source values are available for this period." />
            <RankedRows title="Top pages" rows={pages.slice(0, 5).map((row) => ({ key: row.value, label: row.value, value: fmtNum(row.page_views) }))} empty="No page values are available for this period." />
          </div>
        </div>
      </AnswerCanvas>
    </>
  );
}

function ProductAnswerCanvas({ answer, env }: { answer: ProductAnswer; env: string }) {
  if (!answer.metric) {
    return (
      <AnswerCanvas>
        <EmptyState
          headline="No active product outcome"
          lead="Approve an outcome with a clear purpose before Poolstatis shows a product answer."
          action={<Button asChild><Link to="/registry">Review outcomes</Link></Button>}
        />
      </AnswerCanvas>
    );
  }
  const metricValue = metricAnswerValue(answer.metric, answer.trend, answer.trust);
  const finalStep = answer.funnelResult?.steps.at(-1) ?? null;
  return (
    <>
      <KpiStrip items={[
        { label: answer.metric.name, value: metricValue, note: 'current 30-day outcome' },
        { label: 'Observed people', value: answer.trust ? fmtNum(answer.trust.primary_metric.observed_actors) : null, note: 'resolved actors' },
        { label: 'Activation', value: finalStep?.conversion_from_start === null || finalStep?.conversion_from_start === undefined ? null : `${Math.round(finalStep.conversion_from_start * 100)}%`, note: answer.funnel?.name ?? 'saved funnel required' },
        { label: 'Retention', value: null, note: 'choose a return outcome' },
      ]} />
      <EvidenceLine
        className="mt-3"
        trust={evidenceTrust(answer.trust, answer.trustUnavailable)}
        eventCount={answer.trust?.primary_metric.observed_events ?? null}
        env={env}
      >
        <code>{answer.metric.key}</code> is an active registry metric. Its purpose is “{answer.metric.purpose}”. Trust and event count come from the server measurement check.
      </EvidenceLine>
      <AnswerCanvas className="mt-5">
        <div className="grid min-w-0 gap-5 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(17rem,1fr)]">
          <section className="min-w-0" aria-labelledby="product-trend-title">
            <h2 id="product-trend-title" className="text-sm font-semibold">{answer.metric.name} trend</h2>
            <p className="mt-1 text-xs text-muted-foreground">Last 30 days · {env}</p>
            <div className="mt-3">
              {answer.trend && answer.trend.series.length > 0
                ? <TrendChart result={answer.trend} label={answer.metric.name} />
                : <EmptyState headline="No observations in this period" lead="Perform the registered outcome or review its definition." />}
            </div>
          </section>
          <div className="border-t pt-5 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
            <RankedRows
              title={answer.funnel?.name ?? 'Activation funnel'}
              rows={(answer.funnelResult?.steps ?? []).map((step) => ({
                key: step.metric_key,
                label: step.label,
                value: fmtNum(step.actors),
                note: step.conversion_from_start === null ? 'Starting step' : `${Math.round(step.conversion_from_start * 100)}% from start`,
              }))}
              empty="No saved goal-bearing funnel is available."
            />
          </div>
        </div>
      </AnswerCanvas>
    </>
  );
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
  if (!metric) return { metric: null, overview: null, trend: null, trust: null, trustUnavailable: false };
  const base = { metric: metric.key, date_from: '-30d', filters: [], env };
  const [overview, trend, trustResult] = await Promise.all([
    client.operationalQuery<WebAnalyticsResult>(project, { kind: 'web_analytics', ...base, dimensions: ['source', 'route', 'campaign'] }).catch(() => null),
    client.query(project, { kind: 'trend', ...base, date_to: null, interval: 'day' }).then((result) => result.kind === 'trend' ? result : null).catch(() => null),
    client.measurementTrust(project, { metric_key: metric.key, env, since_days: 30, target_filters: [] })
      .then((trust) => ({ trust, unavailable: false }))
      .catch(() => ({ trust: null, unavailable: true })),
  ]);
  return { metric, overview, trend, trust: trustResult.trust, trustUnavailable: trustResult.unavailable };
}

async function readProductAnswer(
  client: NonNullable<ReturnType<typeof useStore>['client']>,
  project: string,
  env: string,
  metric: Metric | null,
  funnel: Funnel | null,
): Promise<ProductAnswer> {
  const [trend, trustResult, funnelResult] = await Promise.all([
    metric
      ? client.query(project, { kind: 'trend', metric: metric.key, date_from: '-30d', date_to: null, interval: 'day', filters: [], env })
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
  return { metric, trend, trust: trustResult.trust, trustUnavailable: trustResult.unavailable, funnel, funnelResult };
}

function pickPrimaryMetric(metrics: Metric[], primaryGoal: string | null): Metric | null {
  if (!primaryGoal) return metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
  const tokens = primaryGoal.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  return metrics.find((metric) => {
    const haystack = `${metric.key} ${metric.name} ${metric.purpose} ${metric.category ?? ''}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }) ?? metrics.find((metric) => metric.type === 'unique_actors') ?? metrics[0] ?? null;
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
  if (!answer.overview) return 'Traffic needs one canonical page-view definition before Poolstatis can answer.';
  const source = answer.overview.breakdowns.source?.[0];
  return `${fmtNum(answer.overview.summary.visitors)} people visited.${source ? ` ${source.value} brought the most measured traffic.` : ''}`;
}
