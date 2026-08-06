import { useEffect, useState } from 'react';
import { Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ShipSectionNav, ShipStageBadge, deriveDecisionStage } from '../components/ship-lifecycle';
import type { Decision, DecisionAction, DecisionActionType, DecisionDetail, DecisionOutcome } from '../api/types';

export function Decisions() {
  const { client, project } = useStore();
  const list = useAsync(() => client!.decisions(project!), [project]);
  const loop = useAsync(async () => {
    const [inbox, history, deliveries] = await Promise.all([
      client!.decisionInbox(project!), client!.decisionHistory(project!, { limit: 20 }), client!.webhookDeliveries(project!),
    ]);
    return { inbox, history: history.items, deliveries };
  }, [project]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (list.data && (!selectedId || !list.data.some((decision) => decision.id === selectedId))) setSelectedId(list.data[0]?.id ?? null);
  }, [list.data, selectedId]);
  const detail = useAsync(async () => selectedId ? client!.decision(project!, selectedId) : null, [project, selectedId, list.data]);

  if (list.loading) return <Loading what="reading decision revisions…" />;
  if (list.error) return <RecoverableError onRetry={list.reload}>{list.error}</RecoverableError>;
  if (!list.data) return null;
  return <div className="space-y-4 [&_button]:min-h-11 sm:[&_button]:min-h-9">
    <ShipSectionNav current="decisions" />
    <header className="max-w-3xl">
      <h1 className="serif text-3xl text-balance">Decision review</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Approve, correct, or reject an agent proposal against immutable evidence.</p>
    </header>
    {list.data.length === 0 ? <Panel><EmptyState headline="No proposed decisions" lead="evaluate an eligible release to create evidence" /></Panel> : <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Panel title={<>Queue <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{list.data.length}</span></>}><div className="-m-2 space-y-1">{list.data.map((decision) => <button key={decision.id} type="button" onClick={() => setSelectedId(decision.id)} aria-pressed={selectedId === decision.id} className={`w-full rounded-control p-3 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ${selectedId === decision.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{decisionQueueTitle(decision)}</span><ShipStageBadge stage={deriveDecisionStage(decision)} /></div><div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{decision.accepted_rationale ?? decision.proposed_rationale}</div></button>)}</div></Panel>
      {detail.loading ? <Panel><Loading what="reproducing evidence…" /></Panel> : detail.error ? <ErrorNote>{detail.error}</ErrorNote> : detail.data ? <DecisionReview detail={detail.data} onChanged={() => { list.reload(); detail.reload(); loop.reload(); }} /> : null}
    </div>}
    {loop.error ? <ErrorNote>{loop.error}</ErrorNote> : loop.data && <ContinuousLoopSummary {...loop.data} />}
  </div>;
}

function DecisionReview({ detail, onChanged }: { detail: DecisionDetail; onChanged: () => void }) {
  const { client, project } = useStore();
  const [rationale, setRationale] = useState(detail.decision.accepted_rationale ?? '');
  const [outcome, setOutcome] = useState<DecisionOutcome>(detail.decision.proposed_outcome);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setRationale(detail.decision.accepted_rationale ?? ''); setOutcome(detail.decision.proposed_outcome); }, [detail.decision.id, detail.decision.current_revision, detail.decision.accepted_rationale, detail.decision.proposed_outcome]);
  const decide = async (action: 'approve' | 'edit' | 'reject') => {
    setBusy(action); setError(null);
    try {
      if (action === 'approve') await client!.approveDecision(project!, detail.decision.id, rationale.trim());
      else if (action === 'reject') await client!.rejectDecision(project!, detail.decision.id, rationale.trim());
      else await client!.editDecision(project!, detail.decision.id, outcome, rationale.trim());
      onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not revise decision'); }
    finally { setBusy(null); }
  };
  const evidence = detail.evidence;
  const primary = evidence.primary_evidence;
  return <div className="space-y-4">
    <Panel title={detail.contract.name} right={<ShipStageBadge stage={deriveDecisionStage(detail.decision)} />}>
      <div className="flex flex-wrap items-center gap-2">{detail.decision.status === 'rejected' ? <Badge variant="destructive">proposal rejected</Badge> : <OutcomeBadge outcome={detail.decision.accepted_outcome ?? detail.decision.proposed_outcome} />}<span className="text-sm font-medium">{decisionQueueTitle(detail.decision)}</span></div>
      <p className="mt-2 text-sm text-muted-foreground">{detail.decision.accepted_rationale ?? detail.decision.proposed_rationale}</p>
      <p className="mt-3 border-t pt-3 text-sm">{detail.contract.business_hypothesis}</p>
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8">Technical details</summary>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-l pl-3 text-xs text-muted-foreground"><span>Decision <code className="break-all">{detail.decision.id}</code></span><span>Raw status <code>{detail.decision.status}</code></span><span>Release <code>{detail.release.commit_sha.slice(0, 10)}</code></span><span>Contract r{detail.release.contract_revision}</span><span>{detail.release.env}</span><span>{primary.source}</span></div>
      </details>
    </Panel>
    <Panel title="Evidence facts" right={<Badge variant={evidence.ready ? 'default' : 'destructive'}>{evidence.ready ? 'decision-ready' : 'blocked'}</Badge>}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Fact label="Baseline" value={primary.baseline.value} sub={`${formatWindow(evidence.baseline_window)} · ${primary.baseline.actors} actors`} /><Fact label="Observed" value={primary.observed.value} sub={`${formatWindow(evidence.observed_window)} · ${primary.observed.actors} actors`} /><Fact label="Change" value={formatChange(primary.change.relative)} sub={primary.metric.purpose} /><Fact label="Measurement trust" value={evidence.trust.status} sub={`${Math.round(evidence.trust.distinct_id_coverage * 100)}% stable identity`} /></div>
      {evidence.guardrail_evidence.length > 0 && <div className="mt-4 border-t pt-4"><div className="mb-2 text-xs font-medium text-muted-foreground">Guardrails</div>{evidence.guardrail_evidence.map((guardrail) => <div key={guardrail.metric.key} className="flex flex-wrap justify-between gap-2 py-1 text-sm"><code>{guardrail.metric.key}</code><span>{guardrail.baseline.value} → {guardrail.observed.value} · {formatChange(guardrail.change.relative)}</span></div>)}</div>}
      {evidence.blockers.length > 0 && <div className="mt-4 space-y-2 border-t pt-4">{evidence.blockers.map((blocker, index) => <div key={`${blocker.code}-${index}`} className="rounded-panel border border-destructive/30 bg-destructive/5 p-3 text-xs"><div className="font-medium">{blocker.message}</div><div className="mt-1 text-muted-foreground">Next: {blocker.next_action}</div></div>)}</div>}
    </Panel>
    <Panel title="Agent proposal"><div className="flex flex-wrap items-center gap-2"><OutcomeBadge outcome={detail.decision.proposed_outcome} /><span className="text-sm">{detail.decision.proposed_rationale}</span></div></Panel>
    <Panel title="Human decision" right={<span className="text-xs text-muted-foreground">no delivery action is executed here</span>}>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]"><Select value={outcome} onValueChange={(value) => setOutcome(value as DecisionOutcome)}><SelectTrigger aria-label="Accepted decision outcome"><SelectValue /></SelectTrigger><SelectContent>{(['keep', 'fix', 'rollback', 'inconclusive'] as const).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><Textarea aria-label="Decision rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain why this evidence supports the accepted decision." className="min-h-24" /></div>
      <div className="mt-3 flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => decide('reject')} disabled={detail.decision.status !== 'proposed' || Boolean(busy) || rationale.trim().length < 10}>{busy === 'reject' && <Loader2 className="size-4 animate-spin" />}Reject</Button><Button variant="outline" onClick={() => decide('edit')} disabled={detail.decision.status === 'approved' || Boolean(busy) || rationale.trim().length < 10}>{busy === 'edit' && <Loader2 className="size-4 animate-spin" />}Save correction</Button><Button onClick={() => decide('approve')} disabled={detail.decision.status !== 'proposed' || Boolean(busy) || rationale.trim().length < 10}>{busy === 'approve' && <Loader2 className="size-4 animate-spin" />}Approve proposal</Button></div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
    <DecisionAutomation detail={detail} onChanged={onChanged} />
    <TechnicalDecisionRecord detail={detail} />
  </div>;
}

function ContinuousLoopSummary({ inbox, history, deliveries }: {
  inbox: Awaited<ReturnType<NonNullable<ReturnType<typeof useStore>['client']>['decisionInbox']>>;
  history: Awaited<ReturnType<NonNullable<ReturnType<typeof useStore>['client']>['decisionHistory']>>['items'];
  deliveries: Awaited<ReturnType<NonNullable<ReturnType<typeof useStore>['client']>['webhookDeliveries']>>;
}) {
  return <details className="rounded-panel border bg-muted/10">
    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-5">
      <span>Decision operations &amp; audit</span>
      <span className="text-xs font-normal text-muted-foreground">{inbox.length} inbox · {history.length} history · {deliveries.length} deliveries</span>
    </summary>
    <div className="grid border-t lg:grid-cols-3">
      <section className="min-w-0 p-4 lg:border-r sm:p-5" aria-labelledby="decision-inbox-heading">
        <h2 id="decision-inbox-heading" className="text-sm font-medium">Decision inbox</h2>
        <div className="mt-3 divide-y">{inbox.length === 0 ? <p className="text-sm text-muted-foreground">No decisions need attention.</p> : inbox.slice(0, 4).map((item) => <div key={item.decision_id} className="py-3 first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm">{item.impact.metric_purpose}</span><Badge variant={item.state === 'needs_attention' ? 'destructive' : item.state === 'resolved' ? 'default' : 'outline'}>{item.state.replaceAll('_', ' ')}</Badge></div><div className="mt-1 text-xs text-muted-foreground">Impact {formatChange(item.impact.relative_change)} · requested: {item.requested_choice ?? 'none'}</div>{item.blocker && <div className="mt-2 text-xs text-destructive">{item.blocker.message}</div>}<details className="mt-1"><summary className="cursor-pointer text-xs text-muted-foreground">Metric key</summary><code className="mt-1 block break-all text-xs">{item.impact.metric_key}</code></details></div>)}</div>
      </section>
      <section className="min-w-0 border-t p-4 lg:border-r lg:border-t-0 sm:p-5" aria-labelledby="decision-memory-heading">
        <h2 id="decision-memory-heading" className="text-sm font-medium">Decision memory</h2>
        <div className="mt-3 divide-y">{history.length === 0 ? <p className="text-sm text-muted-foreground">No reviewed history yet.</p> : history.slice(0, 4).map((item) => <div key={item.decision_id} className="py-3 text-xs first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{item.proposed_outcome} → {item.accepted_outcome ?? item.status}</span>{item.stale && <Badge variant="outline">stale context</Badge>}</div><div className="mt-1 text-muted-foreground">{item.evidence_quality.sample_size} actors · {item.evidence_quality.trust}{item.proposal_disagreed ? ' · human corrected' : ''}</div><details className="mt-1"><summary className="cursor-pointer text-muted-foreground">Contract key</summary><code className="mt-1 block break-all">{item.contract_key}</code></details></div>)}</div>
      </section>
      <section className="min-w-0 border-t p-4 lg:border-t-0 sm:p-5" aria-labelledby="webhook-delivery-heading">
        <h2 id="webhook-delivery-heading" className="text-sm font-medium">Webhook delivery</h2>
        <div className="mt-3 divide-y">{deliveries.length === 0 ? <p className="text-sm text-muted-foreground">No delivery has been queued.</p> : deliveries.slice(0, 4).map((delivery) => <div key={delivery.id} className="py-3 text-xs first:pt-0"><div className="flex flex-wrap items-center justify-between gap-2"><span>{delivery.event_type}</span><Badge variant={delivery.status === 'delivered' ? 'default' : delivery.status === 'dead' ? 'destructive' : 'outline'}>{delivery.status}</Badge></div><div className="mt-1 text-muted-foreground">{delivery.attempt_count} attempts{delivery.last_error ? ` · ${delivery.last_error}` : ''}</div></div>)}</div>
      </section>
    </div>
  </details>;
}

function TechnicalDecisionRecord({ detail }: { detail: DecisionDetail }) {
  return <details className="rounded-panel border bg-muted/10">
    <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-5">
      <span>Technical record</span>
      <span className="text-xs font-normal text-muted-foreground">Query · {detail.revisions.length} revisions</span>
    </summary>
    <div className="space-y-5 border-t p-4 sm:p-5">
      <section aria-labelledby="reproducible-query-heading">
        <h2 id="reproducible-query-heading" className="text-sm font-medium">Reproducible query</h2>
        <pre className="mt-2 max-w-full overflow-x-auto rounded-panel bg-muted p-3 text-xs">{JSON.stringify(detail.evidence.query_specs, null, 2)}</pre>
      </section>
      <section className="border-t pt-4" aria-labelledby="revision-history-heading">
        <h2 id="revision-history-heading" className="text-sm font-medium">Revision history</h2>
        <div className="mt-3 divide-y">{detail.revisions.map((revision) => <div key={revision.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0"><div className="min-w-0"><div className="text-sm font-medium">r{revision.revision} · {revision.action}</div><div className="mt-1 break-words text-xs text-muted-foreground">{revision.rationale}</div></div><div className="text-right text-xs text-muted-foreground"><div>{revision.actor}</div><div>{new Date(revision.created_at).toLocaleString()}</div></div></div>)}</div>
      </section>
    </div>
  </details>;
}

function DecisionAutomation({ detail, onChanged }: { detail: DecisionDetail; onChanged: () => void }) {
  const { client, project } = useStore();
  const automation = useAsync(async () => {
    const [explanations, actions] = await Promise.all([
      client!.decisionExplanations(project!, detail.decision.id), client!.decisionActions(project!, detail.decision.id),
    ]);
    return { explanations, actions };
  }, [project, detail.decision.id, detail.decision.current_revision]);
  const [actionType, setActionType] = useState<DecisionActionType>('draft_implementation_prompt');
  const [actionText, setActionText] = useState('Draft the smallest measurable implementation follow-up from this accepted evidence.');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const explain = async () => { setBusy('explain'); setError(null); try { await client!.explainDecision(project!, detail.decision.id); automation.reload(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not explain outcome'); } finally { setBusy(null); } };
  const prepare = async () => {
    setBusy('prepare'); setError(null);
    try {
      const payload = actionType === 'draft_implementation_prompt' ? { prompt: actionText }
        : actionType === 'schedule_observation' ? { at: new Date(Date.now() + 86_400_000).toISOString() }
          : actionType === 'request_more_data' ? { request: actionText }
            : { event: 'decision.follow_up' };
      await client!.prepareDecisionAction(project!, detail.decision.id, {
        action_type: actionType, idempotency_key: `${detail.decision.id}:${actionType}:${Date.now()}`,
        target: { repository: detail.release.repository, env: detail.release.env }, payload,
        expected_effect: actionText,
      });
      automation.reload(); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not prepare action'); }
    finally { setBusy(null); }
  };
  const reviewAction = async (action: DecisionAction, command: 'approve' | 'reject' | 'retry') => {
    setBusy(action.id); setError(null);
    try {
      if (command === 'approve') await client!.approveDecisionAction(project!, action.id, action.confirmation_fingerprint);
      else if (command === 'reject') await client!.rejectDecisionAction(project!, action.id, 'This prepared follow-up is not appropriate for the accepted product decision.');
      else await client!.retryDecisionAction(project!, action.id);
      automation.reload(); onChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'could not review action'); }
    finally { setBusy(null); }
  };
  if (automation.loading) return <Panel><Loading what="reading hypotheses and prepared actions…" /></Panel>;
  if (automation.error) return <ErrorNote>{automation.error}</ErrorNote>;
  const data = automation.data ?? { explanations: [], actions: [] };
  return <>
    <Panel title="Correlation hypotheses" right={<Button size="sm" variant="outline" onClick={explain} disabled={Boolean(busy)}>{busy === 'explain' && <Loader2 className="size-4 animate-spin" />}Explain outcome</Button>}>
      {data.explanations.length === 0 ? <p className="text-sm text-muted-foreground">No bounded explanation snapshot yet. Explain reads registered metrics and trusted properties only; every result is correlation, not causality.</p> : <div className="space-y-2">{data.explanations[0]!.candidates.map((candidate) => <div key={`${candidate.kind}:${candidate.key}`} className="rounded-panel border p-3 text-xs"><div className="flex flex-wrap items-center justify-between gap-2"><div><Badge variant="outline">hypothesis</Badge> <code className="ml-1">{candidate.kind}.{candidate.key}</code></div><span>{candidate.strength} · score {candidate.score}</span></div><div className="mt-2 text-sm">{candidate.purpose}</div><div className="mt-1 text-muted-foreground">{candidate.why_considered}</div></div>)}</div>}
    </Panel>
    <Panel title="Approval-gated actions" right={<span className="text-xs text-muted-foreground">prepare → fingerprint → approve → execute</span>}>
      <div className="grid gap-3 sm:grid-cols-[14rem_1fr_auto]"><Select value={actionType} onValueChange={(value) => setActionType(value as DecisionActionType)}><SelectTrigger aria-label="Prepared action type"><SelectValue /></SelectTrigger><SelectContent>{(['draft_implementation_prompt', 'schedule_observation', 'request_more_data', 'generic_webhook'] as const).map((type) => <SelectItem key={type} value={type}>{type.replaceAll('_', ' ')}</SelectItem>)}</SelectContent></Select><Textarea aria-label="Expected action effect" value={actionText} onChange={(event) => setActionText(event.target.value)} /><Button onClick={prepare} disabled={Boolean(busy) || actionText.trim().length < 10}>{busy === 'prepare' && <Loader2 className="size-4 animate-spin" />}Prepare</Button></div>
      <div className="mt-4 space-y-2">{data.actions.map((action) => <div key={action.id} className="rounded-panel border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><span className="text-sm font-medium">{action.action_type.replaceAll('_', ' ')}</span><div className="mt-1 text-xs text-muted-foreground">Undo: {String(action.undo.action)} · fingerprint <code>{action.confirmation_fingerprint.slice(0, 10)}</code></div></div><Badge variant={action.status === 'executed' ? 'default' : action.status === 'failed' ? 'destructive' : 'outline'}>{action.status}</Badge></div><div className="mt-2 text-xs">{action.expected_effect}</div>{action.error_message && <div className="mt-2 text-xs text-destructive">{action.error_message}</div>}<div className="mt-3 flex justify-end gap-2">{action.status === 'prepared' && <><Button size="sm" variant="outline" onClick={() => reviewAction(action, 'reject')} disabled={busy === action.id}>Reject</Button><Button size="sm" onClick={() => reviewAction(action, 'approve')} disabled={busy === action.id}>Approve exact payload</Button></>}{action.status === 'failed' && <Button size="sm" variant="outline" onClick={() => reviewAction(action, 'retry')} disabled={busy === action.id}>Retry</Button>}</div></div>)}</div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  </>;
}

function Fact({ label, value, sub }: { label: string; value: string | number; sub: string }) { return <div className="rounded-panel border bg-muted/20 p-3"><div className="text-xs font-medium text-muted-foreground">{label}</div><div className="mt-1 text-xl font-medium tabular-nums">{value}</div><div className="mt-1 text-xs text-muted-foreground">{sub}</div></div>; }
function OutcomeBadge({ outcome }: { outcome: DecisionOutcome }) { return <Badge variant={outcome === 'keep' ? 'default' : outcome === 'rollback' ? 'destructive' : 'outline'}>{outcome}</Badge>; }
function decisionQueueTitle(decision: Decision) {
  const outcome = (decision.accepted_outcome ?? decision.proposed_outcome).replaceAll('_', ' ');
  if (decision.status === 'proposed') return `Review: ${outcome}`;
  if (decision.status === 'rejected') return `Rejected: ${outcome}`;
  return `Decided: ${outcome}`;
}
function formatChange(value: number | null) { return value === null ? 'not comparable' : `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`; }
function formatWindow(window: { from: string; to: string }) { return `${new Date(window.from).toLocaleDateString()}–${new Date(window.to).toLocaleDateString()}`; }
