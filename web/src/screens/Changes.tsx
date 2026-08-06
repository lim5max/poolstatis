import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  SHIP_STAGES,
  SHIP_STAGE_LABELS,
  ShipLifecycleRail,
  ShipSectionNav,
  ShipStageBadge,
  deriveExperimentStage,
  deriveReleaseStage,
  experimentOutcome,
  releaseOutcome,
  type ShipStage,
} from '../components/ship-lifecycle';
import type { Decision, DecisionDetail, Experiment, Release } from '../api/types';

type LifecycleItem =
  | { kind: 'release'; id: string; stage: ShipStage; updatedAt: string; release: Release; detail?: DecisionDetail }
  | { kind: 'experiment'; id: string; stage: ShipStage; updatedAt: string; experiment: Experiment };

export function Changes() {
  const { client, project, env } = useStore();
  const audit = useAsync(async () => {
    const [releases, listedDecisions, experiments] = await Promise.all([
      client!.releases(project!, { env }),
      client!.decisions(project!),
      client!.experiments(project!),
    ]);
    const latestByRelease = new Map<string, Decision>();
    for (const decision of listedDecisions) {
      const current = latestByRelease.get(decision.release_id);
      if (!current || new Date(decision.updated_at).getTime() > new Date(current.updated_at).getTime()) {
        latestByRelease.set(decision.release_id, decision);
      }
    }
    const details = await Promise.all([...latestByRelease.values()].map((decision) => client!.decision(project!, decision.id)));
    return {
      releases,
      experiments: experiments.filter((experiment) => experiment.env === env || experiment.env === null),
      decisions: new Map(details.map((detail) => [detail.decision.release_id, detail])),
    };
  }, [project, env]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const evaluate = async (release: Release) => {
    setBusy(release.id);
    setActionError(null);
    try {
      await client!.evaluateRelease(project!, release.id);
      audit.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'could not evaluate release');
    } finally {
      setBusy(null);
    }
  };

  if (audit.loading) return <Loading what="reading ship lifecycle…" />;
  if (audit.error) return <RecoverableError onRetry={audit.reload}>{audit.error}</RecoverableError>;
  if (!audit.data) return null;
  const { releases, experiments, decisions } = audit.data;
  const items: LifecycleItem[] = [
    ...releases.map((release): LifecycleItem => {
      const detail = decisions.get(release.id);
      return { kind: 'release', id: release.id, stage: deriveReleaseStage(release, detail?.decision), updatedAt: release.updated_at, release, detail };
    }),
    ...experiments.map((experiment): LifecycleItem => ({
      kind: 'experiment', id: experiment.id, stage: deriveExperimentStage(experiment), updatedAt: experiment.updated_at, experiment,
    })),
  ].sort((a, b) => SHIP_STAGES.indexOf(a.stage) - SHIP_STAGES.indexOf(b.stage)
    || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const counts = Object.fromEntries(SHIP_STAGES.map((stage) => [stage, items.filter((item) => item.stage === stage).length])) as Record<ShipStage, number>;

  return (
    <div className="space-y-4 [&_button]:min-h-11 sm:[&_button]:min-h-9">
      <ShipSectionNav current="lifecycle" />
      <header className="max-w-3xl">
        <h1 className="serif text-3xl text-balance">Ship</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Follow every release and experiment from preparation to a human-reviewed outcome.
        </p>
      </header>
      <Panel>
        <div className="-m-5">
          <ShipLifecycleRail counts={counts} />
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5">
            <span className="text-sm">Environment <code>{env}</code></span>
            <Badge variant="outline">{items.length} {items.length === 1 ? 'item' : 'items'}</Badge>
            <Button className="ml-auto" variant="outline" size="sm" onClick={audit.reload}>Refresh</Button>
          </div>
          {actionError && <div className="p-4 sm:p-5"><ErrorNote>{actionError}</ErrorNote></div>}
          {items.length === 0 ? (
            <EmptyState headline="Nothing is being shipped yet" lead="Register a release or prepare an experiment to start the lifecycle." />
          ) : SHIP_STAGES.map((stage) => {
            const stageItems = items.filter((item) => item.stage === stage);
            if (stageItems.length === 0) return null;
            const headingId = `ship-stage-${stage}`;
            return (
              <section key={stage} aria-labelledby={headingId}>
                <div className="flex items-center justify-between gap-3 border-b bg-muted/20 px-4 py-2.5 sm:px-5">
                  <h2 id={headingId} className="text-sm font-medium">{SHIP_STAGE_LABELS[stage]}</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">{stageItems.length}</span>
                </div>
                <div className="divide-y">
                  {stageItems.map((item) => item.kind === 'release'
                    ? <ReleaseLifecycleRow key={`release:${item.id}`} release={item.release} detail={item.detail} busy={busy === item.id} onEvaluate={() => evaluate(item.release)} />
                    : <ExperimentLifecycleRow key={`experiment:${item.id}`} experiment={item.experiment} />)}
                </div>
              </section>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function ReleaseLifecycleRow({ release, detail, busy, onEvaluate }: {
  release: Release;
  detail?: DecisionDetail;
  busy: boolean;
  onEvaluate: () => void;
}) {
  const stage = deriveReleaseStage(release, detail?.decision);
  const outcome = releaseOutcome(release, detail);
  const evidence = detail?.evidence;
  const canEvaluate = release.status === 'deployed' || release.status === 'observing';
  return (
    <article aria-label={release.contract_snapshot.name} className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <ShipStageBadge stage={stage} />
          <Badge variant="outline">Release</Badge>
        </div>
        <h3 className="mt-2 font-medium">{release.contract_snapshot.name}</h3>
        <p className="mt-1 break-words text-sm text-muted-foreground">{release.contract_snapshot.business_hypothesis}</p>
      </div>
      <div className="min-w-0">
        <div className={outcome.available ? 'text-sm font-medium' : 'text-sm font-medium text-muted-foreground'}>{outcome.title}</div>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{outcome.detail}</p>
        {evidence && (
          <div className="mt-2 text-xs">
            <MetricChange detail={detail} />
            <p className="mt-1 text-muted-foreground">
              Observed · {evidence.trust.status === 'trusted' ? 'Trusted' : 'Partial'} · {evidence.sample_size} actors · {release.env}
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-2 lg:justify-end">
        {canEvaluate && <Button size="sm" onClick={onEvaluate} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Evaluate</Button>}
        {detail?.decision.status === 'proposed' && <Button asChild size="sm"><Link to="/decisions">Review decision</Link></Button>}
        {release.experiment_key && <Button asChild size="sm" variant="outline"><Link to="/experiments">Open experiment</Link></Button>}
      </div>
      <details className="min-w-0 lg:col-span-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8">
          Technical details
        </summary>
        <div className="grid min-w-0 gap-x-5 gap-y-1 border-l pl-3 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
          <span>Release <code className="break-all">{release.id}</code></span>
          <span>Raw status <code>{release.status}</code></span>
          <span>Commit <code>{shortSha(release.commit_sha)}</code> · {release.repository}</span>
          <span>Contract revision {release.contract_revision}</span>
          <span>Branch {release.branch ?? 'not recorded'}</span>
          <span>{release.evaluation_attempts} evaluator attempts{release.next_evaluation_at ? ` · next ${formatDate(release.next_evaluation_at)}` : ''}</span>
          {release.flag_key && <span>Flag <code>{release.flag_key}</code></span>}
          {release.experiment_key && <span>Experiment <code>{release.experiment_key}</code></span>}
          {release.originating_decision_id && <span>Follow-up to <code>{release.originating_decision_id}</code></span>}
          {typeof release.retry_state.reason === 'string' && <span>Evaluator: {release.retry_state.reason}</span>}
          {release.pr_url && <a className="underline" href={release.pr_url} target="_blank" rel="noreferrer">Open pull request</a>}
        </div>
      </details>
    </article>
  );
}

function ExperimentLifecycleRow({ experiment }: { experiment: Experiment }) {
  const stage = deriveExperimentStage(experiment);
  const outcome = experimentOutcome(experiment);
  return (
    <article aria-label={experiment.name} className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><ShipStageBadge stage={stage} /><Badge variant="outline">Experiment</Badge></div>
        <h3 className="mt-2 font-medium">{experiment.name}</h3>
        <p className="mt-1 break-words text-sm text-muted-foreground">{experiment.hypothesis}</p>
      </div>
      <div className="min-w-0">
        <div className={outcome.available ? 'text-sm font-medium' : 'text-sm font-medium text-muted-foreground'}>{outcome.title}</div>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{outcome.detail}</p>
      </div>
      <div className="flex items-start lg:justify-end"><Button asChild size="sm" variant="outline"><Link to="/experiments">Open experiment</Link></Button></div>
      <details className="min-w-0 lg:col-span-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8">Technical details</summary>
        <div className="grid min-w-0 gap-x-5 gap-y-1 border-l pl-3 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
          <span>Experiment <code className="break-all">{experiment.id}</code></span>
          <span>Raw status <code>{experiment.status}</code></span>
          <span>Environment <code>{experiment.env ?? 'legacy-all'}</code></span>
          <span>Metric <code>{experiment.primary_metric_key}</code></span>
          <span>Flag <code>{experiment.flag_key}</code></span>
          <span>Snapshot <code>{experiment.snapshot_integrity}</code></span>
        </div>
      </details>
    </article>
  );
}

function MetricChange({ detail }: { detail: DecisionDetail }) {
  const metric = detail.evidence.primary_evidence;
  const relative = metric.change.relative;
  return (
    <p>
      {metric.metric.name}: {metric.baseline.value} → {metric.observed.value}
      {relative !== null && <span className={relative >= 0 ? 'text-emerald-600' : 'text-destructive'}> ({relative >= 0 ? '+' : ''}{Math.round(relative * 100)}%)</span>}
    </p>
  );
}

function shortSha(value: string) { return value.slice(0, 10); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
