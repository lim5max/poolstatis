import { Badge } from '@/components/ui/badge';
import type { Decision, DecisionDetail, Experiment, Release } from '../api/types';

export const SHIP_STAGES = [
  'preparing',
  'running',
  'waiting_for_evidence',
  'ready_to_decide',
  'decided',
  'concluded_without_decision',
] as const;

export type ShipStage = typeof SHIP_STAGES[number];

export const SHIP_STAGE_LABELS: Record<ShipStage, string> = {
  preparing: 'Preparing',
  running: 'Running',
  waiting_for_evidence: 'Waiting for evidence',
  ready_to_decide: 'Ready to decide',
  decided: 'Decided',
  concluded_without_decision: 'Concluded',
};

export function deriveReleaseStage(release: Release, decision?: Decision): ShipStage {
  if (release.status === 'cancelled' || release.status === 'decided' || decision?.status === 'approved' || decision?.status === 'rejected') return 'decided';
  if (decision?.status === 'proposed') return 'ready_to_decide';
  if (release.status === 'observing') return 'waiting_for_evidence';
  if (release.status === 'deployed') return 'running';
  return 'preparing';
}

export function deriveExperimentStage(experiment: Experiment): ShipStage {
  if (experiment.status === 'concluded') return experiment.decision ? 'decided' : 'concluded_without_decision';
  if (experiment.status === 'running') return 'running';
  return 'preparing';
}

export function deriveDecisionStage(decision: Decision): ShipStage {
  return decision.status === 'proposed' ? 'ready_to_decide' : 'decided';
}

export interface ShipOutcome {
  title: string;
  detail: string;
  available: boolean;
}

const decisionOutcomeLabel: Record<NonNullable<Decision['accepted_outcome']>, string> = {
  keep: 'Keep the change',
  fix: 'Fix and follow up',
  rollback: 'Roll back',
  inconclusive: 'Inconclusive',
};

export function releaseOutcome(release: Release, detail?: DecisionDetail): ShipOutcome {
  const decision = detail?.decision;
  if (decision?.status === 'approved' && decision.accepted_outcome) {
    return {
      title: decisionOutcomeLabel[decision.accepted_outcome],
      detail: decision.accepted_rationale ?? 'The accepted decision has no recorded rationale.',
      available: true,
    };
  }
  if (decision?.status === 'rejected') {
    return {
      title: 'Proposal rejected',
      detail: decision.accepted_rationale ?? 'No rejection rationale was recorded.',
      available: true,
    };
  }
  if (decision?.status === 'proposed') {
    return {
      title: `Review proposal: ${decisionOutcomeLabel[decision.proposed_outcome]}`,
      detail: decision.proposed_rationale,
      available: true,
    };
  }
  if (release.status === 'cancelled') {
    return { title: 'Change cancelled', detail: 'No measured decision was recorded.', available: true };
  }
  const detailByStatus: Partial<Record<Release['status'], string>> = {
    planned: 'The change has not been deployed.',
    deployed: 'The change is live, but no observation result is available yet.',
    observing: 'Poolstatis is waiting for enough evidence to propose a decision.',
    decided: 'The release is final, but its decision record is unavailable.',
  };
  return {
    title: 'Outcome not available yet',
    detail: detailByStatus[release.status] ?? 'No measured outcome is available.',
    available: false,
  };
}

const experimentOutcomeLabel: Record<NonNullable<Experiment['decision']>['outcome'], string> = {
  ship: 'Decision: Ship',
  iterate: 'Decision: Iterate',
  stop: 'Decision: Stop',
  inconclusive: 'Decision: Inconclusive',
};

export function experimentOutcome(experiment: Experiment): ShipOutcome {
  if (experiment.decision) {
    const delivery = experiment.decision.ship_variant_key
      ? `${experiment.decision.ship_variant_key} moved to 100%`
      : 'Decision recorded · rollout unchanged';
    return {
      title: delivery,
      detail: `${experimentOutcomeLabel[experiment.decision.outcome]}. ${experiment.decision.rationale}`,
      available: true,
    };
  }
  if (experiment.status === 'concluded') {
    return {
      title: 'Concluded without decision',
      detail: 'The measurement window is closed and no rollout decision was recorded. This experiment is final.',
      available: false,
    };
  }
  return {
    title: 'Outcome not available yet',
    detail: experiment.status === 'running'
      ? 'The experiment is collecting exposure evidence.'
      : 'The experiment has not started.',
    available: false,
  };
}

export function ShipLifecycleRail({ counts }: { counts: Record<ShipStage, number> }) {
  return (
    <ol aria-label="Ship lifecycle" className="grid grid-cols-2 border-b md:grid-cols-6">
      {SHIP_STAGES.map((stage, index) => (
        <li key={stage} className="min-w-0 border-b p-3 last:border-b-0 even:border-l md:border-b-0 md:border-l md:first:border-l-0">
          <div className="flex items-center gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs tabular-nums" aria-hidden="true">{index + 1}</span>
            <span className="min-w-0 text-xs font-medium leading-tight">{SHIP_STAGE_LABELS[stage]}</span>
          </div>
          <div className="mt-2 text-xs text-muted-foreground tabular-nums">{counts[stage]} {counts[stage] === 1 ? 'item' : 'items'}</div>
        </li>
      ))}
    </ol>
  );
}

export function ShipStageBadge({ stage }: { stage: ShipStage }) {
  const variant = stage === 'decided' ? 'default' : stage === 'ready_to_decide' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{SHIP_STAGE_LABELS[stage]}</Badge>;
}

export function ShipDocumentationPreview() {
  const stages = [
    'Register release',
    'Collect real exposure',
    'Read the measured outcome',
    'Prepare a proposal',
    'Human decision',
  ];
  return (
    <section className="rounded-panel border bg-card p-4 sm:p-5" role="region" aria-label="Release decision loop documentation preview">
      <div className="text-xs font-medium text-muted-foreground">Documentation preview · versioned workflow</div>
      <h2 className="mt-1 text-base font-medium">From <code>poolstatis.yml</code> to a reviewed decision</h2>
      <ol className="mt-4 grid gap-2 sm:grid-cols-5">
        {stages.map((stage, index) => (
          <li key={stage} className="rounded-control border bg-muted/20 p-3 text-sm">
            <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
            <span className="mt-1 block font-medium">{stage}</span>
          </li>
        ))}
      </ol>
      <pre className="mt-4 overflow-auto rounded-control border bg-background p-3 text-xs leading-relaxed">{`contract_key: shorter_onboarding
commit_sha: <deployed commit>
observation_window_days: 7
decision_owner: growth-team`}</pre>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Illustrative field names from the repository workflow. Poolstatis fills release, evidence, and decision values only from server read-back.
      </p>
    </section>
  );
}
