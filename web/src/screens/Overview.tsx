import { Link } from 'react-router-dom';
import { ArrowRight } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNote, Loading, Panel } from '@/components/ui';
import { ANALYSIS_TEMPLATES, CORE_ANALYZE_CAPABILITIES, resolveTemplateCapability } from '../analysis/templates';
import type { MeasurementTrust, Metric } from '../api/types';
import { useAsync, useStore } from '../store';

interface TrustRow {
  metric: Metric;
  trust: MeasurementTrust | null;
  error: string | null;
}

export function Overview() {
  const { client, project, env, projects } = useStore();
  const commandCenter = useAsync(async () => {
    const [metrics, funnels, releases, inbox, quality] = await Promise.all([
      client!.metrics(project!, { status: 'active' }),
      client!.funnels(project!),
      client!.releases(project!, { env }),
      client!.decisionInbox(project!),
      client!.dataQuality(project!, { env, limit: 20, sinceDays: 30 }),
    ]);
    const trust: TrustRow[] = await Promise.all(metrics.slice(0, 8).map(async (metric) => {
      try {
        return {
          metric,
          trust: await client!.measurementTrust(project!, {
            metric_key: metric.key,
            env,
            since_days: 30,
            target_filters: [],
          }),
          error: null,
        };
      } catch (caught) {
        return {
          metric,
          trust: null,
          error: caught instanceof Error ? caught.message : 'Trust evidence unavailable.',
        };
      }
    }));
    const actorMetric = metrics.find((metric) => metric.type === 'unique_actors');
    const actorOutcome = actorMetric ? await client!.query(project!, {
      kind: 'trend',
      metric: actorMetric.key,
      date_from: monthStartUtc(),
      date_to: new Date().toISOString(),
      interval: 'month',
      filters: [],
      env,
    }).catch(() => null) : null;
    return { metrics, funnels, releases, inbox, quality, trust, actorMetric, actorOutcome };
  }, [project, env]);

  if (commandCenter.loading) return <Loading what="assembling command evidence…" />;
  if (commandCenter.error) return <ErrorNote>{commandCenter.error}</ErrorNote>;
  if (!commandCenter.data) return null;

  const data = commandCenter.data;
  const selectedProject = projects.find((candidate) => candidate.slug === project);
  const trusted = data.trust.filter((row) => row.trust?.status === 'trusted').length;
  const blocked = data.trust.filter((row) => row.trust?.status === 'untrusted').length;
  const unavailableTrust = data.trust.filter((row) => row.error).length;
  const observing = data.releases.filter((release) => release.status === 'deployed' || release.status === 'observing');
  const needsAttention = data.inbox.filter((item) => item.state === 'needs_attention');
  const actorValue = data.actorOutcome?.kind === 'trend'
    ? data.actorOutcome.series.reduce((sum, point) => sum + point.value, 0)
    : null;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <h1 className="serif text-3xl">Overview</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            What needs attention in <code>{project}</code> · <code>{env}</code>, based only on current registry, trust, release, and decision evidence.
          </p>
        </div>
        <Button asChild className="h-11"><Link to="/analyze/product">Open product analytics <ArrowRight className="size-4" /></Link></Button>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Command center evidence">
        <CommandBlock
          title={data.actorMetric?.name ?? 'Actor outcome'}
          value={actorValue === null ? 'Unavailable' : actorValue.toLocaleString()}
          context={data.actorMetric
            ? `${data.actorMetric.purpose} · month to date · unique actors · ${data.actorOutcome?.meta.source ?? 'source unavailable'}`
            : 'No active unique_actors metric is registered, so Overview will not invent an active-user number.'}
          tone={actorValue === null ? 'muted' : 'default'}
          action={<Button asChild variant="link" size="sm" className="h-11 px-0"><Link to={data.actorMetric ? '/analyze/product?template=product-health' : '/registry'}>{data.actorMetric ? 'Analyze metric' : 'Review registry'}</Link></Button>}
        />
        <CommandBlock
          title="Measurement trust"
          value={data.trust.length === 0 ? 'Unavailable' : `${trusted} trusted`}
          context={data.trust.length === 0
            ? 'No active metric can be assessed.'
            : `${blocked} blocked · ${unavailableTrust} unavailable · up to 8 active metrics · last 30 days`}
          tone={blocked > 0 || unavailableTrust > 0 ? 'warning' : 'default'}
          action={<Button asChild variant="link" size="sm" className="h-11 px-0"><Link to="/measurement">Inspect trust blockers</Link></Button>}
        />
        <CommandBlock
          title="Release evidence"
          value={`${observing.length} in window`}
          context={`${data.releases.length} registered releases · environment ${env} · server release state`}
          tone={observing.length > 0 ? 'warning' : 'muted'}
          action={<Button asChild variant="link" size="sm" className="h-11 px-0"><Link to="/changes">Review release evidence</Link></Button>}
        />
        <CommandBlock
          title="Decision attention"
          value={`${needsAttention.length} to review`}
          context={`${data.inbox.length} decision inbox records · human approval remains required`}
          tone={needsAttention.length > 0 ? 'warning' : 'default'}
          action={<Button asChild variant="link" size="sm" className="h-11 px-0"><Link to="/decisions">Review decisions</Link></Button>}
        />
      </section>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <Panel title="Attention queue" right={<span className="text-xs text-muted-foreground">real server state</span>}>
            <div className="divide-y">
              {needsAttention.map((item) => (
                <article key={item.decision_id} className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><Badge variant="destructive">decision</Badge><code className="text-xs">{item.impact.metric_key}</code></div>
                    <p className="mt-2 text-sm">{item.impact.metric_purpose}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{item.requested_choice ?? 'Review the evidence and record an explicit outcome.'}</p>
                  </div>
                  <Button asChild variant="outline" size="sm" className="h-11"><Link to="/decisions">Review</Link></Button>
                </article>
              ))}
              {data.trust.filter((row) => row.trust?.status === 'untrusted' || row.error).slice(0, 4).map((row) => {
                const blocker = row.trust?.blockers[0] ?? row.trust?.warnings[0];
                return (
                  <article key={row.metric.key} className="flex flex-wrap items-start justify-between gap-3 py-4 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">measurement</Badge><code className="text-xs">{row.metric.key}</code></div>
                      <p className="mt-2 text-sm">{blocker?.message ?? row.error ?? 'Trust evidence is unavailable.'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{blocker ? `Next: ${blocker.next_action}` : row.metric.purpose}</p>
                    </div>
                    <Button asChild variant="outline" size="sm" className="h-11"><Link to="/measurement">Inspect</Link></Button>
                  </article>
                );
              })}
              {needsAttention.length === 0 && blocked === 0 && unavailableTrust === 0 && (
                <EmptyState headline="No current blockers" lead="No decision or sampled measurement evidence needs attention in this environment." />
              )}
            </div>
          </Panel>
        </div>

        <Panel title="Registry and data readiness">
          <dl className="divide-y">
            <Fact label="Active metrics" value={data.metrics.length} note={`Registry source · project ${project}`} />
            <Fact label="Goal-bearing funnels" value={data.funnels.length} note="Saved funnel definitions only" />
            <Fact label="Data quality findings" value={data.quality.issues.length} note={`${data.quality.checked.evidence_rows} evidence rows checked · last 30 days`} />
            <Fact label="Events observed" value={selectedProject?.events_30d ?? 'Unavailable'} note="Project API · 30-day scope" />
          </dl>
        </Panel>
      </div>

      <Panel
        title="Curated questions"
        right={<Button asChild variant="outline" size="sm" className="h-11"><Link to="/analyze/product">Open analysis</Link></Button>}
      >
        <div className="flex flex-wrap gap-2">
          {ANALYSIS_TEMPLATES.map((template) => {
            const available = resolveTemplateCapability(template.key, CORE_ANALYZE_CAPABILITIES).status === 'available';
            return available ? (
              <Link
                key={template.key}
                to={`/analyze/product?template=${template.key}`}
                className="flex min-h-11 items-center rounded-control border bg-card px-3 text-sm font-medium transition-colors hover:border-ring/45 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {template.title}
              </Link>
            ) : (
              <span
                key={template.key}
                aria-disabled="true"
                title={`${template.title} is not available yet`}
                className="flex min-h-11 items-center gap-2 rounded-control border bg-muted/30 px-3 text-sm text-muted-foreground"
              >
                {template.title} <span className="text-xs">Later</span>
              </span>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function CommandBlock({ title, value, context, tone, action }: {
  title: string;
  value: string;
  context: string;
  tone: 'default' | 'warning' | 'muted';
  action: React.ReactNode;
}) {
  return (
    <article className={`flex min-h-52 flex-col rounded-dialog border p-4 sm:p-5 ${tone === 'warning' ? 'border-warning/45 bg-warning/5' : tone === 'muted' ? 'bg-muted/25' : 'bg-card'}`}>
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="serif mt-3 text-3xl tabular-nums">{value}</div>
      <p className="mt-3 flex-1 text-xs leading-relaxed text-muted-foreground">{context}</p>
      <div className="mt-3">{action}</div>
    </article>
  );
}

function Fact({ label, value, note }: { label: string; value: string | number; note: string }) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
        <div className="mt-1 text-xs text-muted-foreground">{note}</div>
      </div>
      <dd className="text-xl font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function monthStartUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
