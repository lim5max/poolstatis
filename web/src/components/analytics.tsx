import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EvidenceTrust = 'trusted' | 'partial' | 'unavailable';

function evidenceTrustLabel(trust: EvidenceTrust) {
  return trust === 'trusted' ? 'Trusted' : trust === 'partial' ? 'Partial' : 'Unavailable';
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
          trust === 'trusted' ? 'bg-success' : trust === 'partial' ? 'bg-warning' : 'bg-muted-foreground/60',
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
    <details className={cn('group', className)}>
      <summary className="w-fit max-w-full cursor-pointer list-none rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {line}
        <span className="ml-4 text-xs font-medium text-foreground underline decoration-border underline-offset-4 group-open:hidden">How this is calculated</span>
      </summary>
      <div className="mt-2 max-w-3xl border-l pl-4 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

export interface KpiItem {
  label: string;
  value: ReactNode | null;
  note?: string;
}

export function KpiStrip({ items }: { items: KpiItem[] }) {
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-panel border bg-card lg:grid-cols-4" aria-label="Key outcomes" role="group">
      {items.map((item) => (
        <div key={item.label} className="min-w-0 border-b p-4 even:border-l lg:border-b-0 lg:border-l lg:first:border-l-0">
          <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
          <dd className={cn('mt-1 text-2xl font-semibold tabular-nums sm:text-3xl', item.value === null && 'text-muted-foreground')}>
            {item.value ?? 'Unavailable'}
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
