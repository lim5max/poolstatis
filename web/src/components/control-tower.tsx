import type { ControlTowerAction, ControlTowerResult, EvidenceBlock } from '../api/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Panel } from './ui';
import { DisclosureSummary } from './disclosure';

function Evidence({ evidence }: { evidence: EvidenceBlock }) {
  return (
    <details className="rounded-md border px-4 py-3 text-sm">
      <DisclosureSummary className="cursor-pointer font-medium">Evidence and trust</DisclosureSummary>
      <div className="mt-3 space-y-2 text-muted-foreground">
        <p>Trust: <span className="text-foreground">{evidence.state}</span></p>
        <p>As of: <time dateTime={evidence.as_of}>{evidence.as_of}</time></p>
        {evidence.aggregation && <p>{evidence.aggregation}</p>}
        {evidence.denominator && (
          <p>Denominator: {evidence.denominator.label} — {evidence.denominator.value ?? 'unavailable'}</p>
        )}
        {evidence.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}
        {evidence.unavailable_reasons.map((reason) => <p key={reason.code}>{reason.message}</p>)}
      </div>
    </details>
  );
}

function ActionButton({ action, onAction }: {
  action: ControlTowerAction;
  onAction: (action: ControlTowerAction) => void;
}) {
  return <Button type="button" onClick={() => onAction(action)}>{action.label}</Button>;
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
                <ActionButton action={item.primary_action} onAction={onAction} />
              </article>
            ))}
          </div>
        </Panel>
      )}

      <Evidence evidence={result.evidence} />
    </section>
  );
}
