import { useEffect, useMemo, useRef, useState } from 'react';
import { Add, GridView, Loader2 } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, Stat, fmtNum } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DisclosureSummary } from '@/components/disclosure';
import { GuidedFirstValue } from '../components/guided-first-value';
import { EvidenceLine, KpiStrip, type EvidenceTrust } from '../components/analytics';
import type {
  ExperienceRoute,
  InteractionMapResponse,
  ExperienceSessionResponse,
  ExperienceSnapshot,
  ExperienceSurface,
  VisualExperienceCompareResponse,
  VisualExperienceResponse,
} from '../api/types';
import { ReplayPanel } from './ReplayPanel';

export function Experience() {
  const { client, project, env, availableEnvs, setEnv } = useStore();
  const configurationRef = useRef<HTMLDetailsElement>(null);
  const snapshotRef = useRef<HTMLDivElement>(null);
  const { data, error, loading, reload } = useAsync(
    () => Promise.all([
      client!.experienceSurfaces(project!, env),
      client!.experienceRoutes(project!),
      client!.experienceSnapshots(project!, { env }),
    ]).then(([surfaces, routes, snapshots]) => ({ surfaces, routes, snapshots })),
    [project, env],
  );

  if (loading) return <Loading what="assembling visual experience evidence…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!data) return null;

  const activeSurfaces = data.surfaces.filter((item) => item.status === 'active');
  const activeSurfaceKeys = new Set(activeSurfaces.map((item) => item.key));
  const setupReady = data.routes.some((item) => activeSurfaceKeys.has(item.surface_key));
  const experienceReady = deriveExperienceReadiness(data.surfaces, data.routes, data.snapshots).complete;
  const openManualSetup = () => {
    if (!configurationRef.current) return;
    configurationRef.current.open = true;
    configurationRef.current.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
  };
  const openSnapshotSetup = () => snapshotRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });

  return (
    <div className="space-y-4">
      <Panel
        title="Visual Experience"
        right={<span className="text-sm text-muted-foreground">aggregate maps · separate from DOM replay</span>}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm text-muted-foreground">
              Read clicks, scroll reach and named-section aggregate reach on the immutable page version that produced them.
              This lower-sensitivity collector stores only consented coordinates and developer labels — never DOM,
              text, form values, query strings or pointer paths. Session Replay is a separate explicit opt-in below.
            </p>
          </div>
          <Field label="Environment">
            <Select value={env} onValueChange={setEnv}>
              <SelectTrigger className="h-9 min-w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{availableEnvs.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      </Panel>

      <ReplayPanel />

      {!experienceReady && (
        <ExperienceSetupGate
          project={project!}
          env={env}
          surfaces={data.surfaces}
          routes={data.routes}
          snapshots={data.snapshots}
          onManualSetup={openManualSetup}
          onSnapshotSetup={openSnapshotSetup}
        />
      )}

      {setupReady && data.snapshots.length > 0 ? (
          <VisualExplorer
            surfaces={data.surfaces}
            routes={data.routes}
            snapshots={data.snapshots}
            env={env}
          />
        ) : null}

      {setupReady && (
        <div ref={snapshotRef} className="scroll-mt-4">
          <SnapshotSetup
            surfaces={activeSurfaces}
            routes={data.routes}
            env={env}
            onChanged={reload}
          />
        </div>
      )}

      {setupReady && <AggregateClickEvidence surfaces={activeSurfaces} env={env} />}

      <details ref={configurationRef} className="group scroll-mt-4">
        <DisclosureSummary className="cursor-pointer rounded-md border bg-card px-5 py-4 text-sm font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
          Capture configuration and session details
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {data.surfaces.length} surfaces · {data.routes.length} routes
          </span>
        </DisclosureSummary>
        <div className="mt-4 space-y-4">
          <SurfaceForm onCreated={reload} />
          {activeSurfaces.length > 0 && <RouteForm surfaces={activeSurfaces} onCreated={reload} />}
          {data.surfaces.length > 0 && <SurfacesTable surfaces={data.surfaces} routes={data.routes} onChanged={reload} />}
          {activeSurfaces.length > 0 && <SessionTimeline surfaces={activeSurfaces} env={env} />}
        </div>
      </details>
    </div>
  );
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function ExperienceSetupGate({
  project,
  env,
  surfaces,
  routes,
  snapshots,
  onManualSetup,
  onSnapshotSetup,
}: {
  project: string;
  env: string;
  surfaces: ExperienceSurface[];
  routes: ExperienceRoute[];
  snapshots: ExperienceSnapshot[];
  onManualSetup: () => void;
  onSnapshotSetup: () => void;
}) {
  const readiness = deriveExperienceReadiness(surfaces, routes, snapshots);
  const { anchor, activeCount, hasRoute, hasCapture, hasSnapshot } = readiness;
  const task = experienceSetupTask(project, env, surfaces);
  return <GuidedFirstValue
    title={hasRoute ? 'Complete aggregate friction readiness' : 'Set up Browser Experience'}
    outcome="Build a privacy-safe friction readout from accepted aggregate clicks, scroll reach, and stable developer labels. This Browser Experience collector never captures DOM, page text, form values or pointer paths; Session Replay is a separate explicit opt-in."
    checks={[
      {
        label: 'Purposeful active surface',
        ready: Boolean(anchor),
        detail: anchor ? `${anchor.surface.name} is the most complete of ${activeCount} active ${activeCount === 1 ? 'surface' : 'surfaces'}. Remaining checks stay bound to this surface.` : 'Declare which UX decision this aggregate evidence should inform.',
      },
      {
        label: 'Finite canonical routes',
        ready: hasRoute,
        detail: hasRoute ? `${anchor!.routes.length} safe route ${anchor!.routes.length === 1 ? 'key is' : 'keys are'} registered for ${anchor!.surface.name}.` : 'Register stable route keys on this surface; raw URLs and query strings are not accepted evidence.',
      },
      {
        label: 'Accepted aggregate capture',
        ready: hasCapture,
        detail: hasCapture ? `The server has accepted Browser Experience evidence for ${anchor!.surface.name} in this environment.` : 'Instrument one route on this surface and verify a server-accepted click, scroll, or section event.',
      },
      {
        label: 'Immutable deploy snapshot',
        ready: hasSnapshot,
        detail: hasSnapshot ? `${anchor!.snapshots.length} ${anchor!.snapshots.length === 1 ? 'snapshot anchors' : 'snapshots anchor'} a registered ${anchor!.surface.name} route to a page version.` : 'Upload the exact PNG or WebP for a registered route on this surface so Poolstatis does not guess the visual background.',
      },
    ]}
    action={hasRoute
      ? <Button onClick={hasSnapshot ? onManualSetup : onSnapshotSetup}>{hasSnapshot ? 'Review capture setup' : 'Add deploy snapshot'}</Button>
      : <Button onClick={onManualSetup}>Set up manually</Button>}
    agentTask={task}
    referenceTitle="First real friction readout"
    referenceItems={[
      'Accepted sessions and actors for one route/version/device',
      'Labelled click concentration without element text',
      'Named-section reach and aggregate drop-off',
      'Snapshot freshness, caveats, and non-causal interpretation',
    ]}
    referenceSource={{
      label: 'Visual Experience Maps v1 evidence model',
      href: 'https://github.com/lim5max/poolstatis/blob/main/docs/10-visual-experience-maps.md#evidence-model',
    }}
  />;
}

function deriveExperienceReadiness(
  surfaces: ExperienceSurface[],
  routes: ExperienceRoute[],
  snapshots: ExperienceSnapshot[],
) {
  const candidates = surfaces
    .filter((surface) => surface.status === 'active')
    .map((surface) => {
      const surfaceRoutes = routes.filter((route) => route.surface_key === surface.key);
      const routeKeys = new Set(surfaceRoutes.map((route) => route.key));
      const surfaceSnapshots = snapshots.filter((snapshot) => (
        snapshot.surface_key === surface.key && routeKeys.has(snapshot.route_key)
      ));
      const score = Number(surfaceRoutes.length > 0)
        + Number(Boolean(surface.last_capture_at))
        + Number(surfaceSnapshots.length > 0);
      return { surface, routes: surfaceRoutes, snapshots: surfaceSnapshots, score };
    })
    .sort((left, right) => right.score - left.score
      || new Date(right.surface.updated_at).getTime() - new Date(left.surface.updated_at).getTime());
  const anchor = candidates[0];
  const hasRoute = Boolean(anchor && anchor.routes.length > 0);
  const hasCapture = Boolean(anchor?.surface.last_capture_at);
  const hasSnapshot = Boolean(anchor && anchor.snapshots.length > 0);
  return {
    anchor,
    activeCount: candidates.length,
    hasRoute,
    hasCapture,
    hasSnapshot,
    complete: Boolean(anchor && hasRoute && hasCapture && hasSnapshot),
  };
}

function experienceSetupTask(project: string, env: string, surfaces: ExperienceSurface[]): string {
  const knownSurfaces = surfaces.length === 0
    ? 'No Browser Experience surfaces exist yet.'
    : `Existing surfaces: ${surfaces.map((item) => `${item.key} (${item.status})`).join(', ')}.`;

  return `Set up Poolstatis Browser Experience for project "${project}" in environment "${env}".

${knownSurfaces}

1. Inspect this codebase and identify one user-facing browser surface plus a small, finite set of canonical routes. Every surface purpose must name the UX decision its evidence will inform.
2. Use the installed Poolstatis MCP tools. Read existing state first, then use create_experience_surface and register_experience_route as needed. Do not delete, archive, rename, or overwrite existing surfaces, routes, events, or project data. If every existing surface is archived, create a fresh active surface with a new stable key.
3. Reuse the Poolstatis client and SDK version already compatible with this project. Add BrowserExperience from @poolstatis/sdk/experience only where browser code runs. Do not upgrade the SDK unless compatibility with the existing ingest contract is verified.
4. Keep the product key in the local environment where it is already saved. Do not ask me to paste or expose any key in chat, source code, logs, screenshots, or git.
5. Through BrowserExperience, capture only normalized coordinates and stable developer labels such as data-poolstatis-label and data-poolstatis-section. Never capture DOM, text, form values, raw URLs, query strings or pointer paths through this collector. Session Replay is a separate consent- and exact-host-gated module and is not part of this setup task.
6. Upload the exact deploy PNG or WebP with its stable route, version, device, viewport and release hash through the Poolstatis admin or Platform API. Never substitute a snapshot from another release.
7. Run the relevant tests and build, open one real route in "${env}", and verify that Poolstatis accepted a real Browser Experience event. Read the surface, route, capture recency and snapshot metadata back from the server. Report the files changed and the server-side verification. Do not call the setup complete from a local mock alone.`;
}

function VisualExplorer({
  surfaces,
  routes,
  snapshots,
  env,
}: {
  surfaces: ExperienceSurface[];
  routes: ExperienceRoute[];
  snapshots: ExperienceSnapshot[];
  env: string;
}) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState(snapshots[0]?.surface_key ?? '');
  const surfaceSnapshots = useMemo(
    () => snapshots.filter((item) => item.surface_key === surface),
    [snapshots, surface],
  );
  const [route, setRoute] = useState(surfaceSnapshots[0]?.route_key ?? '');
  const routeSnapshots = useMemo(
    () => surfaceSnapshots.filter((item) => item.route_key === route),
    [surfaceSnapshots, route],
  );
  const [version, setVersion] = useState(routeSnapshots[0]?.version ?? '');
  const [device, setDevice] = useState<'desktop' | 'mobile'>(routeSnapshots[0]?.device ?? 'desktop');
  const [period, setPeriod] = useState('-30d');
  const [mode, setMode] = useState<'clicks' | 'scroll'>('clicks');
  const [result, setResult] = useState<VisualExperienceResponse | null>(null);
  const [comparison, setComparison] = useState<VisualExperienceCompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [compareBusy, setCompareBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRequestRef = useRef(0);
  const compareRequestRef = useRef(0);

  const versions = [...new Set(routeSnapshots.map((item) => item.version))];
  const devices = [...new Set(routeSnapshots.filter((item) => item.version === version).map((item) => item.device))];
  const routeOptions = routes.filter((item) => item.surface_key === surface);
  const comparisonTarget = routeSnapshots.find((item) => item.version === version && item.device !== device)
    ?? routeSnapshots.find((item) => item.version !== version);
  const evidenceIdentity = `${surface}\u0000${route}\u0000${version}\u0000${device}\u0000${period}\u0000${env}`;
  const evidenceIdentityRef = useRef(evidenceIdentity);
  evidenceIdentityRef.current = evidenceIdentity;

  useEffect(() => {
    const next = snapshots.find((item) => item.surface_key === surface);
    if (next && !surfaceSnapshots.some((item) => item.route_key === route)) {
      setRoute(next.route_key);
      setVersion(next.version);
      setDevice(next.device);
    }
  }, [route, snapshots, surface, surfaceSnapshots]);

  useEffect(() => {
    const next = routeSnapshots[0];
    if (next && !versions.includes(version)) {
      setVersion(next.version);
      setDevice(next.device);
    }
  }, [routeSnapshots, version, versions]);

  useEffect(() => {
    const next = routeSnapshots.find((item) => item.version === version);
    if (next && !devices.includes(device)) setDevice(next.device);
  }, [device, devices, routeSnapshots, version]);

  const load = async () => {
    if (!surface || !route || !version) return;
    const requestId = ++loadRequestRef.current;
    const requestIdentity = evidenceIdentity;
    ++compareRequestRef.current;
    setBusy(true);
    setCompareBusy(false);
    setError(null);
    setComparison(null);
    try {
      const nextResult = await client!.visualExperience(project!, {
        surface,
        route,
        version,
        device,
        date_from: period,
        env,
        grid: 24,
      });
      if (loadRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setResult(nextResult);
      }
    } catch (caught) {
      if (loadRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setError(caught instanceof Error ? caught.message : 'Could not load visual evidence.');
        setResult(null);
      }
    } finally {
      if (loadRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    void load();
    return () => {
      ++loadRequestRef.current;
      ++compareRequestRef.current;
    };
    // The selected evidence tuple is the request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, route, version, device, period, env]);

  const compare = async () => {
    if (!comparisonTarget) return;
    const requestId = ++compareRequestRef.current;
    const requestIdentity = evidenceIdentity;
    setCompareBusy(true);
    setError(null);
    try {
      const nextComparison = await client!.compareVisualExperience(project!, {
        surface,
        route,
        env,
        grid: 24,
        baseline: { version, device, date_from: period },
        comparison: {
          version: comparisonTarget.version,
          device: comparisonTarget.device,
          date_from: period,
        },
      });
      if (compareRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setComparison(nextComparison);
      }
    } catch (caught) {
      if (compareRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setError(caught instanceof Error ? caught.message : 'Could not compare visual evidence.');
      }
    } finally {
      if (compareRequestRef.current === requestId && evidenceIdentityRef.current === requestIdentity) {
        setCompareBusy(false);
      }
    }
  };

  return (
    <>
      <ExperienceFrictionAnswer result={result} comparison={comparison} busy={busy} error={error} env={env} />
      {comparison && <ComparisonStrip comparison={comparison} />}
      <div id="visual-experience-map" className="scroll-mt-4">
        <Panel
          title="Page evidence"
          right={result?.snapshot?.stale
            ? <span className="text-sm text-amber-700">Snapshot may be stale</span>
            : <span className="text-sm text-muted-foreground">Exact version + layout</span>}
        >
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        <Filter label="Surface">
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{surfaces.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Filter>
        <Filter label="Page / route">
          <Select value={route} onValueChange={setRoute}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{routeOptions.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Filter>
        <Filter label="Version">
          <Select value={version} onValueChange={setVersion}>
            <SelectTrigger className="h-9 w-full font-mono text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>{versions.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
          </Select>
        </Filter>
        <Filter label="Device">
          <Select value={device} onValueChange={(value) => setDevice(value as 'desktop' | 'mobile')}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{devices.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
          </Select>
        </Filter>
        <Filter label="Period">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="-7d">Last 7 days</SelectItem>
              <SelectItem value="-30d">Last 30 days</SelectItem>
              <SelectItem value="-90d">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </Filter>
          </div>

          <div className="mt-3 flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {comparisonTarget
            ? (
              <>
                Current: {device} · Comparison: {comparisonTarget.device}
                {comparisonTarget.version === version ? ' on the same version' : ` on ${comparisonTarget.version}`}
              </>
            )
            : 'Add another device or version snapshot to compare layouts.'}
        </p>
        <Button variant="outline" onClick={compare} disabled={compareBusy || !comparisonTarget}>
          {compareBusy ? <Loader2 className="size-4 animate-spin" /> : <GridView className="size-4" />}
          {comparisonTarget?.version === version
            ? `Compare with ${comparisonTarget.device}`
            : comparisonTarget
              ? 'Compare versions'
              : 'Compare unavailable'}
        </Button>
          </div>

          <div className="mt-3">
        <Tabs value={mode} onValueChange={(value) => setMode(value as 'clicks' | 'scroll')}>
          <TabsList>
            <TabsTrigger value="clicks">Click intensity</TabsTrigger>
            <TabsTrigger value="scroll">Scroll reach</TabsTrigger>
          </TabsList>
        </Tabs>
          </div>

          {busy && <div className="mt-4"><Loading what="aligning events to the snapshot…" /></div>}
          {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
          {!busy && result && <VisualResult result={result} mode={mode} />}
        </Panel>
      </div>
    </>
  );
}

function ExperienceFrictionAnswer({
  result,
  comparison,
  busy,
  error,
  env,
}: {
  result: VisualExperienceResponse | null;
  comparison: VisualExperienceCompareResponse | null;
  busy: boolean;
  error: string | null;
  env: string;
}) {
  if (busy) {
    return (
      <section aria-label="Aggregate friction answer">
        <Panel title="Aggregate friction answer" right={<Badge variant="outline">Reading evidence</Badge>}>
          <Loading what="deriving the aggregate friction answer…" />
        </Panel>
      </section>
    );
  }
  if (error || !result) {
    return (
      <section aria-label="Aggregate friction answer">
        <Panel title="Aggregate friction answer" right={<Badge variant="outline">Evidence unavailable</Badge>}>
          <p className="text-sm text-muted-foreground">
            {error ?? 'No server evidence is available for this exact surface, route, version, device, and period.'}
          </p>
        </Panel>
      </section>
    );
  }

  const context = result.agent_context;
  const decrease = context.largest_section_reach_decreases[0];
  const comparisonChange = comparison?.agent_context.largest_section_changes[0];
  const trust = experienceEvidenceTrust(result);
  const trustLabel = trust === 'trusted'
    ? 'Trusted evidence'
    : trust === 'partial'
      ? 'Partial evidence'
      : 'Evidence unavailable';
  const readiness = trust === 'trusted'
    ? 'Evidence ready'
    : trust === 'partial'
      ? 'Review caveats'
      : 'No evidence';
  const takeaway = context.data_quality.status === 'empty'
    ? 'No accepted aggregate experience events match this exact evidence cohort.'
    : decrease
      ? `The largest observed adjacent reach decrease is ${decrease.from_section} → ${decrease.to_section}: ${decrease.session_count_decrease} fewer sessions (${decrease.percentage_point_decrease} pp).`
      : 'No adjacent section reach decrease is available in this bounded cohort.';

  return (
    <section aria-label="Aggregate friction answer">
      <Panel title="Aggregate friction answer" right={<Badge variant={trust === 'trusted' ? 'default' : 'outline'}>{trustLabel}</Badge>}>
        <p className="max-w-3xl text-lg font-semibold leading-snug">{takeaway}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Purpose: <span className="text-foreground">{context.scope.purpose}</span>
        </p>
        {comparisonChange && (
          <p className="mt-2 text-sm text-muted-foreground">
            Explicit cohort delta: <code>{comparisonChange.section}</code>{' '}
            {signed(comparisonChange.percentage_points)} pp from {comparisonChange.baseline_percentage}% to {comparisonChange.comparison_percentage}%.
          </p>
        )}
        <div className="mt-4">
          <KpiStrip items={[
            {
              label: 'Adjacent reach delta',
              value: decrease ? `−${decrease.percentage_point_decrease} pp` : null,
              fallback: 'Not available',
              note: decrease ? `${decrease.from_section} → ${decrease.to_section}` : 'No ordered section decrease returned',
            },
            { label: 'Sessions', value: context.sample_size.sessions, note: 'Exact selected cohort' },
            { label: 'Actors', value: context.sample_size.actors, note: 'Aggregate distinct actors' },
            {
              label: 'Readiness',
              value: readiness,
              note: `${context.data_quality.status} quality · ${context.snapshot_coverage.status} snapshot`,
            },
          ]} />
        </div>
        <EvidenceLine trust={trust} eventCount={context.sample_size.events} env={env} className="mt-3">
          <p>
            Scope: <code>{context.scope.surface}</code> · <code>{context.scope.route}</code> ·{' '}
            <code>{context.scope.version}</code> · {context.scope.device}. Computed {result.meta.computed_at} for{' '}
            {result.meta.date_range.from} through {result.meta.date_range.to}.
          </p>
          <p className="mt-1">
            Snapshot: {context.snapshot_coverage.status}; viewport {context.snapshot_coverage.exact_viewport_match ? 'matched exactly' : 'not matched exactly'}.
          </p>
          {context.data_quality.caveats.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {context.data_quality.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
            </ul>
          )}
          <p className="mt-1">{result.causality}</p>
        </EvidenceLine>
      </Panel>
    </section>
  );
}

function experienceEvidenceTrust(result: VisualExperienceResponse): EvidenceTrust {
  const { data_quality: quality, snapshot_coverage: snapshot } = result.agent_context;
  if (quality.status === 'empty' || result.agent_context.sample_size.events === 0) return 'unavailable';
  return quality.status === 'ok' && snapshot.status === 'fresh' && snapshot.exact_viewport_match
    ? 'trusted'
    : 'partial';
}

function VisualResult({ result, mode }: { result: VisualExperienceResponse; mode: 'clicks' | 'scroll' }) {
  const { client, project } = useStore();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setImageUrl(null);
    setImageError(null);
    if (!result.snapshot) return;
    void client!.experienceSnapshotImage(project!, result.snapshot.id).then((url) => {
      objectUrl = url;
      if (active) setImageUrl(url);
    }).catch((caught) => {
      if (active) setImageError(caught instanceof Error ? caught.message : 'Snapshot could not be read.');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, project, result.snapshot]);

  if (!result.snapshot) {
    return (
      <div className="mt-4 rounded-md border border-dashed p-8 text-center">
        <div className="serif text-xl">Events exist without a matching page version</div>
        <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
          Upload the exact {result.device} snapshot for <code>{result.route}</code> at version{' '}
          <code>{result.version}</code>. Poolstatis will not guess a background from another release.
        </p>
      </div>
    );
  }

  const hasSignals = result.summary.events > 0;
  const maxClick = Math.max(1, ...result.click_cells.map((cell) => cell.count));

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Sessions" value={result.summary.sessions} sub={`${result.summary.actors} actors`} />
        <Stat label="Clicks" value={result.summary.clicks} sub={`${result.click_labels.length} labelled targets`} />
        <Stat label="Reached 50%" value={`${coverageAt(result, 50)}%`} sub="of page-view sessions" />
        <Stat label="Last section" value={`${result.sections.at(-1)?.percentage ?? 0}%`} sub={result.sections.at(-1)?.section ?? 'No section evidence'} />
      </div>

      <div className="overflow-hidden rounded-md border bg-muted/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">
            {result.device === 'mobile' ? 'Mobile' : 'Desktop'} viewport · {result.snapshot.viewport_width} × {result.snapshot.viewport_height}
          </span>
          <span>
            full page {result.snapshot.document_width} × {result.snapshot.document_height} · <code>{result.snapshot.release_hash}</code>
          </span>
        </div>
        {imageError && <div className="p-5"><ErrorNote>{imageError}</ErrorNote></div>}
        {!imageUrl && !imageError && <Loading what="loading immutable snapshot…" />}
        {imageUrl && (
          <div
            data-testid="visual-snapshot-viewport"
            className="h-96 overflow-auto overscroll-contain bg-muted p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            role="region"
            tabIndex={0}
            aria-label={`Scrollable ${result.device} page snapshot`}
          >
            <div
              data-testid="visual-snapshot-canvas"
              className="relative mx-auto bg-background shadow-sm"
              style={{ width: `min(100%, ${result.snapshot.viewport_width}px)` }}
            >
              <img
                src={imageUrl}
                alt={`${result.surface.name}, ${result.route}, ${result.version}, ${result.device}`}
                className="block h-auto w-full"
              />
              {mode === 'clicks'
                ? result.click_cells.map((cell) => {
                    const intensity = Math.max(0.25, cell.count / maxClick);
                    return (
                      <span
                        key={`${cell.x}:${cell.y}`}
                        className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-red-500 shadow-sm"
                        style={{
                          left: `${((cell.x + 0.5) / result.grid) * 100}%`,
                          top: `${((cell.y + 0.5) / result.grid) * 100}%`,
                          opacity: intensity,
                          transform: `translate(-50%, -50%) scale(${0.75 + intensity})`,
                        }}
                        title={`${cell.count} clicks · ${cell.actors} actors`}
                      />
                    );
                  })
                : result.scroll_coverage.map((bucket, index) => {
                    const previous = index === 0 ? 0 : result.scroll_coverage[index - 1]!.depth;
                    return (
                      <span
                        key={bucket.depth}
                        className="pointer-events-none absolute inset-x-0 bg-amber-400"
                        style={{
                          top: `${previous}%`,
                          height: `${bucket.depth - previous}%`,
                          opacity: 0.08 + bucket.percentage / 250,
                        }}
                        title={`${bucket.percentage}% reached ${bucket.depth}%`}
                      />
                    );
                  })}
              {result.sections.map((section) => (
                <span
                  key={section.section}
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-foreground/60"
                  style={{ top: `${section.top * 100}%` }}
                >
                  <span className="absolute left-2 top-1 rounded-sm bg-background/90 px-1.5 py-0.5 font-mono text-sm">
                    {section.section} · {section.percentage}%
                  </span>
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>

      <div data-testid="visual-evidence-notes" className="grid gap-3 rounded-md border bg-muted/20 p-4 md:grid-cols-2">
        <div className="min-w-0">
          <div>
            <div className="mb-2 text-sm font-medium text-muted-foreground">Labelled targets</div>
            {!hasSignals
              ? <p className="text-sm text-muted-foreground">No accepted signals match this exact version and device.</p>
              : (
                <div className="flex flex-wrap gap-2">
                  {result.click_labels.map((item) => (
                    <span key={item.label} className="inline-flex max-w-full items-center gap-2 rounded-md border bg-background px-2 py-1 text-sm">
                      <code className="truncate">{item.label}</code>
                      <span className="shrink-0 tabular-nums text-muted-foreground">{item.count} · {item.actors}</span>
                    </span>
                  ))}
                </div>
              )}
          </div>
        </div>
        <details className="rounded-md border bg-background px-3 py-2">
          <DisclosureSummary className="inline-flex cursor-pointer items-center text-sm font-medium">How to read this evidence</DisclosureSummary>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{result.causality}</p>
        </details>
      </div>

      <SectionDropoff sections={result.sections} total={result.summary.sessions} />
    </div>
  );
}

function SectionDropoff({ sections, total }: { sections: VisualExperienceResponse['sections']; total: number }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm font-medium">Section drop-off</div>
        <div className="text-sm text-muted-foreground">Denominator: {total} page-view sessions</div>
      </div>
      {sections.length === 0
        ? <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">No named section exposure yet. Add <code>data-poolstatis-section</code> to real blocks.</div>
        : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Section</TableHead>
                  <TableHead>Sessions</TableHead>
                  <TableHead>Actors</TableHead>
                  <TableHead>Reach</TableHead>
                  <TableHead>Drop-off</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sections.map((section) => (
                  <TableRow key={section.section}>
                    <TableCell><code className="text-sm">{section.section}</code></TableCell>
                    <TableCell className="tabular-nums">{section.sessions}</TableCell>
                    <TableCell className="tabular-nums">{section.actors}</TableCell>
                    <TableCell className="tabular-nums">{section.percentage}%</TableCell>
                    <TableCell className="tabular-nums">{section.dropoff_percentage}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
    </div>
  );
}

function ComparisonStrip({ comparison }: { comparison: VisualExperienceCompareResponse }) {
  const target = `${comparison.comparison.version} · ${comparison.comparison.device}`;
  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Compared with {target}</div>
          <p className="mt-1 text-sm text-muted-foreground">{comparison.causality}</p>
        </div>
        <div className="flex gap-4 font-mono text-sm">
          <span>sessions {signed(comparison.delta.sessions)}</span>
          <span>clicks {signed(comparison.delta.clicks)}</span>
          <span>actors {signed(comparison.delta.actors)}</span>
        </div>
      </div>
      {comparison.delta.sections.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {comparison.delta.sections.map((section) => (
            <span key={section.section} className="rounded-md border bg-background px-2 py-1 font-mono text-sm">
              {section.section}{' '}
              {section.percentage_points === null
                ? 'taxonomy mismatch'
                : `${signed(section.percentage_points)} pp`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SnapshotSetup({
  surfaces,
  routes,
  env,
  onChanged,
}: {
  surfaces: ExperienceSurface[];
  routes: ExperienceRoute[];
  env: string;
  onChanged: () => void;
}) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState(surfaces[0]?.key ?? '');
  const availableRoutes = routes.filter((item) => item.surface_key === surface);
  const [route, setRoute] = useState(availableRoutes[0]?.key ?? '');
  const [version, setVersion] = useState('');
  const [releaseHash, setReleaseHash] = useState('');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [viewportWidth, setViewportWidth] = useState('1440');
  const [viewportHeight, setViewportHeight] = useState('900');
  const [documentWidth, setDocumentWidth] = useState('1440');
  const [documentHeight, setDocumentHeight] = useState('2880');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = routes.find((item) => item.surface_key === surface);
    if (next && !availableRoutes.some((item) => item.key === route)) setRoute(next.key);
  }, [availableRoutes, route, routes, surface]);

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await client!.uploadExperienceSnapshot(project!, {
        surface,
        route,
        version: version.trim(),
        device,
        env,
        release_hash: releaseHash.trim(),
        viewport_width: Number(viewportWidth),
        viewport_height: Number(viewportHeight),
        document_width: Number(documentWidth),
        document_height: Number(documentHeight),
        captured_at: new Date().toISOString(),
        retention_days: 90,
      }, file);
      setFile(null);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload snapshot.');
    } finally {
      setBusy(false);
    }
  };

  const valid = Boolean(
    surface && route && file && /^(image\/png|image\/webp)$/.test(file.type)
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version.trim())
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(releaseHash.trim())
    && Number(viewportWidth) >= 240 && Number(viewportHeight) >= 240
    && Number(documentWidth) >= 1 && Number(documentHeight) >= 1,
  );

  return (
    <Panel title="Add a deploy snapshot" right={<span className="text-sm text-muted-foreground">PNG / WebP · 5 MB max · 90 days</span>}>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Surface">
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{surfaces.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Route">
          <Select value={route} onValueChange={setRoute}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>{availableRoutes.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Version"><Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="2026.07.27-abc123" /></Field>
        <Field label="Release hash"><Input value={releaseHash} onChange={(event) => setReleaseHash(event.target.value)} placeholder="abc123" /></Field>
        <Field label="Device">
          <Select value={device} onValueChange={(value) => setDevice(value as 'desktop' | 'mobile')}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="desktop">Desktop</SelectItem><SelectItem value="mobile">Mobile</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Viewport width"><Input inputMode="numeric" value={viewportWidth} onChange={(event) => setViewportWidth(event.target.value)} /></Field>
        <Field label="Viewport height"><Input inputMode="numeric" value={viewportHeight} onChange={(event) => setViewportHeight(event.target.value)} /></Field>
        <Field label="Document width"><Input inputMode="numeric" value={documentWidth} onChange={(event) => setDocumentWidth(event.target.value)} /></Field>
        <Field label="Document height"><Input inputMode="numeric" value={documentHeight} onChange={(event) => setDocumentHeight(event.target.value)} /></Field>
        <Field label="Snapshot file">
          <Input
            type="file"
            accept="image/png,image/webp"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={upload} disabled={!valid || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}
          Upload immutable snapshot
        </Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function SurfaceForm({ onCreated }: { onCreated: () => void }) {
  const { client, project } = useStore();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [routePattern, setRoutePattern] = useState('/');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9_]*$/.test(key.trim())
    && name.trim().length > 0
    && /^\/[^?#]*$/.test(routePattern)
    && purpose.trim().length >= 10;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await client!.createExperienceSurface(project!, {
        key: key.trim(),
        name: name.trim(),
        purpose: purpose.trim(),
        route_pattern: routePattern.trim(),
      });
      setKey('');
      setName('');
      setRoutePattern('/');
      setPurpose('');
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create experience surface.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="New capture surface">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Key"><Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="marketing" /></Field>
        <Field label="Name"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Marketing site" /></Field>
        <Field label="Canonical route pattern" className="md:col-span-2">
          <Input value={routePattern} onChange={(event) => setRoutePattern(event.target.value)} placeholder="/docs/*" />
        </Field>
        <Field label="Purpose" className="md:col-span-2">
          <textarea
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Find which landing sections lose qualified visitors."
            className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={submit} disabled={!valid || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}
          Create surface
        </Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function RouteForm({
  surfaces,
  onCreated,
}: {
  surfaces: ExperienceSurface[];
  onCreated: () => void;
}) {
  const { client, project } = useStore();
  const activeSurfaces = surfaces.filter((item) => item.status === 'active');
  const [surface, setSurface] = useState(activeSurfaces[0]?.key ?? '');
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [pathPattern, setPathPattern] = useState('/');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!activeSurfaces.some((item) => item.key === surface)) {
      setSurface(activeSurfaces[0]?.key ?? '');
    }
  }, [activeSurfaces, surface]);
  const valid = Boolean(surface)
    && /^[a-z][a-z0-9_]*$/.test(key.trim())
    && name.trim().length > 0
    && /^\/[^?#]*$/.test(pathPattern.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await client!.registerExperienceRoute(project!, surface, {
        key: key.trim(),
        name: name.trim(),
        path_pattern: pathPattern.trim(),
      });
      setKey('');
      setName('');
      setPathPattern('/');
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register route.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Add route to a surface">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Surface">
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {activeSurfaces.map((item) => (
                <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Route key">
          <Input value={key} onChange={(event) => setKey(event.target.value)} placeholder="docs" />
        </Field>
        <Field label="Route name">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Documentation" />
        </Field>
        <Field label="Canonical path pattern">
          <Input value={pathPattern} onChange={(event) => setPathPattern(event.target.value)} placeholder="/docs/*" />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={submit} disabled={!valid || busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Add className="size-4" />}
          Add route
        </Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function SurfacesTable({
  surfaces,
  routes,
  onChanged,
}: {
  surfaces: ExperienceSurface[];
  routes: ExperienceRoute[];
  onChanged: () => void;
}) {
  const { client, project } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const archive = async (key: string) => {
    setBusy(key);
    setError(null);
    try {
      await client!.archiveExperienceSurface(project!, key);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not archive surface.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel title="Capture registry">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Surface</TableHead><TableHead>Routes</TableHead><TableHead>Purpose</TableHead><TableHead>Capture status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {surfaces.map((surface) => (
              <TableRow key={surface.id}>
                <TableCell><div className="font-medium">{surface.name}</div><code className="text-sm text-muted-foreground">{surface.key}</code></TableCell>
                <TableCell>{routes.filter((item) => item.surface_key === surface.key).map((item) => <div key={item.id} className="text-sm"><code>{item.key}</code> · {item.path_pattern}</div>)}</TableCell>
                <TableCell className="max-w-lg text-sm text-muted-foreground">{surface.purpose}</TableCell>
                <TableCell className="text-sm">
                  <div>{surface.status}</div>
                  <div className="mt-1 whitespace-nowrap text-muted-foreground">
                    {surface.last_capture_at
                      ? `Last accepted capture ${formatDate(surface.last_capture_at)}`
                      : 'No accepted capture yet'}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-2">
                    <Button variant="link" size="sm" asChild><a href="#experience-evidence">View click details</a></Button>
                    {surface.status === 'active' && <Button variant="outline" size="sm" disabled={busy === surface.key} onClick={() => archive(surface.key)}>Archive</Button>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Panel>
  );
}

function AggregateClickEvidence({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState(surfaces[0]?.key ?? '');
  const [period, setPeriod] = useState('7');
  const [grid, setGrid] = useState('16');
  const [result, setResult] = useState<InteractionMapResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!surfaces.some((item) => item.key === surface)) setSurface(surfaces[0]?.key ?? '');
  }, [surface, surfaces]);

  const reset = () => {
    setResult(null);
    setError(null);
  };
  const load = async () => {
    if (!surface) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client!.interactionMap(project!, {
        surface,
        date_from: `-${period}d`,
        env,
        grid: Number(grid),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load aggregate click details.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const max = Math.max(1, ...(result?.cells.map((cell) => cell.count) ?? []));
  const cells = new Map(result?.cells.map((cell) => [`${cell.x}:${cell.y}`, cell]) ?? []);

  return (
    <div id="experience-evidence" className="scroll-mt-4">
      <Panel
        title="Aggregate click details"
        right={<span className="text-sm text-muted-foreground">snapshot optional · accepted events only</span>}
      >
        <p className="mb-3 text-sm text-muted-foreground">
          This normalized grid remains available before a deploy snapshot exists. Use the versioned map above for layout-accurate decisions.
        </p>
        <div className="flex flex-wrap gap-2">
          <Select value={surface} onValueChange={(value) => { setSurface(value); reset(); }} disabled={surfaces.length === 0}>
            <SelectTrigger aria-label="Aggregate click surface" className="h-9 min-w-44"><SelectValue placeholder="Choose surface" /></SelectTrigger>
            <SelectContent>{surfaces.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={period} onValueChange={(value) => { setPeriod(value); reset(); }}>
            <SelectTrigger aria-label="Aggregate click period" className="h-9 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{['7', '30', '90'].map((days) => <SelectItem key={days} value={days}>{days} days</SelectItem>)}</SelectContent>
          </Select>
          <Select value={grid} onValueChange={(value) => { setGrid(value); reset(); }}>
            <SelectTrigger aria-label="Aggregate click grid" className="h-9 w-24"><SelectValue /></SelectTrigger>
            <SelectContent>{['8', '16', '32'].map((value) => <SelectItem key={value} value={value}>{value} × {value}</SelectItem>)}</SelectContent>
          </Select>
          <Button onClick={load} disabled={!surface || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <GridView className="size-4" />}
            Load aggregate clicks
          </Button>
        </div>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
        {result && result.cells.length === 0 && result.labels.length === 0 && (
          <div className="mt-4"><EmptyState headline="No captured clicks" lead={`No accepted labelled click events in the last ${period} days.`} /></div>
        )}
        {result && (result.cells.length > 0 || result.labels.length > 0) && (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div
              role="img"
              aria-label={`${result.cells.reduce((sum, cell) => sum + cell.count, 0)} accepted clicks across ${result.cells.length} occupied grid cells.`}
              className="grid gap-0.5 rounded-md border bg-muted/20 p-3"
              style={{ gridTemplateColumns: `repeat(${result.grid}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: result.grid * result.grid }, (_, index) => {
                const x = index % result.grid;
                const y = Math.floor(index / result.grid);
                const cell = cells.get(`${x}:${y}`);
                return (
                  <div
                    key={`${x}:${y}`}
                    aria-hidden="true"
                    className="aspect-square rounded-sm bg-primary"
                    style={{ opacity: cell ? Math.max(0.15, cell.count / max) : 0.04 }}
                  />
                );
              })}
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Label</TableHead><TableHead>Clicks</TableHead><TableHead>Actors</TableHead></TableRow></TableHeader>
                <TableBody>{result.labels.map((label) => (
                  <TableRow key={label.label}>
                    <TableCell><code className="text-sm">{label.label}</code></TableCell>
                    <TableCell>{fmtNum(label.count)}</TableCell>
                    <TableCell>{fmtNum(label.actors)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

function SessionTimeline({ surfaces, env }: { surfaces: ExperienceSurface[]; env: string }) {
  const { client, project } = useStore();
  const [surface, setSurface] = useState(surfaces[0]?.key ?? '');
  const [sessionId, setSessionId] = useState('');
  const [result, setResult] = useState<ExperienceSessionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!surface || !sessionId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await client!.experienceSession(project!, {
        surface,
        session_id: sessionId.trim(),
        date_from: '-7d',
        env,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load session details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Session details" right={<span className="text-sm text-muted-foreground">known session id · numeric evidence only</span>}>
      <div className="flex flex-wrap gap-2">
        <Select value={surface} onValueChange={setSurface}>
          <SelectTrigger className="h-9 min-w-44"><SelectValue placeholder="Choose surface" /></SelectTrigger>
          <SelectContent>{surfaces.map((item) => <SelectItem key={item.key} value={item.key}>{item.name}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder="session id" className="min-w-52 flex-1" />
        <Button onClick={load} disabled={!surface || !sessionId.trim() || busy}>{busy && <Loader2 className="size-4 animate-spin" />}Load</Button>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      {result && (
        <div className="mt-4 overflow-x-auto rounded-md border">
          <Table>
            <TableHeader><TableRow><TableHead>Sequence</TableHead><TableHead>Signal</TableHead><TableHead>Route</TableHead><TableHead>Safe detail</TableHead></TableRow></TableHeader>
            <TableBody>{result.events.map((event) => (
              <TableRow key={`${event.sequence}-${event.kind}`}>
                <TableCell>{event.sequence}</TableCell>
                <TableCell><code className="text-sm">{event.kind}</code></TableCell>
                <TableCell><code className="text-sm">{event.route}</code></TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {event.label ?? event.section ?? (event.depth !== undefined ? `${event.depth}%` : event.error_type ?? '—')}
                </TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}

function Filter({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><div className="text-sm font-medium text-muted-foreground">{label}</div>{children}</div>;
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`space-y-1.5 ${className ?? ''}`}><Label>{label}</Label>{children}</div>;
}

function coverageAt(result: VisualExperienceResponse, depth: number): number {
  return result.scroll_coverage.find((item) => item.depth === depth)?.percentage ?? 0;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
