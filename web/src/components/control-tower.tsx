import type { ControlTowerAction, ControlTowerResult, EvidenceBlock } from '../api/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Panel } from './ui';
import { DisclosureSummary } from './disclosure';

function sourceRefLabel(source: EvidenceBlock['source_refs'][number]): string {
  switch (source.kind) {
    case 'metric': return `${source.key} — ${source.purpose}`;
    case 'funnel': return `${source.key} — ${source.goal}`;
    case 'release': return `Release ${source.id}`;
    case 'experiment': return `Experiment ${source.key}`;
    case 'usage_ledger': return `Usage ledger — ${source.meter}`;
    case 'operator_rule': return `Rule ${source.rule_id} v${source.rule_version}`;
  }
}

export function Evidence({ evidence }: { evidence: EvidenceBlock }) {
  const coverage = evidence.sample?.coverage;
  return (
    <details className="rounded-md border px-4 py-3 text-sm">
      <DisclosureSummary className="cursor-pointer font-medium">
        Evidence and trust
        <span className="ml-2 font-normal text-muted-foreground">{evidence.freshness} · {evidence.state}</span>
      </DisclosureSummary>
      <div className="mt-3 space-y-2 text-muted-foreground">
        <p>Trust: <span className="text-foreground">{evidence.state}</span></p>
        <p>Freshness: <span className="text-foreground">{evidence.freshness}</span></p>
        <p>As of: <time dateTime={evidence.as_of}>{evidence.as_of}</time></p>
        {evidence.source_refs.length > 0 && (
          <div>
            <p>Sources:</p>
            <ul className="mt-1 space-y-1 pl-5">
              {evidence.source_refs.map((source, index) => (
                <li key={`${source.kind}:${index}`} className="list-disc">{sourceRefLabel(source)}</li>
              ))}
            </ul>
          </div>
        )}
        {evidence.aggregation && <p>{evidence.aggregation}</p>}
        {evidence.denominator && (
          <p>Denominator: {evidence.denominator.label} — {evidence.denominator.value ?? 'unavailable'}</p>
        )}
        {evidence.sample && (
          <p>
            Sample: {evidence.sample.observed ?? 'unavailable'} observed of {evidence.sample.eligible ?? 'unavailable'} eligible
            {coverage == null ? '' : ` · ${(coverage * 100).toFixed(1)}% coverage`}
          </p>
        )}
        {evidence.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}
        {evidence.unavailable_reasons.map((reason) => <p key={reason.code}>{reason.message}</p>)}
        {evidence.reproducible_query && (
          <p className="break-words">
            Reproducible query: <code className="font-mono text-xs text-foreground">{JSON.stringify(evidence.reproducible_query)}</code>
          </p>
        )}
      </div>
    </details>
  );
}

function ActionButton({ action, onAction, variant = 'default', accessibleLabel }: {
  action: ControlTowerAction;
  onAction: (action: ControlTowerAction) => void;
  variant?: 'default' | 'outline';
  accessibleLabel?: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      aria-label={accessibleLabel}
      onClick={() => onAction(action)}
    >
      {action.label}
    </Button>
  );
}

export function ControlTower({ result, onAction }: {
  result: ControlTowerResult;
  onAction: (action: ControlTowerAction) => void;
}) {
  return (
    <section aria-label="Control tower" className="space-y-4">
      <div role="status" aria-live="polite">
        <Panel>
          <div className="space-y-4">
            <div className="space-y-2">
              <Badge variant="outline">{result.answer.state.replace('_', ' ')}</Badge>
              <h2 className="serif text-2xl">{result.answer.headline}</h2>
              <p className="text-sm text-muted-foreground">{result.answer.takeaway}</p>
              {result.answer.delta && (
                <p className="text-sm">
                  {result.answer.delta.value === null ? 'Comparison unavailable' : `${result.answer.delta.value > 0 ? '+' : ''}${result.answer.delta.value}`}
                  {' '}{result.answer.delta.unit.replace('_', ' ')} · {result.answer.delta.comparison_label}
                </p>
              )}
              <p className="text-sm">{result.answer.why_it_matters}</p>
            </div>
            <ActionButton action={result.primary_action} onAction={onAction} />
          </div>
        </Panel>
      </div>

      {result.attention.length > 0 && (
        <Panel title="Attention">
          <div className="space-y-3">
            {result.attention.map((item) => (
              <article key={item.id} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{item.title}</h3>
                  <Badge variant={item.severity === 'critical' || item.severity === 'high' ? 'destructive' : 'secondary'}>
                    {item.severity}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{item.reason}</p>
                <p className="text-sm">{item.impact}</p>
                <Evidence evidence={item.evidence} />
                <ActionButton
                  action={item.primary_action}
                  onAction={onAction}
                  variant="outline"
                  accessibleLabel="Review this attention item"
                />
              </article>
            ))}
          </div>
        </Panel>
      )}

      <Evidence evidence={result.evidence} />
    </section>
  );
}
