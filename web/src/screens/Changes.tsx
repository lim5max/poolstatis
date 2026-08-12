import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { GitCommit, Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { ErrorNote, Loading, Panel, RecoverableError } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DisclosureSummary } from '@/components/disclosure';
import { GuidedFirstValue } from '../components/guided-first-value';
import {
  SHIP_STAGES,
  SHIP_STAGE_LABELS,
  ShipLifecycleRail,
  ShipDocumentationPreview,
  ShipStageBadge,
  deriveExperimentStage,
  deriveReleaseStage,
  experimentOutcome,
  releaseOutcome,
  type ShipStage,
} from '../components/ship-lifecycle';
import type { Decision, DecisionDetail, Experiment, MeasurementContract, Release } from '../api/types';

type LifecycleItem =
  | { kind: 'release'; id: string; stage: ShipStage; updatedAt: string; release: Release; detail?: DecisionDetail }
  | { kind: 'experiment'; id: string; stage: ShipStage; updatedAt: string; experiment: Experiment; linkedRelease?: Release };

export function Changes() {
  const { client, project, env } = useStore();
  const [params] = useSearchParams();
  const requestedReleaseId = params.get('release');
  const requestedExperimentKey = params.get('experiment');
  const audit = useAsync(async () => {
    const [releases, listedDecisions, experiments, contracts] = await Promise.all([
      client!.releases(project!, { env }),
      client!.decisions(project!, { env }),
      client!.experiments(project!),
      client!.contracts(project!),
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
      contracts,
      decisions: new Map(details.map((detail) => [detail.decision.release_id, detail])),
    };
  }, [project, env]);
  const [busy, setBusy] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!audit.data) return;
    const target = requestedReleaseId
      ? document.querySelector<HTMLElement>(`[data-ship-release="${requestedReleaseId}"]`)
      : requestedExperimentKey
        ? document.querySelector<HTMLElement>(`[data-ship-experiment="${requestedExperimentKey}"]`)
        : null;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'center' });
  }, [audit.data, requestedExperimentKey, requestedReleaseId]);
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
  const { releases, experiments, decisions, contracts } = audit.data;
  const activeContracts = contracts.filter((contract) => contract.status === 'active');
  const items: LifecycleItem[] = [
    ...releases.map((release): LifecycleItem => {
      const detail = decisions.get(release.id);
      return { kind: 'release', id: release.id, stage: deriveReleaseStage(release, detail?.decision), updatedAt: release.updated_at, release, detail };
    }),
    ...experiments.map((experiment): LifecycleItem => ({
      kind: 'experiment', id: experiment.id, stage: deriveExperimentStage(experiment), updatedAt: experiment.updated_at, experiment,
      linkedRelease: linkedExperimentRelease(experiment, releases),
    })),
  ].sort((a, b) => SHIP_STAGES.indexOf(a.stage) - SHIP_STAGES.indexOf(b.stage)
    || Number(!isRequestedShipItem(a, requestedReleaseId, requestedExperimentKey)) - Number(!isRequestedShipItem(b, requestedReleaseId, requestedExperimentKey))
    || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const counts = Object.fromEntries(SHIP_STAGES.map((stage) => [stage, items.filter((item) => item.stage === stage).length])) as Record<ShipStage, number>;

  return (
    <div className="space-y-4 [&_button]:min-h-11 sm:[&_button]:min-h-9">
      <header className="max-w-3xl">
        <h1 className="serif text-3xl text-balance">Ship</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Follow every release and experiment from preparation to a human-reviewed outcome.
        </p>
      </header>
      {items.length === 0 ? (
        <>
          <GuidedFirstValue
            title="Start the first release decision loop"
            outcome="Register immutable deploy provenance against an active measurement contract. Poolstatis can then wait for the real observation window, evaluate evidence, and ask for a human decision."
            checks={[
              {
                label: 'Active measurement contract',
                ready: activeContracts.length > 0,
                detail: activeContracts.length > 0
                  ? `${activeContracts.length} active ${activeContracts.length === 1 ? 'contract defines' : 'contracts define'} expected outcomes and guardrails.`
                  : 'Apply and activate a versioned contract before attaching a release.',
              },
              {
                label: 'Immutable release provenance',
                ready: releases.length > 0,
                detail: 'Repository, commit, environment, deploy time, and frozen contract revision are stored together.',
              },
              {
                label: 'Evidence readout and human decision',
                ready: decisions.size > 0,
                detail: 'The durable monitor uses real metric windows; it never turns insufficient evidence into a directional answer.',
              },
            ]}
            action={activeContracts.length > 0
              ? <Button onClick={() => setRegistering(true)}><GitCommit className="size-4" />Register release</Button>
              : <Button asChild><Link to="/experiments">Create experiment</Link></Button>}
            agentTask={releaseSetupTask(project!, env, activeContracts)}
            referenceTitle="First real lifecycle result"
            referenceItems={[
              'Expected outcome and frozen contract revision',
              'Release commit and observation window',
              'Measured change, evidence trust, and blockers',
              'Keep, fix, rollback, or inconclusive proposal for review',
            ]}
          />
          <ShipDocumentationPreview />
          {registering && activeContracts.length > 0 && (
            <RegisterReleaseForm
              env={env}
              contracts={activeContracts}
              onCancel={() => setRegistering(false)}
              onCreated={() => { setRegistering(false); audit.reload(); }}
            />
          )}
        </>
      ) : (
      <Panel>
        <div className="-m-5">
          <ShipLifecycleRail counts={counts} />
          <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5">
            <span className="text-sm">Environment <code>{env}</code></span>
            <Badge variant="outline">{items.length} {items.length === 1 ? 'item' : 'items'}</Badge>
            <div className="ml-auto flex flex-wrap gap-2">
              {activeContracts.length > 0 && <Button size="sm" onClick={() => setRegistering((value) => !value)}><GitCommit className="size-4" />Register release</Button>}
              <Button variant="outline" size="sm" onClick={audit.reload}>Refresh</Button>
            </div>
          </div>
          {actionError && <div className="p-4 sm:p-5"><ErrorNote>{actionError}</ErrorNote></div>}
          {SHIP_STAGES.map((stage) => {
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
                    ? <ReleaseLifecycleRow key={`release:${item.id}`} release={item.release} detail={item.detail} busy={busy === item.id} requested={item.id === requestedReleaseId} onEvaluate={() => evaluate(item.release)} />
                    : <ExperimentLifecycleRow key={`experiment:${item.id}`} experiment={item.experiment} linkedRelease={item.linkedRelease} requested={item.experiment.key === requestedExperimentKey} />)}
                </div>
              </section>
            );
          })}
        </div>
      </Panel>
      )}
      {items.length > 0 && registering && activeContracts.length > 0 && (
        <RegisterReleaseForm
          env={env}
          contracts={activeContracts}
          onCancel={() => setRegistering(false)}
          onCreated={() => { setRegistering(false); audit.reload(); }}
        />
      )}
    </div>
  );
}

function RegisterReleaseForm({
  env,
  contracts,
  onCancel,
  onCreated,
}: {
  env: string;
  contracts: MeasurementContract[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const { client, project } = useStore();
  const [contractKey, setContractKey] = useState(contracts[0]?.key ?? '');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [deployedAt, setDeployedAt] = useState('');
  const [deploymentId, setDeploymentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasExplicitOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(deployedAt.trim());
  const valid = Boolean(contractKey && repository.trim() && /^[a-f0-9]{7,64}$/i.test(commitSha.trim())
    && hasExplicitOffset && Number.isFinite(Date.parse(deployedAt.trim()))
    && /^[A-Za-z0-9._:-]{3,180}$/.test(deploymentId.trim())
    && (!prUrl.trim() || /^https:\/\//i.test(prUrl.trim())));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const normalizedSha = commitSha.trim().toLowerCase();
      const normalizedDeployedAt = new Date(deployedAt.trim()).toISOString();
      await client!.registerRelease(project!, {
        idempotency_key: `admin:${deploymentId.trim()}`,
        contract_key: contractKey,
        env,
        repository: repository.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        commit_sha: normalizedSha,
        ...(prUrl.trim() ? { pr_url: prUrl.trim() } : {}),
        deployed_at: normalizedDeployedAt,
        status: 'deployed',
      });
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not register release');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Register deployed release" right={<Badge variant="outline">Environment <code>{env}</code></Badge>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Measurement contract">
          <Select value={contractKey} onValueChange={setContractKey}>
            <SelectTrigger aria-label="Release measurement contract"><SelectValue /></SelectTrigger>
            <SelectContent>{contracts.map((contract) => <SelectItem key={contract.id} value={contract.key}>{contract.name} · r{contract.revision}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Repository"><Input aria-label="Release repository" value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="acme/product" /></Field>
        <Field label="Commit SHA"><Input aria-label="Release commit SHA" className="font-mono" value={commitSha} onChange={(event) => setCommitSha(event.target.value)} placeholder="7–64 hex characters" /></Field>
        <Field label="Branch (optional)"><Input aria-label="Release branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" /></Field>
        <Field label="Pull request URL (optional)"><Input aria-label="Release pull request URL" value={prUrl} onChange={(event) => setPrUrl(event.target.value)} placeholder="https://github.com/acme/product/pull/42" /></Field>
        <Field label="Deployed at">
          <Input aria-label="Release deployed at" className="font-mono" value={deployedAt} onChange={(event) => setDeployedAt(event.target.value)} placeholder="2026-08-11T15:24:00Z" />
        </Field>
        <Field label="Deployment id">
          <Input aria-label="Release deployment id" className="font-mono" value={deploymentId} onChange={(event) => setDeploymentId(event.target.value)} placeholder="deploy-2026-08-11-01" />
        </Field>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
        Use the exact deploy timestamp with <code>Z</code> or a UTC offset. Reuse the stable CI/deploy id after a timeout; use a new id for every redeploy or rollback, even when the commit SHA is unchanged. Registration freezes the current contract revision. It does not deploy code or change traffic.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-4">
        <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button onClick={submit} disabled={!valid || busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <GitCommit className="size-4" />}Register release</Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-sm text-muted-foreground">{label}</Label>{children}</div>;
}

function releaseSetupTask(project: string, env: string, contracts: MeasurementContract[]): string {
  const contractSummary = contracts.length > 0
    ? `Active contracts: ${contracts.map((contract) => `${contract.key} (r${contract.revision})`).join(', ')}.`
    : 'No active measurement contract exists yet.';
  return `Start the first Poolstatis release decision loop for project "${project}" in environment "${env}".

${contractSummary}

1. Inspect the repository and identify the exact deployed commit plus the business outcome this change is expected to affect.
2. Read current Poolstatis state through MCP. Reuse an active measurement contract only when its hypothesis, primary metric, guardrails, owner, and observation window match this change; otherwise propose and apply a reviewed poolstatis.yml contract first.
3. Call register_release with immutable repository, commit, environment, deploy time, and a stable idempotency key. Never claim or trigger a deployment.
4. Read the registered release back from the server and report the frozen contract revision, next observation state, and any blocker.
5. Do not expose project keys, credentials, raw event payloads, or personal data. Do not approve a future decision on my behalf.`;
}

function ReleaseLifecycleRow({ release, detail, busy, requested, onEvaluate }: {
  release: Release;
  detail?: DecisionDetail;
  busy: boolean;
  requested: boolean;
  onEvaluate: () => void;
}) {
  const stage = deriveReleaseStage(release, detail?.decision);
  const outcome = releaseOutcome(release, detail);
  const evidence = detail?.evidence;
  const canEvaluate = release.status === 'deployed' || release.status === 'observing';
  const blocker = evidence?.blockers[0]?.message
    ?? (typeof release.retry_state.reason === 'string' ? release.retry_state.reason : null)
    ?? (stage === 'waiting_for_evidence' ? 'Waiting for sufficient trusted evidence.' : stage === 'running' ? 'Observation has not produced a readout yet.' : 'No recorded blocker.');
  const expectedDecisionAt = release.next_evaluation_at ?? expectedDecisionDate(release);
  return (
    <article aria-label={release.contract_snapshot.name} aria-current={requested ? 'true' : undefined} data-ship-release={release.id} tabIndex={requested ? -1 : undefined} className={`grid min-w-0 gap-4 p-4 outline-none lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:p-5 ${requested ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''}`}>
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
      <dl className="grid min-w-0 gap-3 rounded-control border bg-muted/20 p-3 text-xs sm:grid-cols-3 lg:col-span-3">
        <div className="min-w-0"><dt className="text-muted-foreground">Blocker</dt><dd className="mt-1 break-words font-medium">{blocker}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Owner</dt><dd className="mt-1 break-words font-medium">{release.contract_snapshot.decision_owner}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Expected decision</dt><dd className="mt-1 break-words font-medium">{expectedDecisionAt ? formatDate(expectedDecisionAt) : 'Not scheduled'}</dd></div>
      </dl>
      <details className="group/disclosure min-w-0 lg:col-span-3">
        <DisclosureSummary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">
          Technical details
        </DisclosureSummary>
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

function ExperimentLifecycleRow({ experiment, linkedRelease, requested }: { experiment: Experiment; linkedRelease?: Release; requested: boolean }) {
  const stage = deriveExperimentStage(experiment);
  const outcome = experimentOutcome(experiment);
  const expectedDecisionAt = linkedRelease
    ? linkedRelease.next_evaluation_at ?? expectedDecisionDate(linkedRelease)
    : null;
  return (
    <article aria-label={experiment.name} aria-current={requested ? 'true' : undefined} data-ship-experiment={experiment.key} tabIndex={requested ? -1 : undefined} className={`grid min-w-0 gap-4 p-4 outline-none lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:p-5 ${requested ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''}`}>
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
      <dl className="grid min-w-0 gap-3 rounded-control border bg-muted/20 p-3 text-xs sm:grid-cols-3 lg:col-span-3">
        <div className="min-w-0"><dt className="text-muted-foreground">Blocker</dt><dd className="mt-1 break-words font-medium">{experiment.status === 'running' ? 'Collecting exposure evidence.' : experiment.status === 'draft' ? 'Experiment has not started.' : 'No recorded blocker.'}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Owner</dt><dd className="mt-1 break-words font-medium">{linkedRelease?.contract_snapshot.decision_owner ?? 'Not in experiment contract'}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Expected decision</dt><dd className="mt-1 break-words font-medium">{expectedDecisionAt ? formatDate(expectedDecisionAt) : 'Not scheduled'}</dd></div>
      </dl>
      <details className="group/disclosure min-w-0 lg:col-span-3">
        <DisclosureSummary className="inline-flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8">Technical details</DisclosureSummary>
        <div className="grid min-w-0 gap-x-5 gap-y-1 border-l pl-3 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
          <span>Experiment <code className="break-all">{experiment.id}</code></span>
          <span>Raw status <code>{experiment.status}</code></span>
          <span>Environment <code>{experiment.env ?? 'legacy-all'}</code></span>
          <span>Metric <code>{experiment.primary_metric_key}</code></span>
          <span>Flag <code>{experiment.flag_key}</code></span>
          <span>Snapshot <code>{experiment.snapshot_integrity}</code></span>
          {linkedRelease && <span>Linked release <code className="break-all">{linkedRelease.id}</code></span>}
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
      {relative !== null && <span className="text-muted-foreground"> ({relative >= 0 ? '+' : ''}{Math.round(relative * 100)}%)</span>}
    </p>
  );
}

function shortSha(value: string) { return value.slice(0, 10); }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }

function expectedDecisionDate(release: Release): string | null {
  if (!release.deployed_at) return null;
  const deployedAt = new Date(release.deployed_at).getTime();
  if (!Number.isFinite(deployedAt)) return null;
  return new Date(deployedAt + release.contract_snapshot.observation_window_days * 86_400_000).toISOString();
}

function linkedExperimentRelease(experiment: Experiment, releases: Release[]): Release | undefined {
  return releases
    .filter((release) => release.experiment_key === experiment.key)
    .sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())[0];
}

function isRequestedShipItem(
  item: LifecycleItem,
  releaseId: string | null,
  experimentKey: string | null,
): boolean {
  return item.kind === 'release'
    ? item.id === releaseId
    : item.experiment.key === experimentKey;
}
