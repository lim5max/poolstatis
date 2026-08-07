import { useState, type ReactNode } from 'react';
import { Add, ChevronDown, KeyRound, Loader2, Trash2 } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState, ErrorNote, Hint, Loading } from './ui';
import type { MetricCategoryDefinition } from '../api/types';

export interface CustomMetricCategoryInput {
  key: string;
  name: string;
  description: string;
  domain: 'custom';
  color: string;
}

interface MetricCategoriesPanelProps {
  categories: MetricCategoryDefinition[] | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onCreate(input: CustomMetricCategoryInput): Promise<void>;
  onUpdate(key: string, patch: Pick<CustomMetricCategoryInput, 'name' | 'description' | 'color'>): Promise<void>;
  onDelete(key: string): Promise<void>;
}

const DOMAINS: Array<{
  key: MetricCategoryDefinition['domain'];
  label: string;
  description: string;
}> = [
  { key: 'product', label: 'Product', description: 'Why people discover, adopt, use, and value the product.' },
  { key: 'business', label: 'Business', description: 'Why the organization earns, spends, or improves efficiency.' },
  { key: 'technical', label: 'Technical', description: 'Why engineering quality, reliability, delivery, or safety matters.' },
  { key: 'custom', label: 'Custom', description: 'Project-only semantics that the stable system library cannot express.' },
];

export const UNCATEGORIZED_CATEGORY_FILTER = '\0uncategorized';

export function CategorySelector({
  categories,
  value,
  onChange,
  allowUncategorized = true,
}: {
  categories: MetricCategoryDefinition[];
  value: string | null;
  onChange(value: string | null): void;
  allowUncategorized?: boolean;
}) {
  const selected = value
    ? categories.find((category) => category.key === value)
    : undefined;
  return (
    <div className="grid gap-1.5">
      <select
        aria-label="Metric category"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
      >
        {allowUncategorized && <option value="">Uncategorized</option>}
        {DOMAINS.map((domain) => {
          const rows = categories.filter((category) => category.domain === domain.key);
          return rows.length > 0 ? (
            <optgroup key={domain.key} label={domain.label}>
              {rows.map((category) => (
                <option key={category.key} value={category.key}>{category.name}</option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      <p className="text-xs text-muted-foreground">
        {selected?.description
          ?? 'Uncategorized remains valid for compatibility, but should be reconciled when its purpose is known.'}
      </p>
    </div>
  );
}

export function MetricCategoryChip({
  categoryKey,
  categories,
}: {
  categoryKey: string | null;
  categories: MetricCategoryDefinition[];
}) {
  if (!categoryKey) return <span className="text-xs text-muted-foreground">Uncategorized</span>;
  const category = categories.find((item) => item.key === categoryKey);
  if (!category) return <span className="text-xs text-muted-foreground">{categoryKey}</span>;
  return (
    <Hint label={category.description}>
      <span className="inline-flex cursor-help items-center gap-1.5 text-xs">
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: category.color }}
        />
        {category.name}
      </span>
    </Hint>
  );
}

export function MetricCategoryFilter({
  categories,
  selected,
  onToggle,
}: {
  categories: MetricCategoryDefinition[];
  selected: Set<string>;
  onToggle(value: string): void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">
          {selected.size ? `Category · ${selected.size}` : 'Category'}
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-64 overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={selected.has(UNCATEGORIZED_CATEGORY_FILTER)}
          onCheckedChange={() => onToggle(UNCATEGORIZED_CATEGORY_FILTER)}
          onSelect={(event) => event.preventDefault()}
        >
          <span>
            <span className="block">Uncategorized</span>
            <span className="block text-xs text-muted-foreground">Purpose category not reconciled</span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {DOMAINS.map((domain, domainIndex) => {
          const rows = categories.filter((category) => category.domain === domain.key);
          if (rows.length === 0) return null;
          return (
            <div key={domain.key}>
              {domainIndex > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>{domain.label}</DropdownMenuLabel>
              {rows.map((category) => (
                <DropdownMenuCheckboxItem
                  key={category.key}
                  checked={selected.has(category.key)}
                  onCheckedChange={() => onToggle(category.key)}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: category.color }}
                    />
                    <span className="min-w-0">
                      <span className="block">{category.name}</span>
                      <span className="block max-w-56 truncate text-xs text-muted-foreground">
                        {category.description}
                      </span>
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MetricCategoriesPanel({
  categories,
  loading = false,
  error = null,
  onRetry,
  onCreate,
  onUpdate,
  onDelete,
}: MetricCategoriesPanelProps) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MetricCategoryDefinition | null>(null);
  const [deleting, setDeleting] = useState<MetricCategoryDefinition | null>(null);

  if (loading) return <Loading what="reading metric categories…" />;
  if (error) {
    return (
      <div className="space-y-3">
        <ErrorNote>{error}</ErrorNote>
        {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
      </div>
    );
  }
  if (!categories?.length) {
    return (
      <Card className="gap-0 py-0 overflow-hidden">
        <EmptyState
          headline="No category definitions"
          lead="reload the project schema; every project should contain the system taxonomy"
          action={onRetry && <Button variant="outline" onClick={onRetry}>Retry</Button>}
        />
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div className="max-w-2xl">
          <h3 className="serif text-lg">Metric categories</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Category explains why a metric exists. Use namespaced tags for where and what,
            and funnels for journeys.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Add className="size-4" />Create custom category
        </Button>
      </div>

      <div
        data-testid="metric-category-groups"
        className="grid gap-4 p-4 lg:grid-cols-2 lg:p-5"
      >
        {DOMAINS.map((domain) => {
          const rows = categories.filter((category) => category.domain === domain.key);
          return (
            <section key={domain.key} className="min-w-0 rounded-lg border bg-card">
              <div className="border-b px-4 py-3">
                <h4 className="font-medium" aria-label={domain.label}>{domain.label}</h4>
                <p className="mt-1 text-xs text-muted-foreground">{domain.description}</p>
              </div>
              <div className="divide-y">
                {rows.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">
                    {domain.key === 'custom' ? 'No custom categories' : 'No definitions in this domain'}
                  </p>
                ) : rows.map((category) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    onEdit={() => setEditing(category)}
                    onDelete={() => setDeleting(category)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {creating && (
        <CategoryFormDialog
          title="Create custom category"
          submitLabel="Create category"
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            await onCreate({ ...input, key: input.key, domain: 'custom' });
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <CategoryFormDialog
          title={`Edit ${editing.name}`}
          submitLabel="Save category"
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (input) => {
            await onUpdate(editing.key, {
              name: input.name,
              description: input.description,
              color: input.color,
            });
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <DeleteCategoryDialog
          category={deleting}
          onCancel={() => setDeleting(null)}
          onDelete={async () => {
            await onDelete(deleting.key);
            setDeleting(null);
          }}
        />
      )}
    </Card>
  );
}

function CategoryRow({
  category,
  onEdit,
  onDelete,
}: {
  category: MetricCategoryDefinition;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <div
      data-testid={`metric-category-${category.key}`}
      className="flex min-w-0 flex-wrap items-start gap-3 px-4 py-3"
    >
      <span
        className="mt-1 size-3 shrink-0 rounded-full border"
        style={{ backgroundColor: category.color }}
        aria-label={`${category.color} color`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{category.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{category.key}</span>
          {category.is_system && (
            <Hint label="System categories are locked because their keys and purpose semantics are shared across projects.">
              <Badge variant="secondary" className="cursor-help gap-1">
                <KeyRound className="size-3" />Locked
              </Badge>
            </Hint>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{category.description}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {category.metric_count} {category.metric_count === 1 ? 'metric' : 'metrics'}
        </p>
      </div>
      {!category.is_system && (
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={`Edit ${category.name}`}>
            Edit
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Delete ${category.name}`}>
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      )}
    </div>
  );
}

function CategoryFormDialog({
  title,
  submitLabel,
  initial,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: MetricCategoryDefinition;
  onCancel(): void;
  onSubmit(input: Omit<CustomMetricCategoryInput, 'domain'>): Promise<void>;
}) {
  const [key, setKey] = useState(initial?.key ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [color, setColor] = useState(initial?.color ?? '#6D5BD0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[a-z][a-z0-9_]*$/.test(key)
    && name.trim().length > 0
    && description.trim().length >= 10
    && /^#[0-9a-fA-F]{6}$/.test(color);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        key,
        name: name.trim(),
        description: description.trim(),
        color: color.toUpperCase(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'category request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent aria-describedby={undefined} className="max-h-dvh overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">{title}</DialogTitle>
          <DialogDescription>
            Custom categories are for purpose semantics missing from the system library,
            not for features, surfaces, or journeys.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Key">
            <Input
              aria-label="Key"
              value={key}
              onChange={(event) => setKey(event.target.value.toLowerCase())}
              placeholder="governance"
              disabled={Boolean(initial)}
              autoFocus={!initial}
            />
          </Field>
          <Field label="Name">
            <Input
              aria-label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus={Boolean(initial)}
            />
          </Field>
          <Field label="Description">
            <textarea
              aria-label="Description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>
          <Field label="Color">
            <div className="flex items-center gap-2">
              <input
                aria-label="Color picker"
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value.toUpperCase())}
                className="size-9 rounded-md border bg-background p-1"
              />
              <Input
                aria-label="Color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                className="font-mono uppercase"
              />
            </div>
          </Field>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}{submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </div>
  );
}

function DeleteCategoryDialog({
  category,
  onCancel,
  onDelete,
}: {
  category: MetricCategoryDefinition;
  onCancel(): void;
  onDelete(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'category request failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">Delete {category.name}?</DialogTitle>
          <DialogDescription>
            Deletion is allowed only while no metric references this custom category.
          </DialogDescription>
        </DialogHeader>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}Delete category
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
