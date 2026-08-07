import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import type { Funnel, Metric, MetricCategoryDefinition, MetricStatus } from '../api/types';

export function Registry() {
  const { client, project, env } = useStore();
  const { data, error, loading, reload } = useAsync(() => client!.schema(project!, env), [project, env]);

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
    <Tabs defaultValue="metrics" className="gap-4">
      <div className="max-w-full overflow-x-auto pb-1">
        <TabsList className="w-max">
          <TabsTrigger value="metrics">Metrics · {data.metrics.length}</TabsTrigger>
          <TabsTrigger value="categories">Categories · {categories.length}</TabsTrigger>
          <TabsTrigger value="funnels">Funnels · {data.funnels.length}</TabsTrigger>
          <TabsTrigger value="entities">Entity types · {data.entity_types.length}</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="metrics">
        <MetricsTable metrics={data.metrics} categories={categories} onChanged={reload} />
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
      <TabsContent value="funnels"><FunnelsTable funnels={data.funnels} /></TabsContent>
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
  onChanged,
}: {
  metrics: Metric[];
  categories: MetricCategoryDefinition[];
  onChanged: () => void;
}) {
  const { client, project } = useStore();
  const nav = useNavigate();
  const openEvents = (ev: string) => nav(`/data?tab=events&event=${encodeURIComponent(ev)}`);
  const [search, setSearch] = useState('');
  const [cats, setCats] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());
  const [tagSel, setTagSel] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState('none');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [busy, setBusy] = useState<string | null>(null);
  const [deprecating, setDeprecating] = useState<Metric | null>(null);
  const [deleting, setDeleting] = useState<Metric | null>(null);
  const [editing, setEditing] = useState<Metric | null>(null);
  const proposedCount = metrics.filter((m) => m.status === 'proposed').length;
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
                <SortableTableHead label="Status" direction={sortDirection('status')} onSort={() => clickSort('status')} />
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <Section
                  key={g.label ?? '_'}
                  group={g}
                  categories={categories}
                  busy={busy}
                  onActivate={(k) => setStatus(k, 'active')}
                  onDeprecate={setDeprecating}
                  onDelete={setDeleting}
                  onEditTaxonomy={setEditing}
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
    </Card>
  );
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

function Section({ group, categories, busy, onActivate, onDeprecate, onDelete, onEditTaxonomy, onOpenEvents }: {
  group: { label: string | null; rows: Metric[] }; busy: string | null;
  categories: MetricCategoryDefinition[];
  onActivate: (k: string) => void; onDeprecate: (m: Metric) => void; onDelete: (m: Metric) => void;
  onEditTaxonomy: (m: Metric) => void; onOpenEvents: (ev: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {group.label && (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell colSpan={7} className="py-2">
            <button className="flex items-center gap-2 text-xs font-medium text-muted-foreground capitalize" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{group.label}<Badge variant="secondary">{group.rows.length}</Badge>
            </button>
          </TableCell>
        </TableRow>
      )}
      {open && group.rows.map((m) => (
        <TableRow key={m.id} className="group">
          <TableCell>
            {metricEvent(m)
              ? <button className="font-medium text-left hover:text-brand-strong hover:underline underline-offset-2" title="See this metric's events" onClick={() => onOpenEvents(metricEvent(m)!)}>{m.name}</button>
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
                <Overflow items={[
                  { label: 'Edit category & tags', onClick: () => onEditTaxonomy(m) },
                  ...(m.status !== 'deprecated' ? [{ label: 'Deprecate', onClick: () => onDeprecate(m) }] : []),
                  ...(m.status === 'deprecated' ? [{ label: 'Delete metric', onClick: () => onDelete(m), danger: true }] : []),
                ]} />
              </div>
            )}
          </TableCell>
        </TableRow>
      ))}
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

function FunnelsTable({ funnels }: { funnels: Funnel[] }) {
  if (funnels.length === 0) return <Panel><EmptyState headline="No funnels" lead="defined from registry metrics via MCP or API" /></Panel>;
  return (
    <Panel title={<>Funnels <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">{funnels.length}</span></>}>
      <div className="divide-y">
        {funnels.map((f) => <FunnelRow key={f.key} funnel={f} />)}
      </div>
    </Panel>
  );
}

function FunnelRow({ funnel }: { funnel: Funnel }) {
  const [open, setOpen] = useState(false);
  return (
    <section data-testid={`funnel-summary-${funnel.key}`} className="grid min-w-0 gap-3 px-5 py-4 lg:grid-cols-[minmax(10rem,1fr)_minmax(16rem,2fr)_auto] lg:items-start">
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
