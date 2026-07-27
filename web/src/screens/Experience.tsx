import { useEffect, useMemo, useState } from 'react';
import { Add, GridView, Loader2 } from '@/components/icons';
import { useAsync, useStore } from '../store';
import { EmptyState, ErrorNote, Loading, Panel, RecoverableError, Stat, fmtNum } from '../components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type {
  ExperienceRoute,
  InteractionMapResponse,
  ExperienceSessionResponse,
  ExperienceSnapshot,
  ExperienceSurface,
  VisualExperienceCompareResponse,
  VisualExperienceResponse,
} from '../api/types';

export function Experience() {
  const { client, project, env, availableEnvs, setEnv } = useStore();
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

  return (
    <div className="space-y-4">
      <Panel
        title="Visual Experience"
        right={<span className="text-xs text-muted-foreground">aggregate maps · no DOM replay</span>}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm text-muted-foreground">
              Read clicks, scroll reach and named-section aggregate reach on the immutable page version that produced them.
              Poolstatis stores only consented coordinates and developer labels — never DOM, text, form values,
              query strings or pointer paths.
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

      {data.snapshots.length === 0
        ? (
          <Panel title="No visual evidence yet">
            <EmptyState
              headline="Capture the first page version"
              lead="Declare a surface and route, then upload a PNG or WebP deploy snapshot. Interaction events stay separate."
            />
          </Panel>
        )
        : (
          <VisualExplorer
            surfaces={data.surfaces}
            routes={data.routes}
            snapshots={data.snapshots}
            env={env}
          />
        )}

      <SnapshotSetup
        surfaces={data.surfaces}
        routes={data.routes}
        env={env}
        onChanged={reload}
      />

      <AggregateClickEvidence surfaces={data.surfaces} env={env} />

      <details className="group">
        <summary className="cursor-pointer list-none rounded-md border bg-card px-5 py-4 text-sm font-medium outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
          Capture configuration and session details
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {data.surfaces.length} surfaces · {data.routes.length} routes
          </span>
        </summary>
        <div className="mt-4 space-y-4">
          <SurfaceForm onCreated={reload} />
          <RouteForm surfaces={data.surfaces} onCreated={reload} />
          <SurfacesTable surfaces={data.surfaces} routes={data.routes} onChanged={reload} />
          <SessionTimeline surfaces={data.surfaces} env={env} />
        </div>
      </details>
    </div>
  );
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

  const versions = [...new Set(routeSnapshots.map((item) => item.version))];
  const devices = [...new Set(routeSnapshots.filter((item) => item.version === version).map((item) => item.device))];
  const routeOptions = routes.filter((item) => item.surface_key === surface);

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
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      setResult(await client!.visualExperience(project!, {
        surface,
        route,
        version,
        device,
        date_from: period,
        env,
        grid: 24,
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load visual evidence.');
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // The selected evidence tuple is the request identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, route, version, device, period, env]);

  const compare = async () => {
    const alternative = routeSnapshots.find((item) => item.version === version && item.device !== device)
      ?? routeSnapshots.find((item) => item.version !== version);
    if (!alternative) return;
    setCompareBusy(true);
    setError(null);
    try {
      setComparison(await client!.compareVisualExperience(project!, {
        surface,
        route,
        env,
        grid: 24,
        baseline: { version, device, date_from: period },
        comparison: { version: alternative.version, device: alternative.device, date_from: period },
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not compare visual evidence.');
    } finally {
      setCompareBusy(false);
    }
  };

  return (
    <div id="visual-experience-map" className="scroll-mt-4">
      <Panel
        title="Page evidence"
        right={result?.snapshot?.stale
          ? <span className="text-xs text-amber-700">Snapshot may be stale</span>
          : <span className="text-xs text-muted-foreground">Exact version + layout</span>}
      >
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
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
            <SelectTrigger className="h-9 w-full font-mono text-xs"><SelectValue /></SelectTrigger>
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
        <div className="flex items-end">
          <Button variant="outline" className="w-full" onClick={compare} disabled={compareBusy || routeSnapshots.length < 2}>
            {compareBusy ? <Loader2 className="size-4 animate-spin" /> : <GridView className="size-4" />}
            Compare
          </Button>
        </div>
      </div>

      <div className="mt-4">
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
      {comparison && <ComparisonStrip comparison={comparison} />}
      </Panel>
    </div>
  );
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="overflow-hidden rounded-md border bg-muted/30">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-xs text-muted-foreground">
            <span>
              image {result.snapshot.width} × {result.snapshot.height}px · document {result.snapshot.document_width} × {result.snapshot.document_height} · viewport {result.snapshot.viewport_width} × {result.snapshot.viewport_height}
            </span>
            <span className="font-mono">{result.snapshot.release_hash}</span>
          </div>
          {imageError && <div className="p-5"><ErrorNote>{imageError}</ErrorNote></div>}
          {!imageUrl && !imageError && <Loading what="loading immutable snapshot…" />}
          {imageUrl && (
            <div className="relative mx-auto max-w-5xl bg-background">
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
                  <span className="absolute left-2 top-1 rounded-sm bg-background/90 px-1.5 py-0.5 font-mono text-xs">
                    {section.section} · {section.percentage}%
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">Labelled targets</div>
            {!hasSignals
              ? <p className="text-sm text-muted-foreground">No accepted signals match this exact version and device.</p>
              : result.click_labels.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-2 border-b py-2 text-sm">
                  <code className="truncate text-xs">{item.label}</code>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{item.count} · {item.actors}</span>
                </div>
              ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{result.causality}</p>
        </div>
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
        <div className="text-xs text-muted-foreground">Denominator: {total} page-view sessions</div>
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
                    <TableCell><code className="text-xs">{section.section}</code></TableCell>
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
    <div className="mt-4 rounded-md border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Compared with {target}</div>
          <p className="mt-1 text-xs text-muted-foreground">{comparison.causality}</p>
        </div>
        <div className="flex gap-4 font-mono text-xs">
          <span>sessions {signed(comparison.delta.sessions)}</span>
          <span>clicks {signed(comparison.delta.clicks)}</span>
          <span>actors {signed(comparison.delta.actors)}</span>
        </div>
      </div>
      {comparison.delta.sections.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {comparison.delta.sections.map((section) => (
            <span key={section.section} className="rounded-md border bg-background px-2 py-1 font-mono text-xs">
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
    <Panel title="Add a deploy snapshot" right={<span className="text-xs text-muted-foreground">PNG / WebP · 5 MB max · 90 days</span>}>
      {surfaces.length === 0
        ? <p className="text-sm text-muted-foreground">Create a capture surface first.</p>
        : (
          <>
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
          </>
        )}
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
            className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
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
      {activeSurfaces.length === 0
        ? <EmptyState headline="No active surface" lead="Create or reactivate a capture surface before adding routes." />
        : (
          <>
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
          </>
        )}
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
      {surfaces.length === 0
        ? <EmptyState headline="No surfaces" lead="Declare a purpose and canonical route before enabling BrowserExperience." />
        : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Surface</TableHead><TableHead>Routes</TableHead><TableHead>Purpose</TableHead><TableHead>Capture status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {surfaces.map((surface) => (
                  <TableRow key={surface.id}>
                    <TableCell><div className="font-medium">{surface.name}</div><code className="text-xs text-muted-foreground">{surface.key}</code></TableCell>
                    <TableCell>{routes.filter((item) => item.surface_key === surface.key).map((item) => <div key={item.id} className="text-xs"><code>{item.key}</code> · {item.path_pattern}</div>)}</TableCell>
                    <TableCell className="max-w-lg text-sm text-muted-foreground">{surface.purpose}</TableCell>
                    <TableCell className="text-xs">
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
        )}
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
        right={<span className="text-xs text-muted-foreground">snapshot optional · accepted events only</span>}
      >
        <p className="mb-3 text-xs text-muted-foreground">
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
                    <TableCell><code className="text-xs">{label.label}</code></TableCell>
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
    <Panel title="Session details" right={<span className="text-xs text-muted-foreground">known session id · numeric evidence only</span>}>
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
                <TableCell><code className="text-xs">{event.kind}</code></TableCell>
                <TableCell><code className="text-xs">{event.route}</code></TableCell>
                <TableCell className="text-xs text-muted-foreground">
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
  return <div className="space-y-1.5"><div className="text-xs font-medium text-muted-foreground">{label}</div>{children}</div>;
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
