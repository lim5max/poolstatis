import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ChevronRight, ChevronDown } from '@/components/icons';
import { useStore, useAsync } from '../store';
import {
  Loading, ErrorNote, RecoverableError, StatusBadge, TypeTag, EmptyState, Panel,
  Toolbar, SearchInput, FilterChips, GroupBy, Overflow,
  DangerConfirm, VerticalStepper, type Chip,
} from '../components/ui';
import {
  CategorySelector,
  MetricCategoriesPanel,
  MetricCategoryChip,
  MetricCategoryFilter,
  UNCATEGORIZED_CATEGORY_FILTER,
  type CustomMetricCategoryInput,
} from '../components/metric-categories';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SortableTableHead, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn, isRedundantKey } from '@/lib/utils';
import { DisclosureSummary } from '@/components/disclosure';
import type { Funnel, Metric, MetricCategoryDefinition, MetricDefinitionDetail, MetricDefinitionPreview, MetricStatus, MetricUsage } from '../api/types';
import { buildRegistryHealth, type RegistryMetricHealth } from '../analysis/semanticHealth';

export function Registry() {
  const { client, project, env } = useStore();
  const [searchParams] = useSearchParams();
  const focusedMetric = searchParams.get('metric');
  const focusedFunnel = searchParams.get('funnel');
  const [tab, setTab] = useState(focusedFunnel ? 'funnels' : 'metrics');
  useEffect(() => {
    setTab(focusedFunnel ? 'funnels' : 'metrics');
  }, [focusedFunnel, focusedMetric]);
  const { data, error, loading, reload } = useAsync(async () => {
    const schema = await client!.schema(project!, env);
    const [experiments, usageEntries, savedAnswers, releases] = await Promise.all([
      typeof client!.experiments === 'function' ? client!.experiments(project!).catch(() => null) : Promise.resolve(null),
      Promise.all(schema.metrics.map(async (metric) => {
        if (typeof client!.metricUsage !== 'function') return [metric.key, null] as const;
        try {
          return [metric.key, await client!.metricUsage(project!, metric.key, { env, sinceDays: 30 })] as const;
        } catch {
          return [metric.key, null] as const;
        }
      })),
      typeof client!.analysisViews === 'function'
        ? client!.analysisViews(project!, { env, status: 'active' }).catch(() => null)
        : Promise.resolve(null),
      typeof client!.releases === 'function'
        ? client!.releases(project!, { env }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const usages = new Map<string, MetricUsage | null>(usageEntries);
    return {
      ...schema,
      registry_health: buildRegistryHealth(schema.metrics, schema.funnels, usages, experiments, savedAnswers, releases),
    };
  }, [project, env]);

  if (loading) return <Loading what="reading registry…" />;
  if (error) return <RecoverableError onRetry={reload}>{error}</RecoverableError>;
  if (!data) return null;
  const categories = data.metric_categories ?? [];

  const createCategory = async (input: CustomMetricCategoryInput) => {
    await client!.createMetricCategory(project!, input);
    reload();
  };
  const updateCategory = async (
    key: string,
    patch: Pick<CustomMetricCategoryInput, 'name' | 'description' | 'color'>,
  ) => {
    await client!.updateMetricCategory(project!, key, patch);
    reload();
  };
  const deleteCategory = async (key: string) => {
    await client!.deleteMetricCategory(project!, key);
    reload();
  };

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-4">
      <div className="max-w-full overflow-x-auto pb-1">
        <TabsList className="w-max">
          <TabsTrigger value="metrics">Metrics · {data.metrics.length}</TabsTrigger>
          <TabsTrigger value="categories">Categories · {categories.length}</TabsTrigger>
          <TabsTrigger value="funnels">Funnels · {data.funnels.length}</TabsTrigger>
          <TabsTrigger value="entities">Entity types · {data.entity_types.length}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="metrics">
        <MetricsTable metrics={data.metrics} categories={categories} health={data.registry_health} focusKey={focusedMetric} onChanged={reload} />
      </TabsContent>
      <TabsContent value="categories">
        <MetricCategoriesPanel
          categories={categories}
          onRetry={reload}
          onCreate={createCategory}
          onUpdate={updateCategory}
          onDelete={deleteCategory}
        />
      </TabsContent>
      <TabsContent value="funnels"><FunnelsTable funnels={data.funnels} focusKey={focusedFunnel} /></TabsContent>
      <TabsContent value="entities"><EntityTypesTable types={data.entity_types} /></TabsContent>
    </Tabs>
  );
}

type SortKey = 'name' | 'category' | 'type' | 'status';
const STATUS_OPTS: MetricStatus[] = ['proposed', 'active', 'deprecated'];

/** The primary event a metric reads from, for the "see its events" jump. */
function metricEvent(m: Metric): string | null {
  const s = m.source as Record<string, any>;
  if (m.type === 'conversion') return s.from?.event ?? null;
  if (m.type === 'state') return null;
  return s.event ?? null;
}

function MetricsTable({
  metrics,
  categories,
  health,
  focusKey,
  onChanged,
}: {
  metrics: Metric[];
  categories: MetricCategoryDefinition[];
  health: ReturnType<typeof buildRegistryHealth>;
  focusKey: string | null;
  onChanged: () => void;
}) {
  const { client, project } = useStore();
  const nav = useNavigate();
  const openEvents = (ev: string) => nav(`/data?tab=events&event=${encodeURIComponent(ev)}`);
  const [search, setSearch] = useState(focusKey ?? '');
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState('none');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [busy, setBusy] = useState<string | null>(null);
  const [deprecating, setDeprecating] = useState<Metric | null>(null);
  const [deleting, setDeleting] = useState<Metric | null>(null);
  const [editing, setEditing] = useState<Metric | null>(null);
  const [reviewing, setReviewing] = useState<Metric | null>(null);
  const proposedCount = metrics.filter((m) => m.status === 'proposed').length;
  const healthByKey = useMemo(() => new Map(health.rows.map((row) => [row.key, row])), [health.rows]);
  const allTags = useMemo(() => [...new Set(metrics.flatMap((m) => m.tags ?? []))].sort(), [metrics]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = metrics.filter((m) => {
      if (q && !`${m.name} ${m.key} ${m.purpose} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(q)) return false;
      if (cats.size && !(m.category ? cats.has(m.category) : cats.has(UNCATEGORIZED_CATEGORY_FILTER))) return false;
      if (statuses.size && !statuses.has(m.status)) return false;
      if (tagSel.size && !(m.tags ?? []).some((t) => tagSel.has(t))) return false;
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sort.key === 'category' ? (a.category ?? '') : a[sort.key];
      const bv = sort.key === 'category' ? (b.category ?? '') : b[sort.key];
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [metrics, search, cats, statuses, tagSel, sort]);

  const groups = useMemo(() => groupRows(filtered, groupBy), [filtered, groupBy]);
  useEffect(() => {
    if (focusKey) setSearch(focusKey);
  }, [focusKey]);
  useEffect(() => {
    if (!focusKey) return;
    const row = document.getElementById(`metric-${encodeURIComponent(focusKey)}`);
    if (!row) return;
    row.focus();
    row.scrollIntoView({ block: 'center' });
  }, [focusKey, filtered]);
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => { const n = new Set(set); n.has(v) ? n.delete(v) : n.add(v); setter(n); };
  const chips: Chip[] = [
    ...[...cats].map((c) => ({
      key: `cat:${c}`,
      label: c === UNCATEGORIZED_CATEGORY_FILTER ? 'Uncategorized' : c,
    })),
    ...[...statuses].map((s) => ({ key: `st:${s}`, label: s })),
    ...[...tagSel].map((t) => ({ key: `tag:${t}`, label: `#${t}` })),
  ];
  const removeChip = (k: string) => {
    const separator = k.indexOf(':');
    const kind = k.slice(0, separator);
    const v = k.slice(separator + 1);
    if (kind === 'cat') toggle(cats, setCats, v); else if (kind === 'st') toggle(statuses, setStatuses, v); else toggle(tagSel, setTagSel, v);
  };

  const setStatus = async (key: string, status: Exclude<MetricStatus, 'deprecated'>) => { setBusy(key); try { await client!.setMetricStatus(project!, key, status); onChanged(); } finally { setBusy(null); } };
  const deprecate = async (key: string, reason: string) => { setBusy(key); try { await client!.deprecateMetric(project!, key, reason); onChanged(); } finally { setBusy(null); } };
  const del = async (key: string) => { setBusy(key); try { await client!.deleteMetric(project!, key); onChanged(); } finally { setBusy(null); } };
  const saveTaxonomy = async (key: string, category: string | null, tags: string[]) => {
    setBusy(key);
    try {
      await client!.updateMetricTaxonomy(project!, key, { category, tags });
      onChanged();
    } finally {
      setBusy(null);
    }
  };
  const clickSort = (k: SortKey) => setSort((s) => ({ key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc' }));
  const sortDirection = (k: SortKey) => sort.key === k ? sort.dir : null;

  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <div className="flex items-center px-5 py-3.5 border-b">
        <h3 className="serif text-lg flex items-center gap-2">Metrics {proposedCount > 0 && <Badge variant="outline" className="font-sans">{proposedCount} awaiting activation</Badge>}</h3>
      </div>
      <div className="grid grid-cols-2 border-b bg-muted/20 text-center sm:grid-cols-5">
        <RegistryStat label="Healthy" value={health.healthy} note="Active, observed and used" />
        <RegistryStat label="Proposed" value={health.proposed} note="Needs explicit activation" />
        <RegistryStat label="Incomplete" value={health.incomplete} note="Active, no source evidence · 30d" />
        <RegistryStat label="Deprecated" value={health.deprecated} note="Retained for semantic history" />
        <RegistryStat label="Unused" value={health.unused} note={health.usageUnavailable > 0 ? `${health.usageUnavailable} need evidence refresh` : 'No answer surface or registered consumer'} />
      </div>
      <Toolbar
        left={<SearchInput value={search} onChange={setSearch} placeholder="Search name, key, purpose…" />}
        center={<>
          <MetricCategoryFilter
            categories={categories}
            selected={cats}
            onToggle={(c) => toggle(cats, setCats, c)}
          />
          <div className="flex h-9 rounded-md border overflow-hidden text-sm">
            {STATUS_OPTS.map((s) => (
              <button key={s} onClick={() => toggle(statuses, setStatuses, s)}
                className={cn('px-3 capitalize border-r last:border-r-0 transition-colors',
                  statuses.has(s) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
                {s}
              </button>
            ))}
          </div>
          {allTags.length > 0 && <TagFilter all={allTags} selected={tagSel} onToggle={(t) => toggle(tagSel, setTagSel, t)} />}
        </>}
        right={<><span className="text-xs text-muted-foreground tabular-nums">{filtered.length} / {metrics.length}</span><GroupBy value={groupBy} onChange={setGroupBy} /></>}
      />
      <FilterChips chips={chips} onRemove={removeChip} onClear={() => { setCats(new Set()); setStatuses(new Set()); setTagSel(new Set()); }} />
      {filtered.length === 0 ? <EmptyState headline={metrics.length ? 'No matches' : 'No metrics'} lead={metrics.length ? 'no metrics match these filters' : 'register metrics via MCP or the API'} /> : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead label="Metric" direction={sortDirection('name')} onSort={() => clickSort('name')} />
                <SortableTableHead label="Category" direction={sortDirection('category')} onSort={() => clickSort('category')} />
                <SortableTableHead label="Type" direction={sortDirection('type')} onSort={() => clickSort('type')} />
                <TableHead>Source</TableHead><TableHead>Purpose</TableHead>
                <TableHead>Used by answers</TableHead>
                <SortableTableHead label="Status" direction={sortDirection('status')} onSort={() => clickSort('status')} />
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Section
                  key={g.label ?? '_'}
                  group={g}
                  focusKey={focusKey}
                  categories={categories}
                  healthByKey={healthByKey}
                  busy={busy}
                  onActivate={(k) => setStatus(k, 'active')}
                  onDeprecate={setDeprecating}
                  onDelete={setDeleting}
                  onEditTaxonomy={setEditing}
                  onReviewDefinition={setReviewing}
                  onOpenEvents={openEvents}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {deprecating && (
        <DeprecateDialog metric={deprecating}
          onCancel={() => setDeprecating(null)}
          onConfirm={async (reason) => { await deprecate(deprecating.key, reason); setDeprecating(null); }} />
      )}
      {deleting && (
        <DangerConfirm title={`Delete ${deleting.name}?`} blastRadius="Removes the metric definition permanently."
          willDelete={['the metric definition', 'its aggregated history']} willKeep={['raw events (retained)', 'other metrics & funnels']}
          matchValue={deleting.key} matchLabel="Type the metric key to confirm" confirmLabel="Delete metric"
          onCancel={() => setDeleting(null)} onConfirm={async () => { await del(deleting.key); setDeleting(null); }} />
      )}
      {editing && (
        <TaxonomyEditor metric={editing} categories={categories} suggestions={allTags}
          onCancel={() => setEditing(null)}
          onSave={async (category, tags) => {
            await saveTaxonomy(editing.key, category, tags);
            setEditing(null);
          }}
        />
      )}
      {reviewing && (
        <DefinitionReviewDialog
          metric={reviewing}
          load={() => client!.metricDefinition(project!, reviewing.key)}
          preview={(body) => client!.previewMetricDefinition(project!, reviewing.key, body)}
          apply={(body) => client!.applyMetricDefinition(project!, reviewing.key, body)}
          onCancel={() => setReviewing(null)}
          onApplied={() => { setReviewing(null); onChanged(); }}
        />
      )}
    </Card>
  );
}

function RegistryStat({ label, value, note }: { label: string; value: number; note: string }) {
  return <div className="min-w-0 border-r p-3 last:border-r-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}</div><div className="mt-1 hidden truncate text-xs text-muted-foreground sm:block" title={note}>{note}</div></div>;
}

function DefinitionReviewDialog({
  metric,
  load,
  preview,
  apply,
  onCancel,
  onApplied,
}: {
  metric: Metric;
  load: () => Promise<MetricDefinitionDetail>;
  preview: (body: {
    expected_revision?: number;
    definition: { purpose: string; source: Record<string, unknown> };
  }) => Promise<MetricDefinitionPreview>;
  apply: (body: {
    expected_revision: number;
    expected_fingerprint: string;
    confirm_impact: true;
    definition: { purpose: string; source: Record<string, unknown> };
  }) => Promise<unknown>;
  onCancel: () => void;
  onApplied: () => void;
}) {
  const detail = useAsync(load, [metric.key]);
  const [purpose, setPurpose] = useState(metric.purpose);
  const [sourceText, setSourceText] = useState(JSON.stringify(metric.source, null, 2));
  const [proposed, setProposed] = useState<MetricDefinitionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!detail.data) return;
    setPurpose(detail.data.current.definition.purpose);
    setSourceText(JSON.stringify(detail.data.current.definition.source, null, 2));
  }, [detail.data]);

  const definition = () => {
    const source = JSON.parse(sourceText) as unknown;
    if (!source || Array.isArray(source) || typeof source !== 'object') throw new Error('Source must be a JSON object.');
    return { purpose: purpose.trim(), source: source as Record<string, unknown> };
  };
  const change = (update: () => void) => {
    update();
    setProposed(null);
    setError(null);
  };
  const previewChange = async () => {
    if (!detail.data) return;
    setBusy(true);
    setError(null);
    try {
      setProposed(await preview({
        expected_revision: detail.data.current.revision,
        definition: definition(),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Definition preview failed.');
    } finally {
      setBusy(false);
    }
  };
  const applyChange = async () => {
    if (!proposed) return;
    setBusy(true);
    setError(null);
    try {
      await apply({
        expected_revision: proposed.expected_revision,
        expected_fingerprint: proposed.current.fingerprint,
        confirm_impact: true,
        definition: definition(),
      });
      onApplied();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Definition apply failed.');
    } finally {
      setBusy(false);
    }
  };
  const impactTotal = proposed
    ? Object.values(proposed.impact.summary).reduce((sum, count) => sum + count, 0)
    : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">Definition · {metric.name}</DialogTitle>
          <DialogDescription>Semantic changes create an immutable revision. Preview dependencies before confirming.</DialogDescription>
        </DialogHeader>
        {detail.loading ? <Loading what="Reading semantic definition…" /> : detail.error ? <RecoverableError onRetry={detail.reload}>{detail.error}</RecoverableError> : detail.data && (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-3">
              <div><span className="text-xs text-muted-foreground">Current</span><div className="font-medium">Revision {detail.data.current.revision}</div></div>
              <div><span className="text-xs text-muted-foreground">Aggregation</span><code className="block text-xs">{detail.data.current.aggregation}</code></div>
              <div><span className="text-xs text-muted-foreground">Fingerprint</span><code className="block truncate text-xs" title={detail.data.current.fingerprint}>{detail.data.current.fingerprint.slice(0, 12)}…</code></div>
            </div>
            <details className="rounded-md border">
              <DisclosureSummary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Revision history · {detail.data.revisions.length}
              </DisclosureSummary>
              <ol className="space-y-2 border-t p-3">
                {[...detail.data.revisions].sort((left, right) => right.revision - left.revision).map((revision) => (
                  <li key={revision.id} className="rounded-md border bg-muted/10 p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">Revision {revision.revision} · {revisionActionLabel(revision.action)}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{formatRevisionDate(revision.created_at)} · UTC</div>
                      </div>
                      <code className="text-xs text-muted-foreground">{revision.actor}</code>
                    </div>
                    <p className="mt-2 text-sm">{revision.definition.purpose}</p>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                      <span>Aggregation · <code>{revision.aggregation}</code></span>
                      <span className="min-w-0">Fingerprint · <code className="break-all" title={revision.fingerprint}>{revision.fingerprint.slice(0, 12)}…</code></span>
                    </div>
                    <details className="mt-2 text-xs text-muted-foreground">
                      <DisclosureSummary className="cursor-pointer font-medium text-foreground">Definition snapshot</DisclosureSummary>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(revision.definition, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
            </details>
            <div className="space-y-1.5">
              <label htmlFor="metric-definition-purpose" className="text-xs text-muted-foreground">Purpose</label>
              <textarea id="metric-definition-purpose" value={purpose} onChange={(event) => change(() => setPurpose(event.target.value))} className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="metric-definition-source" className="text-xs text-muted-foreground">Source JSON</label>
              <textarea id="metric-definition-source" value={sourceText} onChange={(event) => change(() => setSourceText(event.target.value))} spellCheck={false} className="min-h-36 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring" />
            </div>
            {proposed && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">{impactTotal} registered {impactTotal === 1 ? 'dependency' : 'dependencies'}</div>
                  <Badge variant="outline" className="capitalize">{proposed.impact.severity} impact</Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">Changed: {proposed.changed_fields.join(', ') || 'none'}.</p>
                {proposed.impact.references.length > 0 && <ul className="mt-2 space-y-1 text-sm">{proposed.impact.references.map((reference) => <li key={`${reference.kind}:${reference.ref}`}><span className="text-muted-foreground">{reference.kind}</span> · {reference.label}{reference.status ? ` · ${reference.status}` : ''}</li>)}</ul>}
                {proposed.impact.truncated && <p className="mt-2 text-xs text-muted-foreground">Showing the first 25 references; totals above include every dependency.</p>}
              </div>
            )}
            {error && <ErrorNote>{error}</ErrorNote>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          {!proposed ? (
            <Button onClick={previewChange} disabled={busy || !detail.data || purpose.trim().length < 10}>{busy && <Loader2 className="size-4 animate-spin" />}Preview impact</Button>
          ) : proposed.requires_confirmation ? (
            <Button onClick={applyChange} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Confirm and apply revision {proposed.expected_revision + 1}</Button>
          ) : (
            <Button variant="outline" disabled>No semantic change</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function revisionActionLabel(action: 'created' | 'updated' | 'legacy_update'): string {
  return action === 'legacy_update' ? 'compatibility update' : action;
}

function formatRevisionDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed);
}

function DeprecateDialog({ metric, onCancel, onConfirm }: { metric: Metric; onCancel: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = reason.trim().length >= 10;
  const go = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason);
    } catch (err) {
      setError((err as Error).message ?? 'failed to deprecate metric');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">Deprecate {metric.name}?</DialogTitle>
          <DialogDescription>New events stop counting toward this metric; existing data and the definition are kept.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Reason</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Replaced by a more precise activation metric."
            className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            autoFocus
          />
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={!canSubmit || busy} className="bg-amber-500 text-black hover:bg-amber-400">
            {busy && <Loader2 className="size-4 animate-spin" />}Deprecate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TagFilter({ all, selected, onToggle }: { all: string[]; selected: Set<string>; onToggle: (t: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">{selected.size ? `Tags · ${selected.size}` : 'Tags'}<ChevronDown className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
        {all.map((t) => (
          <DropdownMenuCheckboxItem key={t} checked={selected.has(t)} onCheckedChange={() => onToggle(t)} onSelect={(e) => e.preventDefault()}>#{t}</DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaxonomyEditor({
  metric,
  categories,
  suggestions,
  onCancel,
  onSave,
}: {
  metric: Metric;
  categories: MetricCategoryDefinition[];
  suggestions: string[];
  onCancel: () => void;
  onSave: (category: string | null, tags: string[]) => Promise<void>;
}) {
  const [category, setCategory] = useState(metric.category);
  const [text, setText] = useState((metric.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parse = (s: string) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(category, parse(text));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'taxonomy update failed');
    } finally {
      setBusy(false);
    }
  };
  const add = (t: string) => setText((cur) => [...new Set([...parse(cur), t])].join(', '));
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle className="serif font-normal text-xl">Taxonomy · {metric.name}</DialogTitle>
          <DialogDescription>
            Category explains why. Namespaced tags such as <code>surface:checkout</code> and
            <code> component:payment-form</code> explain where and what.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Purpose category</span>
          <CategorySelector categories={categories} value={category} onChange={setCategory} />
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="metric-taxonomy-tags" className="text-xs text-muted-foreground">
            Namespaced tags
          </label>
          <Input
            id="metric-taxonomy-tags"
            aria-label="Namespaced tags"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="surface:checkout, component:payment-form"
          />
        </div>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 12).map((t) => <button key={t} className="text-xs rounded-full border px-2 py-0.5 text-muted-foreground hover:text-foreground hover:border-foreground/30" onClick={() => add(t)}>#{t}</button>)}
          </div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}Save taxonomy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ group, focusKey, categories, healthByKey, busy, onActivate, onDeprecate, onDelete, onEditTaxonomy, onReviewDefinition, onOpenEvents }: {
  group: { label: string | null; rows: Metric[] }; busy: string | null;
  focusKey: string | null;
  categories: MetricCategoryDefinition[];
  healthByKey: Map<string, RegistryMetricHealth>;
  onActivate: (k: string) => void; onDeprecate: (m: Metric) => void; onDelete: (m: Metric) => void;
  onEditTaxonomy: (m: Metric) => void; onReviewDefinition: (m: Metric) => void; onOpenEvents: (ev: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {group.label && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={8} className="py-2">
            <button className="flex items-center gap-2 text-xs font-medium text-muted-foreground capitalize" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{group.label}<Badge variant="secondary">{group.rows.length}</Badge>
            </button>
          </TableCell>
        </TableRow>
      )}
      {open && group.rows.map((m) => {
        const health = healthByKey.get(m.key);
        return (
        <TableRow
          key={m.id}
          id={`metric-${encodeURIComponent(m.key)}`}
          tabIndex={m.key === focusKey ? -1 : undefined}
          className={cn('group', m.key === focusKey && 'bg-accent/45')}
        >
          <TableCell>
            {metricEvent(m)
              ? <button className="font-medium text-left text-foreground underline decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground" title="See this metric's events" onClick={() => onOpenEvents(metricEvent(m)!)}>{m.name}</button>
              : <div className="font-medium">{m.name}</div>}
            {!isRedundantKey(m.name, m.key) && <div className="text-xs text-muted-foreground">{m.key}</div>}
            {(m.tags ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {m.tags.map((t) => <span key={t} className="rounded-full border px-1.5 py-px text-xs text-muted-foreground">#{t}</span>)}
              </div>
            )}
          </TableCell>
          <TableCell><MetricCategoryChip categoryKey={m.category} categories={categories} /></TableCell>
          <TableCell><TypeTag type={m.type} /></TableCell>
          <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-mono">{sourceSummary(m)}</TableCell>
          <TableCell className="max-w-sm"><div className="truncate text-xs text-muted-foreground italic" title={m.purpose}>{m.purpose}</div></TableCell>
          <TableCell className="max-w-xs">
            <div className="flex flex-wrap gap-1">
              {health?.usedByAnswers.slice(0, 2).map((answer) => <Badge key={answer} variant="outline" className="max-w-40 truncate font-normal" title={answer}>{answer}</Badge>)}
              {(health?.usedByAnswers.length ?? 0) > 2 && <Badge variant="secondary">+{health!.usedByAnswers.length - 2}</Badge>}
              {(health?.usedByAnswers.length ?? 0) === 0 && <span className="text-xs text-muted-foreground">{health?.unused === null ? 'Consumer evidence unavailable' : 'No known consumer'}</span>}
            </div>
            <details className="mt-1"><DisclosureSummary className="cursor-pointer text-xs font-medium text-foreground underline decoration-border underline-offset-2">Review evidence</DisclosureSummary><div className="mt-1 text-xs text-muted-foreground">{health?.unused === null ? 'Saved-consumer evidence is incomplete; no unused claim was made.' : health?.observedEvents == null ? 'Source evidence unavailable' : `${health.observedEvents} source events · 30d`}</div></details>
          </TableCell>
          <TableCell>
            <StatusBadge status={m.status} />
            {m.status === 'deprecated' && (
              <div className="mt-1 max-w-xs truncate text-xs text-muted-foreground" title={m.deprecation_reason ?? undefined}>
                {m.deprecation_reason ?? 'No reason recorded'}
              </div>
            )}
          </TableCell>
          <TableCell className="text-right whitespace-nowrap">
            {busy === m.key ? <Loader2 className="size-4 animate-spin inline" /> : (
              <div className="inline-flex items-center gap-1.5">
                {m.status !== 'active' && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => onActivate(m.key)}>activate</Button>}
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => onReviewDefinition(m)} aria-label={`Review ${m.name} definition`}>review</Button>
                <Overflow items={[
                  { label: 'Edit category & tags', onClick: () => onEditTaxonomy(m) },
                  ...(m.status !== 'deprecated' ? [{ label: 'Deprecate', onClick: () => onDeprecate(m) }] : []),
                  ...(m.status === 'deprecated' ? [{ label: 'Delete metric', onClick: () => onDelete(m), danger: true }] : []),
                ]} />
              </div>
            )}
          </TableCell>
        </TableRow>
      );})}
    </>
  );
}

function groupRows(rows: Metric[], by: string): Array<{ label: string | null; rows: Metric[] }> {
  if (by === 'none') return [{ label: null, rows }];
  const map = new Map<string, Metric[]>();
  // Tags are multi-valued: a metric appears under each of its tags (+ 'untagged').
  if (by === 'tag') {
    for (const m of rows) {
      const keys = (m.tags ?? []).length ? m.tags : ['untagged'];
      for (const k of keys) { if (!map.has(k)) map.set(k, []); map.get(k)!.push(m); }
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rs]) => ({ label, rows: rs }));
  }
  for (const m of rows) {
    const key = by === 'category' ? (m.category ?? 'uncategorized') : by === 'type' ? m.type : m.status;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rs]) => ({ label, rows: rs }));
}

function FunnelsTable({ funnels, focusKey }: { funnels: Funnel[]; focusKey: string | null }) {
  if (funnels.length === 0) return <Panel><EmptyState headline="No funnels" lead="defined from registry metrics via MCP or API" /></Panel>;
  return (
    <Panel title={<>Funnels <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{funnels.length}</span></>}>
      <div className="divide-y">
        {funnels.map((f) => <FunnelRow key={f.key} funnel={f} focused={f.key === focusKey} />)}
      </div>
    </Panel>
  );
}

function FunnelRow({ funnel, focused }: { funnel: Funnel; focused: boolean }) {
  const [open, setOpen] = useState(focused);
  const rowId = `funnel-${encodeURIComponent(funnel.key)}`;
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    const row = document.getElementById(rowId);
    row?.focus();
    row?.scrollIntoView({ block: 'center' });
  }, [focused, rowId]);
  return (
    <section id={rowId} tabIndex={focused ? -1 : undefined} data-testid={`funnel-summary-${funnel.key}`} className={cn('grid min-w-0 gap-3 px-5 py-4 lg:grid-cols-[minmax(10rem,1fr)_minmax(16rem,2fr)_auto] lg:items-start', focused && 'bg-accent/45')}>
      <div className="min-w-0">
        <div className="font-medium break-words">{funnel.name}</div>
        <code className="text-xs text-muted-foreground break-all">{funnel.key}</code>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">Goal</div>
        <p className="mt-1 text-sm text-muted-foreground break-words">{funnel.goal}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:justify-end">
        <Badge variant="outline">{funnel.steps.length} steps</Badge>
        <Badge variant="outline">{Math.round(funnel.window_seconds / 86400)}d window</Badge>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={`funnel-${funnel.key}-steps`}
          aria-label={`${open ? 'Hide' : 'Show'} ${funnel.name} steps`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? 'Hide steps' : 'Review steps'}
        </Button>
      </div>
      {open && (
        <div id={`funnel-${funnel.key}-steps`} className="min-w-0 rounded-md border bg-muted/20 p-4 lg:col-span-3">
          <VerticalStepper steps={funnel.steps} />
        </div>
      )}
    </section>
  );
}

function EntityTypesTable({ types }: { types: { name: string; description: string }[] }) {
  if (types.length === 0) return <Panel><EmptyState headline="No entity types" lead="register them via MCP or API before upserting entities" /></Panel>;
  return (
    <Panel title="Entity types">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Type</TableHead><TableHead>Description</TableHead></TableRow></TableHeader>
          <TableBody>{types.map((t) => <TableRow key={t.name}><TableCell className="font-medium">{t.name}</TableCell><TableCell><div className="text-xs text-muted-foreground italic">{t.description}</div></TableCell></TableRow>)}</TableBody>
        </Table>
      </div>
    </Panel>
  );
}

function sourceSummary(m: Metric): string {
  const s = m.source as Record<string, any>;
  if (m.type === 'conversion') return `${s.from?.event} → ${s.to?.event}`;
  if (m.type === 'state') return `entity:${s.entity_type}`;
  if (m.type === 'value') return `${s.event}.${s.value_property} (${s.agg})`;
  const f = Array.isArray(s.filters) && s.filters.length ? ` ·${s.filters.length}f` : '';
  return `${s.event}${f}`;
}
