import { useState, type FormEvent } from 'react';
import { useAsync, useStore } from '../store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DisclosureSummary } from '@/components/disclosure';
import { EmptyState, ErrorNote, Loading, Panel, Stat } from '../components/ui';
import type {
  AutomationInboxNotification, AutomationProposal, InsightFeedSchedule, InsightFeedSnapshot,
  MonitorFinding, MonitorPolicy, NotificationDelivery, NotificationDestination,
} from '../api/types';

export interface ControlTowerData {
  capabilities: { in_product: 'configured'; outbox: 'configured'; external: 'not_configured' };
  destinations: NotificationDestination[];
  policies: MonitorPolicy[];
  schedules: InsightFeedSchedule[];
  findings: MonitorFinding[];
  proposals: AutomationProposal[];
  snapshots: InsightFeedSnapshot[];
  inbox: AutomationInboxNotification[];
  deliveries: NotificationDelivery[];
}

interface ControlTowerViewProps {
  data: ControlTowerData; busy: boolean; error: string | null; env?: string;
  reviewAccess: 'allowed' | 'sign_in_required' | 'insufficient_role';
  onReload(): void;
  onReview(id: string, decision: 'approve' | 'reject', fingerprint: string, rationale: string): void;
  onSetMonitorStatus(policy: MonitorPolicy, status: MonitorPolicy['status']): void;
  onSetScheduleStatus(schedule: InsightFeedSchedule, status: InsightFeedSchedule['status']): void;
  onCreateDestination(input: { key: string; name: string; kind: 'in_product' | 'outbox' }): void;
  onCreateMonitor(input: Record<string, unknown>): void;
  onCreateSchedule(input: Record<string, unknown>): void;
}

export function ControlTower() {
  const { client, project, env, tokenKind, account } = useStore();
  const resource = useAsync(async (): Promise<ControlTowerData> => {
    const [capabilities, destinations, policies, schedules, findings, proposals, snapshots, inbox, deliveries] = await Promise.all([
      client!.automationCapabilities(project!), client!.notificationDestinations(project!), client!.monitorPolicies(project!),
      client!.insightFeedSchedules(project!), client!.monitorFindings(project!), client!.automationProposals(project!),
      client!.insightFeedSnapshots(project!), client!.automationInbox(project!), client!.notificationDeliveries(project!),
    ]);
    return { capabilities, destinations, policies, schedules, findings, proposals, snapshots, inbox, deliveries };
  }, [client, project]);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (resource.loading && !resource.data) return <Loading what="Loading control tower…" />;
  if (!resource.data) return <ErrorNote>{resource.error ?? 'Control tower data is unavailable.'}</ErrorNote>;
  const mutate = async (fn: () => Promise<unknown>) => {
    setBusy(true); setMutationError(null);
    try { await fn(); resource.reload(); }
    catch (error) { setMutationError(error instanceof Error ? error.message : 'Mutation failed'); }
    finally { setBusy(false); }
  };
  const reviewAccess = tokenKind !== 'user'
    ? 'sign_in_required'
    : account?.membership.role === 'owner' || account?.membership.role === 'admin'
      ? 'allowed'
      : 'insufficient_role';
  return <ControlTowerView data={resource.data} busy={busy} error={mutationError ?? resource.error} env={env} reviewAccess={reviewAccess}
    onReload={resource.reload}
    onReview={(id, decision, fingerprint, rationale) => void mutate(() => client!.reviewAutomationProposal(project!, id, decision, fingerprint, rationale))}
    onSetMonitorStatus={(policy, status) => void mutate(() => client!.setMonitorPolicyStatus(project!, policy.id, policy.current_version, status))}
    onSetScheduleStatus={(schedule, status) => void mutate(() => client!.setInsightFeedScheduleStatus(project!, schedule.id, schedule.current_version, status))}
    onCreateDestination={(input) => void mutate(() => client!.createNotificationDestination(project!, input))}
    onCreateMonitor={(input) => void mutate(() => client!.createMonitorPolicy(project!, input))}
    onCreateSchedule={(input) => void mutate(() => client!.createInsightFeedSchedule(project!, input))} />;
}

export function ControlTowerView({ data, busy, error, env = 'prod', reviewAccess, onReload, onReview, onSetMonitorStatus,
  onSetScheduleStatus, onCreateDestination, onCreateMonitor, onCreateSchedule }: ControlTowerViewProps) {
  const pending = data.proposals.filter((proposal) => proposal.status === 'proposed').length;
  return (
    <div className="space-y-4 [&_button]:min-h-11 sm:[&_button]:min-h-9">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h1 className="serif text-3xl text-balance">Control tower</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Configure bounded monitoring and scheduled agent answers. Automation freezes evidence and undo state; only a signed-in workspace owner or admin can record proposal review, and review never changes traffic or deploy state.
          </p>
        </div>
        <Button variant="outline" onClick={onReload} disabled={busy}>Refresh</Button>
      </header>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active monitors" value={data.policies.filter((policy) => policy.status === 'active').length} sub={`${data.findings.length} immutable findings`} />
        <Stat label="Review queue" value={pending} sub="API keys and MCP remain read-only; traffic is unchanged" />
        <Stat label="Scheduled feeds" value={data.schedules.filter((schedule) => schedule.status === 'active').length} sub={`${data.snapshots.length} immutable answers`} />
      </div>
      <Panel title="Notification routing" right={<Badge variant="outline">In-product + outbox</Badge>}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            External providers are not configured. The outbox stops at <code>ready_for_extension</code>; no webhook, email or chat provider is implied.
          </p>
          <DestinationForm disabled={busy} onSubmit={onCreateDestination} />
          <div className="grid gap-2 sm:grid-cols-2">
            {data.destinations.map((destination) => <div key={destination.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2"><span className="font-medium">{destination.name}</span><Badge variant="outline">{destination.kind.replace('_', ' ')}</Badge></div>
              <code className="mt-1 block text-xs text-muted-foreground">{destination.key}</code>
            </div>)}
          </div>
        </div>
      </Panel>
      <Panel title="Configurable monitors" right={<Badge variant="outline">Environment {env}</Badge>}>
        <div className="space-y-4">
          <MonitorForm env={env} disabled={busy} onSubmit={onCreateMonitor} />
          {data.policies.length === 0 ? <EmptyState headline="No monitors configured" lead="Create a semantic metric threshold without exposing raw event payloads." />
            : <div className="divide-y rounded-md border">{data.policies.map((policy) => <article key={policy.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{policy.name}</h3><Badge variant="outline">{policy.status}</Badge></div><code className="text-xs text-muted-foreground">{policy.revision.metric_key}</code></div>
              <p className="text-sm text-muted-foreground">{policy.revision.comparison_rule.replaceAll('_', ' ')} · threshold {policy.revision.threshold} · minimum {policy.revision.minimum_sample} · owner {policy.revision.owner}</p>
              <div className="flex gap-2">{policy.status === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSetMonitorStatus(policy, 'paused')}>Pause</Button>}{policy.status === 'paused' && <Button size="sm" disabled={busy} onClick={() => onSetMonitorStatus(policy, 'active')}>Resume</Button>}</div>
            </article>)}</div>}
        </div>
      </Panel>
      <Panel title="Human owner/admin review queue">
        {data.proposals.length === 0 ? <EmptyState headline="No automatic proposals" lead="A breached policy can freeze an exact proposal and undo state for review." />
          : <div className="divide-y rounded-md border">{data.proposals.map((proposal) => <ProposalReview key={proposal.id} proposal={proposal} busy={busy} reviewAccess={reviewAccess} onReview={onReview} />)}</div>}
      </Panel>
      <Panel title="Scheduled agent insight feed">
        <div className="space-y-4">
          <ScheduleForm env={env} disabled={busy} onSubmit={onCreateSchedule} />
          {data.schedules.map((schedule) => <article key={schedule.id} className="flex flex-wrap items-center gap-3 rounded-md border p-4">
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="font-medium">{schedule.name}</h3><Badge variant="outline">{schedule.status}</Badge></div><p className="text-xs text-muted-foreground">{schedule.revision.metric_key} · {schedule.revision.frequency} at {schedule.revision.local_time.slice(0, 5)} {schedule.revision.timezone}</p></div>
            {schedule.status === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onSetScheduleStatus(schedule, 'paused')}>Pause</Button>}
            {schedule.status === 'paused' && <Button size="sm" disabled={busy} onClick={() => onSetScheduleStatus(schedule, 'active')}>Resume</Button>}
          </article>)}
          {data.snapshots.map((snapshot) => <article key={snapshot.id} className="rounded-md border p-4"><Badge variant="outline">Immutable answer</Badge><h3 className="mt-2 font-medium">{snapshot.answer.headline}</h3><p className="mt-1 text-sm text-muted-foreground">{snapshot.answer.takeaway}</p><code className="mt-2 block break-all text-xs text-muted-foreground">definition {snapshot.definition_fingerprint}</code></article>)}
        </div>
      </Panel>
      <Panel title="Delivery journal" right={<Badge variant="outline">{data.inbox.length} in product</Badge>}>
        {data.deliveries.length === 0 ? <EmptyState headline="No delivery attempts yet" lead="Every configured finding or feed run receives an idempotent delivery record." />
          : <div className="divide-y rounded-md border">{data.deliveries.map((delivery) => <div key={delivery.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span>{delivery.destination_key ?? 'No destination configured'}</span><span className="text-muted-foreground">{delivery.status} · {delivery.attempt_count} attempts</span></div>)}</div>}
      </Panel>
    </div>
  );
}

function ProposalReview({ proposal, busy, reviewAccess, onReview }: {
  proposal: AutomationProposal;
  busy: boolean;
  reviewAccess: ControlTowerViewProps['reviewAccess'];
  onReview: ControlTowerViewProps['onReview'];
}) {
  const [rationale, setRationale] = useState('');
  return <article className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div><div className="flex items-center gap-2"><Badge variant="outline">{proposal.kind}</Badge><Badge variant="outline">{proposal.status}</Badge></div><h3 className="mt-2 font-medium">Automation froze a proposal and its undo state</h3><p className="mt-1 text-sm text-muted-foreground">Review fingerprint <code className="break-all">{proposal.confirmation_fingerprint}</code>. Approval does not execute it.</p></div>
    {proposal.status === 'proposed' && reviewAccess === 'allowed' && <div className="space-y-2"><Label htmlFor={`rationale-${proposal.id}`}>Review rationale</Label><Textarea id={`rationale-${proposal.id}`} value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Explain the evidence-backed operator decision" /><div className="flex gap-2"><Button disabled={busy || rationale.trim().length < 3} onClick={() => onReview(proposal.id, 'approve', proposal.confirmation_fingerprint, rationale.trim())}>Approve proposal</Button><Button variant="outline" disabled={busy || rationale.trim().length < 3} onClick={() => onReview(proposal.id, 'reject', proposal.confirmation_fingerprint, rationale.trim())}>Reject</Button></div></div>}
    {proposal.status === 'proposed' && reviewAccess !== 'allowed' && <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground" role="status">
      {reviewAccess === 'sign_in_required'
        ? 'API keys and MCP can inspect this frozen proposal but cannot approve or reject it. Sign in as a workspace owner or admin to review.'
        : 'This signed-in role can inspect the proposal but cannot review it. Ask a workspace owner or admin.'}
    </p>}
    {proposal.status !== 'proposed' && <p className="text-sm text-muted-foreground">
      Review recorded by {proposal.reviewed_by ?? 'an authenticated human user'}{proposal.reviewed_at ? ` at ${new Date(proposal.reviewed_at).toLocaleString()}` : ''}. No rollout was executed.
    </p>}
  </article>;
}

function DestinationForm({ disabled, onSubmit }: { disabled: boolean; onSubmit: ControlTowerViewProps['onCreateDestination'] }) {
  const [key, setKey] = useState(''); const [name, setName] = useState(''); const [kind, setKind] = useState<'in_product' | 'outbox'>('in_product');
  return <details><DisclosureSummary className="cursor-pointer text-sm font-medium">Add destination</DisclosureSummary><form className="mt-3 grid gap-3 sm:grid-cols-4" onSubmit={(event) => { event.preventDefault(); onSubmit({ key, name, kind }); }}><Input aria-label="Destination key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="owner_inbox" required /><Input aria-label="Destination name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Owner inbox" required /><select aria-label="Destination kind" className="h-9 rounded-md border bg-background px-3 text-sm" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="in_product">In product</option><option value="outbox">Outbox extension seam</option></select><Button type="submit" disabled={disabled}>Create destination</Button></form></details>;
}

function MonitorForm({ env, disabled, onSubmit }: { env: string; disabled: boolean; onSubmit: ControlTowerViewProps['onCreateMonitor'] }) {
  const [key, setKey] = useState(''); const [metric, setMetric] = useState(''); const [threshold, setThreshold] = useState('20');
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit({ policy_key: key, name: key.replaceAll('_', ' '), env, target_kind: 'project', target_id: null, metric_key: metric, comparison_rule: 'change_down_percent', threshold: Number(threshold), minimum_sample: 10, window_minutes: 1440, cadence_minutes: 60, cooldown_seconds: 3600, owner: 'project-owner', destination_ids: [], proposal_kind: null, proposal_target: null }); };
  return <details><DisclosureSummary className="cursor-pointer text-sm font-medium">Create monitor</DisclosureSummary><form className="mt-3 grid gap-3 sm:grid-cols-4" onSubmit={submit}><Input aria-label="Monitor key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="activation_drop" required /><Input aria-label="Monitor metric" value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="activation_completed" required /><Input aria-label="Monitor threshold" type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} required /><Button type="submit" disabled={disabled}>Create monitor</Button></form><p className="mt-2 text-xs text-muted-foreground">The compact form creates a project-level drop monitor with no delivery destination or automatic proposal. Revise through REST/MCP for release, experiment and frozen proposal targeting.</p></details>;
}

function ScheduleForm({ env, disabled, onSubmit }: { env: string; disabled: boolean; onSubmit: ControlTowerViewProps['onCreateSchedule'] }) {
  const [key, setKey] = useState(''); const [metric, setMetric] = useState(''); const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone); const [localTime, setLocalTime] = useState('09:00');
  return <details><DisclosureSummary className="cursor-pointer text-sm font-medium">Create scheduled feed</DisclosureSummary><form className="mt-3 grid gap-3 sm:grid-cols-5" onSubmit={(event) => { event.preventDefault(); onSubmit({ schedule_key: key, name: key.replaceAll('_', ' '), env, metric_key: metric, template_kind: 'metric_trend', window_days: 7, timezone, frequency: 'daily', local_time: localTime, weekday: null, destination_ids: [], owner: 'project-owner' }); }}><Input aria-label="Schedule key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="daily_activation" required /><Input aria-label="Schedule metric" value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="activation_completed" required /><Input aria-label="Schedule timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} required /><Input aria-label="Schedule local time" type="time" value={localTime} onChange={(e) => setLocalTime(e.target.value)} required /><Button type="submit" disabled={disabled}>Create feed</Button></form></details>;
}
