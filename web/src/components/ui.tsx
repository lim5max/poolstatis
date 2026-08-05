import { useState, type ReactNode } from 'react';
import {
  AlertTriangle, Search, ChevronDown, MoreHorizontal, Copy, Eye, EyeOff, Download, Check, Loader2, X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FunnelStep, MetricStatus, MetricType } from '../api/types';

// ===== hint (tooltip) =====

/** Wrap any element with an explanatory tooltip. The child must accept a ref. */
export function Hint({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs">{label}</TooltipContent>
    </Tooltip>
  );
}

export function HelpHint({ label, ariaLabel }: { label: ReactNode; ariaLabel: string }) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={ariaLabel}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ?
      </button>
    </Hint>
  );
}

// ===== status / type badges =====

const STATUS_HINT: Record<MetricStatus, string> = {
  proposed: 'Proposed — registered by an agent, not yet counting. Activate it to start matching events.',
  active: 'Active — events matching this metric are flagged registered on ingest.',
  deprecated: 'Deprecated — retired; existing data kept, new events no longer count toward it.',
};

export function StatusBadge({ status }: { status: MetricStatus }) {
  const map = { active: 'default', proposed: 'outline', deprecated: 'secondary' } as const;
  return (
    <Hint label={STATUS_HINT[status]}>
      <Badge variant={map[status]} className={cn('capitalize cursor-help', status === 'deprecated' && 'line-through opacity-70')}>{status}</Badge>
    </Hint>
  );
}

export function TypeTag({ type }: { type: MetricType }) {
  return <Badge variant="outline" className="font-normal text-muted-foreground">{type.replace('_', ' ')}</Badge>;
}

/** registered vs off-standard event badge, with a tooltip explaining the terms. */
export function RegBadge({ registered }: { registered: boolean }) {
  return registered
    ? <Hint label="Registered — this event matches an active metric in the registry."><Badge className="cursor-help">reg</Badge></Hint>
    : <Hint label="Off-standard — no active metric covers this event. It's stored but not counted; reconcile in the registry."><Badge variant="destructive" className="cursor-help">wild</Badge></Hint>;
}

// ===== layout helpers =====

export function Panel({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-0 py-0 overflow-hidden">
      {(title || right) && (
        <CardHeader className="flex flex-row items-center justify-between border-b py-3.5 px-5 [.border-b]:pb-3.5">
          {/* Heading is serif; any inline subtitle inside should pass font-sans. */}
          {title ? <CardTitle className="serif text-lg font-normal">{title}</CardTitle> : <span />}
          {right}
        </CardHeader>
      )}
      <CardContent className="p-5">{children}</CardContent>
    </Card>
  );
}

/** Small muted label (replaces the old all-caps eyebrow). */
export function FieldLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-xs font-medium text-muted-foreground', className)}>{children}</span>;
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="py-0">
      <CardContent className="p-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className="serif text-3xl mt-1 tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export function EmptyState({ headline, lead, action }: { headline: string; lead?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center text-muted-foreground" role="status">
      <div className="serif text-xl text-foreground/70">{headline}</div>
      {lead && <div className="text-sm">{lead}</div>}
      {action && <div className="flex gap-2 mt-1">{action}</div>}
    </div>
  );
}

export function Loading({ what }: { what?: string }) {
  return <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground" role="status" aria-live="polite" aria-busy="true"><Loader2 className="size-4 animate-spin" /> {what ?? 'Loading…'}</div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function RecoverableError({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <ErrorNote>{children}</ErrorNote>
      <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
    </div>
  );
}

export function WarningNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning" role="status">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Keeps wide administrative tables usable inside Panels, including on mobile. */
export function TableScroll({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="overflow-x-auto" data-testid={testId}>{children}</div>;
}

export function Meter({ value }: { value: number }) {
  const safe = Number.isFinite(value) ? value : 0; // never render width: NaN%
  const pct = Math.max(0, Math.min(1, safe)) * 100;
  const color = safe >= 0.99 ? 'bg-emerald-500' : safe >= 0.6 ? 'bg-amber-500' : 'bg-destructive';
  return <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} /></div>;
}

// ===== toolbar / search / filters =====

export function Toolbar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b">
      {left && <div className="min-w-0">{left}</div>}
      {center && <div className="flex min-w-0 flex-wrap items-center gap-2">{center}</div>}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative min-w-0 w-full sm:min-w-56 sm:w-auto">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? 'Search…'} className="pl-8 h-9" />
    </div>
  );
}

export interface Chip { key: string; label: string }
export function FilterChips({ chips, onRemove, onClear }: { chips: Chip[]; onRemove: (k: string) => void; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap px-5 py-2.5 border-b">
      <span className="text-xs font-medium text-muted-foreground">Filters</span>
      {chips.map((c) => (
        <Badge key={c.key} variant="secondary" className="gap-1 pr-1 font-normal">
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label} filter`}
            onClick={() => onRemove(c.key)}
            className="hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <button className="text-xs text-primary hover:underline" onClick={onClear}>clear all</button>
    </div>
  );
}

export function GroupBy({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9">Group: {value}<ChevronDown className="size-3.5" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {['none', 'category', 'tag', 'type', 'status'].map((o) => (
          <DropdownMenuItem key={o} onClick={() => onChange(o)}>{value === o && <Check className="size-3.5" />}{o}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Overflow({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean }> }) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="More actions"><MoreHorizontal className="size-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((it, i) => (
          <DropdownMenuItem key={i} onClick={it.onClick} variant={it.danger ? 'destructive' : 'default'}>{it.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ===== modals =====

export function Confirm({ title, body, error, confirmLabel, tone = 'neutral', onConfirm, onCancel }: {
  title: string; body: ReactNode; error?: ReactNode; confirmLabel: string; tone?: 'neutral' | 'warn'; onConfirm: () => void; onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader><DialogTitle className="serif font-normal text-xl">{title}</DialogTitle><DialogDescription>{body}</DialogDescription></DialogHeader>
        {error && <ErrorNote>{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={go} disabled={busy} className={tone === 'warn' ? 'bg-amber-500 text-black hover:bg-amber-400' : ''}>
            {busy && <Loader2 className="size-4 animate-spin" />}{confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DangerConfirm({ title, blastRadius, willDelete, willKeep, error, matchValue, matchLabel, confirmLabel, onConfirm, onCancel }: {
  title: string; blastRadius?: ReactNode; willDelete: string[]; willKeep: string[]; error?: ReactNode;
  matchValue: string; matchLabel: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed === matchValue;
  const go = async () => { if (!ok) return; setBusy(true); try { await onConfirm(); } finally { setBusy(false); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="border-destructive/50">
        <DialogHeader><DialogTitle className="serif font-normal text-xl text-destructive">{title}</DialogTitle>
          {blastRadius && <DialogDescription>{blastRadius}</DialogDescription>}
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border p-3">
            <div className="text-xs font-medium text-destructive mb-1.5">Will delete</div>
            <ul className="space-y-1 text-muted-foreground">{willDelete.map((x, i) => <li key={i}>− {x}</li>)}</ul>
          </div>
          <div className="rounded-md border p-3">
            <div className="text-xs font-medium text-emerald-500 mb-1.5">Will keep</div>
            <ul className="space-y-1 text-muted-foreground">{willKeep.map((x, i) => <li key={i}>✓ {x}</li>)}</ul>
          </div>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <p className="text-destructive text-xs">This cannot be undone.</p>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground flex items-center gap-2">{matchLabel}
            <code className="cursor-pointer rounded bg-muted px-1.5 py-0.5 text-primary" onClick={() => navigator.clipboard?.writeText(matchValue)}>{matchValue}</code>
          </label>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={matchValue} autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={go} disabled={!ok || busy}>{busy && <Loader2 className="size-4 animate-spin" />}{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SecretReveal({ token, kind, onDone }: { token: string; kind: string; onDone: () => void }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const masked = `${token.slice(0, 3)}${'•'.repeat(24)}`;
  const copy = async () => { try { await navigator.clipboard.writeText(token); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch { /* blocked */ } };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([token], { type: 'text/plain' }));
    a.download = `poolstatis-${kind}-key.txt`; a.click();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent>
        <DialogHeader><DialogTitle className="serif font-normal text-xl">New {kind} key</DialogTitle>
          <DialogDescription className="text-amber-500">Copy it now — this is the first and last time the full key is shown.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <code className="flex-1 break-all text-xs">{shown ? token : masked}</code>
          <Button variant="outline" size="icon" className="size-8" onClick={() => setShown((s) => !s)}>{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
          <Button variant="outline" size="icon" className="size-8" onClick={copy}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
          <Button variant="outline" size="icon" className="size-8" onClick={download}><Download className="size-4" /></Button>
        </div>
        <DialogFooter><Button onClick={onDone}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Ephemeral credential reveal: the owner sees plaintext only in this dialog. */
export function OneTimeTokenReveal({ token, title, onDismiss }: { token: string; title: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="serif font-normal text-xl">{title}</DialogTitle>
          <DialogDescription className="text-amber-600 dark:text-amber-400">This is the only time the full token is shown. Copy it into your agent configuration before closing this dialog.</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/40 p-3">
          <code className="mono block break-all text-sm">{token}</code>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={copy} aria-label="Copy token">{copied ? 'Copied' : 'Copy token'}</Button>
          <Button onClick={onDismiss}>I copied the token</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===== funnel steps =====

export function NumberedStepChips({ steps, max = 3 }: { steps: FunnelStep[]; max?: number }) {
  const shown = steps.slice(0, max);
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {shown.map((s, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span className="text-primary/50">→</span>}
          <span className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded border text-xs text-muted-foreground">{i + 1}</span>
          <span className="text-xs text-muted-foreground">{s.label}</span>
        </span>
      ))}
      {steps.length > max && <span className="text-xs text-muted-foreground/60 ml-1">+{steps.length - max} more</span>}
    </span>
  );
}

export function VerticalStepper({ steps }: { steps: FunnelStep[] }) {
  return (
    <div className="flex flex-col py-1">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        return (
          <div key={i} className="flex gap-3 items-start">
            <div className="flex flex-col items-center">
              <span className={cn('size-6 rounded-full border flex items-center justify-center text-xs bg-card', last ? 'ring-2 ring-primary/40 text-primary' : 'text-muted-foreground')}>{i + 1}</span>
              {!last && <span className="w-px flex-1 min-h-4 bg-border" />}
            </div>
            <div className="pb-4">
              <div className="text-sm">{s.label}</div>
              <div className="text-xs text-muted-foreground/70">{s.metric_key}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}
export function fmtPct(n: number): string { return `${(n * 100).toFixed(1)}%`; }

/** Days → compact duration (tenure). */
export function fmtDur(days: number): string {
  if (days < 1) return '<1d';
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

/** ISO timestamp → relative recency ("3d ago"). */
export function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  if (d < 30) return `${Math.floor(d)}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function daysBetween(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Render an arbitrary property value for a table/KV cell. */
export function fmtVal(v: unknown): string {
  if (v === undefined || v === null) return '·';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
