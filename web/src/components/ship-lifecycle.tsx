import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import type { Decision, DecisionDetail, Experiment, Release } from '../api/types';

export const SHIP_STAGES = [
  'preparing',
  'running',
  'waiting_for_evidence',
  'ready_to_decide',
  'decided',
] as const;

export type ShipStage = typeof SHIP_STAGES[number];

export const SHIP_STAGE_LABELS: Record<ShipStage, string> = {
  preparing: 'Preparing',
  running: 'Running',
  waiting_for_evidence: 'Waiting for evidence',
  ready_to_decide: 'Ready to decide',
  decided: 'Decided',
};

export function deriveReleaseStage(release: Release, decision?: Decision): ShipStage {
  if (release.status === 'cancelled' || release.status === 'decided' || decision?.status === 'approved' || decision?.status === 'rejected') return 'decided';
  if (decision?.status === 'proposed') return 'ready_to_decide';
  if (release.status === 'observing') return 'waiting_for_evidence';
  if (release.status === 'deployed') return 'running';
  return 'preparing';
}

export function deriveExperimentStage(experiment: Experiment): ShipStage {
  if (experiment.status === 'concluded') return 'decided';
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
  ship: 'Ship the winner',
  iterate: 'Iterate on the change',
  stop: 'Stop the change',
  inconclusive: 'Inconclusive',
};

export function experimentOutcome(experiment: Experiment): ShipOutcome {
  if (experiment.decision) {
    return {
      title: experimentOutcomeLabel[experiment.decision.outcome],
      detail: experiment.decision.rationale,
      available: true,
    };
  }
  if (experiment.status === 'concluded') {
    return {
      title: 'Outcome unavailable',
      detail: 'This experiment concluded without a recorded decision.',
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

const SHIP_VIEWS = [
  { id: 'lifecycle', label: 'Lifecycle', href: '/changes' },
  { id: 'experiments', label: 'Experiments & flags', href: '/experiments' },
  { id: 'decisions', label: 'Decision review', href: '/decisions' },
] as const;

export function ShipSectionNav({ current }: { current: typeof SHIP_VIEWS[number]['id'] }) {
  return (
    <nav aria-label="Ship views" className="grid w-full grid-cols-3 gap-1 rounded-panel border bg-muted/20 p-1 sm:w-fit sm:min-w-xl">
      {SHIP_VIEWS.map((view) => (
        <Link
          key={view.id}
          to={view.href}
          aria-current={current === view.id ? 'page' : undefined}
          className={cn(
            'flex min-h-11 min-w-0 items-center justify-center rounded-control px-2 text-center text-xs leading-tight outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-4 sm:text-sm',
            current === view.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {view.label}
        </Link>
      ))}
    </nav>
  );
}

export function ShipLifecycleRail({ counts }: { counts: Record<ShipStage, number> }) {
  return (
    <ol aria-label="Ship lifecycle" className="grid grid-cols-2 border-b md:grid-cols-5">
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
