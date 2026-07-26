import { useState } from 'react';
import { Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, Toolbar } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { Decision, DecisionDetail, Release } from '../api/types';

export function Changes() {
  const { client, project, env } = useStore();
  const audit = useAsync(async () => {
    const [releases, decisions] = await Promise.all([
      client!.releases(project!, { env }),
      client!.decisions(project!),
    ]);
    const latestByRelease = new Map<string, Decision>();
    for (const decision of decisions) {
      if (!latestByRelease.has(decision.release_id)) latestByRelease.set(decision.release_id, decision);
    }
    const details = await Promise.all([...latestByRelease.values()].map((decision) => client!.decision(project!, decision.id)));
    return { releases, decisions: new Map(details.map((detail) => [detail.decision.release_id, detail])) };
  }, [project, env]);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const evaluate = async (release: Release) => {
    setBusy(release.id); setActionError(null);
    try {
      await client!.evaluateRelease(project!, release.id);
      audit.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'could not evaluate release');
    } finally { setBusy(null); }
  };

  if (audit.loading) return <Loading what="reading release evidence…" />;
  if (audit.error) return <RecoverableError onRetry={audit.reload}>{audit.error}</RecoverableError>;
  if (!audit.data) return null;
  const { releases, decisions } = audit.data;
  return <div className="space-y-4">
    <Panel title="Changes" right={<span className="text-xs text-muted-foreground">release provenance → measured outcome</span>}>
      <p className="max-w-3xl text-sm text-muted-foreground">Each release keeps its contract, commit, observation window, and reviewed outcome together.</p>
    </Panel>
    <Panel>
      <Toolbar left={<span className="text-sm">Environment <code>{env}</code></span>} center={<Badge variant="outline">{releases.length} releases</Badge>} right={<Button variant="outline" size="sm" onClick={audit.reload}>Refresh evidence</Button>} />
      {actionError && <div className="p-5 pb-0"><ErrorNote>{actionError}</ErrorNote></div>}
      {releases.length === 0 ? <EmptyState headline="No registered changes" lead="register a release from CI to start its decision record" /> : <div className="divide-y">{releases.map((release) => <ReleaseAudit key={release.id} release={release} detail={decisions.get(release.id)} busy={busy === release.id} onEvaluate={() => evaluate(release)} />)}</div>}
    </Panel>
  </div>;
}

function ReleaseAudit({ release, detail, busy, onEvaluate }: { release: Release; detail?: DecisionDetail; busy: boolean; onEvaluate: () => void }) {
  const evidence = detail?.evidence;
  const decision = detail?.decision;
  const canEvaluate = release.status === 'deployed' || release.status === 'observing';
  return <article className="space-y-4 p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="font-medium">{release.contract_snapshot.name}</div><div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground"><code>{shortSha(release.commit_sha)}</code><span>{release.repository}</span><span>contract r{release.contract_revision}</span>{release.experiment_key && <span>experiment <code>{release.experiment_key}</code></span>}{release.flag_key && <span>flag <code>{release.flag_key}</code></span>}</div></div>
      <div className="flex items-center gap-2"><ReleaseBadge status={release.status} />{canEvaluate && <Button size="sm" onClick={onEvaluate} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Evaluate</Button>}</div>
    </div>
    <div className="grid gap-3 lg:grid-cols-5">
      <AuditStep number="1" title="Expected outcome"><p>{release.contract_snapshot.business_hypothesis}</p><p className="mt-2 text-muted-foreground"><code>{release.contract_snapshot.primary_metric_key}</code> should {release.contract_snapshot.expected_direction.replaceAll('_', ' ')}.</p></AuditStep>
      <AuditStep number="2" title="What happened">{evidence ? <><MetricChange detail={detail!} /><p className="mt-2 text-muted-foreground">{evidence.sample_size} actors · {formatWindow(evidence.observed_window)}</p></> : <p className="text-muted-foreground">No evidence set yet.</p>}</AuditStep>
      <AuditStep number="3" title="Trust">{evidence ? <><Badge variant={evidence.trust.status === 'trusted' ? 'default' : 'destructive'}>{evidence.trust.status}</Badge><p className="mt-2 text-muted-foreground">{evidence.ready ? 'Sample and window are ready.' : evidence.blockers[0]?.message ?? 'Evidence is incomplete.'}</p></> : <p className="text-muted-foreground">Pending evaluation.</p>}</AuditStep>
      <AuditStep number="4" title="Requested decision">{decision ? <><DecisionBadge outcome={decision.proposed_outcome} /><p className="mt-2 text-muted-foreground">{decision.proposed_rationale}</p></> : <p className="text-muted-foreground">No proposal yet.</p>}</AuditStep>
      <AuditStep number="5" title="After approval">{decision?.status === 'approved' ? <><DecisionBadge outcome={decision.accepted_outcome!} /><p className="mt-2 text-muted-foreground">{decision.accepted_rationale}</p></> : decision?.status === 'rejected' ? <Badge variant="destructive">rejected</Badge> : <p className="text-muted-foreground">Human review required; no action has been executed.</p>}</AuditStep>
    </div>
    <div className="border-t pt-3 text-xs text-muted-foreground">Deployed {release.deployed_at ? formatDate(release.deployed_at) : 'not yet'} · branch {release.branch ?? 'not recorded'}{release.originating_decision_id ? <> · follow-up to decision <code>{release.originating_decision_id.slice(0, 8)}</code></> : ''} · {release.evaluation_attempts} monitor attempts{release.next_evaluation_at ? ` · next ${formatDate(release.next_evaluation_at)}` : ''}{typeof release.retry_state.reason === 'string' ? ` · ${release.retry_state.reason}` : ''}{release.pr_url && <> · <a className="underline" href={release.pr_url} target="_blank" rel="noreferrer">pull request</a></>}</div>
  </article>;
}

function AuditStep({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <section className="min-w-0 rounded-md border bg-muted/20 p-3 text-xs"><div className="mb-2 flex items-center gap-2"><span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">{number}</span><span className="font-medium">{title}</span></div>{children}</section>;
}
function MetricChange({ detail }: { detail: DecisionDetail }) { const metric = detail.evidence.primary_evidence; const relative = metric.change.relative; return <p><code>{metric.metric.key}</code>: {metric.baseline.value} → {metric.observed.value}{relative !== null && <span className={relative >= 0 ? 'text-emerald-600' : 'text-destructive'}> ({relative >= 0 ? '+' : ''}{Math.round(relative * 100)}%)</span>}</p>; }
function ReleaseBadge({ status }: { status: Release['status'] }) { return <Badge variant={status === 'decided' ? 'default' : status === 'cancelled' ? 'secondary' : 'outline'}>{status}</Badge>; }
function DecisionBadge({ outcome }: { outcome: NonNullable<Decision['accepted_outcome']> }) { return <Badge variant={outcome === 'keep' ? 'default' : outcome === 'rollback' ? 'destructive' : 'outline'}>{outcome}</Badge>; }
function shortSha(value: string) { return value.slice(0, 10); }
function formatWindow(window: { from: string; to: string }) { return `${new Date(window.from).toLocaleDateString()}–${new Date(window.to).toLocaleDateString()}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
