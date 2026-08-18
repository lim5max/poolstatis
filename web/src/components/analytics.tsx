import { useState, type ReactNode } from 'react';
import { Loader2 } from '@/components/icons';
import { DisclosureSummary } from '@/components/disclosure';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type EvidenceTrust = 'trusted' | 'partial' | 'blocked' | 'unavailable';

function evidenceTrustLabel(trust: EvidenceTrust) {
  if (trust === 'trusted') return 'Trusted';
  if (trust === 'partial') return 'Partial';
  if (trust === 'blocked') return 'Blocked';
  return 'Unavailable';
}

export function EvidenceLine({
  trust,
  eventCount,
  env,
  children,
  className,
}: {
  trust: EvidenceTrust;
  eventCount: number | null;
  env: string;
  children?: ReactNode;
  className?: string;
}) {
  const line = (
    <span className="inline-flex min-h-11 max-w-full items-center gap-2 text-xs text-muted-foreground md:min-h-8">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          trust === 'trusted' ? 'bg-success' : trust === 'partial' ? 'bg-warning' : trust === 'blocked' ? 'bg-destructive' : 'bg-muted-foreground/60',
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">
        Observed · {evidenceTrustLabel(trust)} · {eventCount === null ? 'event count unavailable' : `${eventCount.toLocaleString()} events`} · <code>{env}</code>
      </span>
    </span>
  );

  if (!children) return <div className={className}>{line}</div>;
  return (
    <details className={cn('group/disclosure', className)}>
      <DisclosureSummary className="w-fit max-w-full cursor-pointer rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {line}
        <span className="ml-4 text-xs font-medium text-foreground underline decoration-border underline-offset-4 group-open/disclosure:hidden">How this is calculated</span>
      </DisclosureSummary>
      <div className="mt-2 max-w-3xl border-l pl-4 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

export interface KpiItem {
  label: string;
  value: ReactNode | null;
  fallback?: ReactNode;
  note?: string;
}

export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-panel border bg-card lg:grid-cols-4" aria-label="Key outcomes" role="group">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-b p-4 even:border-l lg:border-b-0 lg:border-l lg:first:border-l-0">
          <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className={cn('mt-1 text-2xl font-semibold tabular-nums sm:text-3xl', item.value === null && 'text-muted-foreground')}>
            {item.value ?? item.fallback ?? 'Unavailable'}
          </dd>
          {item.note && <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>}
        </div>
      ))}
    </dl>
  );
}

export function RankedRows({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: ReactNode; note?: string }>;
  empty: ReactNode;
}) {
  return (
    <section aria-labelledby={`${title.replaceAll(' ', '-').toLowerCase()}-title`}>
      <h2 id={`${title.replaceAll(' ', '-').toLowerCase()}-title`} className="text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? <div className="mt-3 text-sm text-muted-foreground">{empty}</div> : (
        <ol className="mt-2 divide-y">
          {rows.map((row, index) => (
            <li key={row.key} className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-2 py-3">
              <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 truncate text-sm" title={row.label}>{row.label}</span>
              <span className="text-right font-mono text-sm tabular-nums">{row.value}</span>
              {row.note && <span className="col-start-2 col-end-4 text-xs text-muted-foreground">{row.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function AnswerCanvas({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('overflow-hidden rounded-dialog border bg-card', className)}>{children}</section>;
}

export function CanonicalAnswer({
  takeaway,
  comparison,
  trust,
  eventCount,
  env,
  purpose,
  followUp,
  followUpTask,
  saveState,
  saveDisabled = false,
  officialSaveState = 'hidden',
  saveVariant = 'default',
  onSave,
  onSaveOfficial,
  chart,
  evidence,
}: {
  takeaway: string;
  comparison: string;
  trust: EvidenceTrust;
  eventCount: number | null;
  env: string;
  purpose: string;
  followUp: string;
  followUpTask: string;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  saveDisabled?: boolean;
  officialSaveState?: 'hidden' | 'idle' | 'saving' | 'saved' | 'saved_unofficial' | 'error';
  saveVariant?: 'default' | 'outline';
  onSave: () => void;
  onSaveOfficial?: () => void;
  chart: ReactNode;
  evidence: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const copyTask = async () => {
    try {
      await navigator.clipboard.writeText(followUpTask);
      setCopied(true);
      setManualCopy(false);
    } catch {
      setManualCopy(true);
    }
  };
  return (
    <AnswerCanvas className="border-l-4 border-l-primary">
      <section aria-label="Canonical answer">
        <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:p-5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-muted-foreground">Takeaway</div>
            <p className="mt-1 text-lg font-semibold leading-snug">{takeaway}</p>
            <p className="mt-3 text-sm"><span className="font-medium">Purpose:</span> <span className="text-muted-foreground">{purpose}</span></p>
            <p className="mt-2 text-sm text-muted-foreground">
              Observed · {evidenceTrustLabel(trust)} · {eventCount === null ? 'event count unavailable' : `${eventCount.toLocaleString()} events`} · <code>{env}</code>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Next question: {followUp}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {officialSaveState !== 'hidden' && onSaveOfficial ? (
                <Button
                  type="button"
                  className="h-11"
                  onClick={onSaveOfficial}
                  disabled={saveDisabled || saveState === 'saving' || officialSaveState === 'saving' || officialSaveState === 'saved'}
                >
                  {officialSaveState === 'saving' ? <Loader2 className="size-4 animate-spin" /> : null}
                  {officialSaveState === 'saved'
                    ? 'Official answer saved'
                    : officialSaveState === 'saving'
                      ? 'Saving official answer…'
                      : officialSaveState === 'saved_unofficial'
                        ? 'Retry official status'
                        : 'Save as official'}
                </Button>
              ) : null}
              <Button type="button" variant={officialSaveState === 'hidden' ? saveVariant : 'outline'} className="h-11" onClick={onSave} disabled={saveDisabled || saveState === 'saving' || saveState === 'saved' || officialSaveState === 'saving'}>
                {saveState === 'saving' ? <Loader2 className="size-4 animate-spin" /> : null}
                {saveState === 'saved' ? 'Answer saved' : saveState === 'saving' ? 'Saving answer…' : 'Save answer'}
              </Button>
              <Button type="button" variant="outline" className="h-11" onClick={() => void copyTask()}>
                {copied ? 'Follow-up task copied' : 'Copy follow-up task'}
              </Button>
            </div>
            {saveState === 'error' && <p role="alert" className="mt-2 text-sm text-destructive">The answer could not be saved. Check access and try again.</p>}
            {officialSaveState === 'saved_unofficial' && <p role="alert" className="mt-2 text-sm text-destructive">The answer was saved, but official status was not applied. Retry after checking owner or admin access.</p>}
            {officialSaveState === 'error' && saveState !== 'error' && <p role="alert" className="mt-2 text-sm text-destructive">Official status could not be applied. Check owner or admin access and try again.</p>}
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Badge variant={trust === 'trusted' ? 'default' : trust === 'blocked' ? 'destructive' : 'outline'}>
              {trust === 'trusted' ? 'Trusted evidence' : trust === 'partial' ? 'Partial evidence' : trust === 'blocked' ? 'Blocked evidence' : 'Evidence unavailable'}
            </Badge>
            <Badge variant="outline">{comparison}</Badge>
          </div>
        </div>
        <div className="border-t">{chart}</div>
        <details className="border-t">
          <DisclosureSummary className="flex min-h-11 cursor-pointer items-center px-4 py-3 text-sm font-medium sm:px-5">
            Evidence
          </DisclosureSummary>
          <div className="border-t px-4 py-3 text-sm leading-relaxed text-muted-foreground sm:px-5">{evidence}</div>
        </details>
        {manualCopy && (
          <div className="border-t p-4 sm:p-5">
            <p role="alert" className="mb-2 text-sm text-muted-foreground">Clipboard access was blocked. Copy the prepared follow-up task manually.</p>
            <pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap rounded-panel border bg-background p-4 text-sm">{followUpTask}</pre>
          </div>
        )}
      </section>
    </AnswerCanvas>
  );
}
