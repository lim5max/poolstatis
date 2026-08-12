import { useState, type ReactNode } from 'react';
import { Check, CircleIcon, Copy } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DisclosureSummary } from './disclosure';
import { Panel } from './ui';

export interface ReadinessCheck {
  label: string;
  ready: boolean;
  detail: string;
}

export function GuidedFirstValue({
  title,
  outcome,
  checks,
  action,
  agentTask,
  referenceTitle,
  referenceItems,
  referenceSource,
}: {
  title: string;
  outcome: string;
  checks: ReadinessCheck[];
  action: ReactNode;
  agentTask?: string;
  referenceTitle: string;
  referenceItems: string[];
  referenceSource?: { label: string; href: string };
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const ready = checks.filter((check) => check.ready).length;

  const copyTask = async () => {
    if (!agentTask) return;
    try {
      await navigator.clipboard.writeText(agentTask);
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <Panel
      title={title}
      right={<Badge variant={ready === checks.length ? 'default' : 'outline'}>{ready}/{checks.length} ready</Badge>}
    >
      <div className="min-w-0">
        <p className="max-w-2xl text-sm text-muted-foreground">{outcome}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {action}
          {agentTask && (
            <Button variant="outline" onClick={() => void copyTask()}>
              {copied ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
              {copied ? 'Task copied' : 'Copy agent task'}
            </Button>
          )}
        </div>
        {copyFailed && <p className="mt-2 text-sm text-destructive" role="alert">Clipboard access was blocked. Allow it and try again.</p>}
      </div>
      <details className="mt-4 border-t">
        <DisclosureSummary className="flex min-h-12 cursor-pointer items-center text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Readiness details and example
        </DisclosureSummary>
        <div className="grid gap-5 border-t pt-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
          <ol className="space-y-3" aria-label={`${title} prerequisites`}>
            {checks.map((check) => (
              <li key={check.label} className="flex items-start gap-3">
                {check.ready
                  ? <Check className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                  : <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div className="min-w-0">
                  <div className="text-sm font-medium">{check.label}</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">{check.detail}</div>
                </div>
              </li>
            ))}
          </ol>
          <aside className="rounded-panel border bg-muted/20 p-4" aria-label={referenceTitle}>
            <div className="text-sm font-medium">{referenceTitle}</div>
            {referenceSource && (
              <p className="mt-1 text-xs text-muted-foreground">
                Illustrative reference ·{' '}
                <a
                  className="font-medium text-foreground underline decoration-border underline-offset-4"
                  href={referenceSource.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {referenceSource.label}
                </a>
              </p>
            )}
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              {referenceItems.map((item) => <li key={item}>— {item}</li>)}
            </ul>
            <p className="mt-4 border-t pt-3 text-sm text-muted-foreground">Example only. Real values appear after server evidence is available.</p>
          </aside>
        </div>
      </details>
    </Panel>
  );
}
