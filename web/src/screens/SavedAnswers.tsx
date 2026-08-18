import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Confirm, EmptyState, ErrorNote, Loading, PageHeading, Panel, fmtRelative } from '@/components/ui';
import { DisclosureSummary } from '@/components/disclosure';
import type { SavedAnswer } from '../api/types';
import { useAsync, useStore } from '../store';
import { accountMutationAccess, mutationAllowed } from '../account-capabilities';

type SavedAnswerFilter = 'active' | 'archived' | 'official';

export function SavedAnswers() {
  const { client, project, env } = useStore();
  const [searchParams] = useSearchParams();
  const focusedAnswer = searchParams.get('answer');
  const [filter, setFilter] = useState<SavedAnswerFilter>('active');
  const [archiveTarget, setArchiveTarget] = useState<SavedAnswer | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const accountMode = useAsync(
    () => client!.accountMode(),
    [client],
  );
  const officialAccess = accountMutationAccess(
    accountMode.data,
    'set_official_answers',
    accountMode.loading,
    accountMode.error,
  );
  const officialAllowed = mutationAllowed(officialAccess);
  const saved = useAsync(
    () => client!.analysisViews(project!, {
      env,
      status: filter === 'archived' ? 'archived' : 'active',
      ...(filter === 'official' ? { official: true } : {}),
    }),
    [project, env, filter],
  );
  useEffect(() => {
    if (saved.loading || !focusedAnswer) return;
    const card = document.getElementById(`saved-answer-${encodeURIComponent(focusedAnswer)}`);
    if (!card) return;
    card.focus();
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center' });
  }, [focusedAnswer, saved.loading, saved.data]);

  const changeOfficial = async (answer: SavedAnswer) => {
    if (!client || !project || !officialAllowed) return;
    setMutationError(null);
    try {
      await client.setAnalysisViewOfficial(project, answer.id, !answer.official);
      saved.reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Official status could not be changed.');
    }
  };

  const archive = async () => {
    if (!client || !project || !archiveTarget) return;
    setMutationError(null);
    try {
      await client.archiveAnalysisView(project, archiveTarget.id);
      setArchiveTarget(null);
      saved.reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'Saved answer could not be archived.');
    }
  };

  if (!client || !project) return <EmptyState headline="Choose a project" lead="Saved answers are scoped to one project and environment." />;

  return (
    <div className="space-y-5">
      <PageHeading
        title="Saved answers"
        lead="Validated answers, ready to reopen."
        help="Official answers are workspace-approved. Other saved answers remain personal working views with their original evidence snapshot."
      />

      <div className="flex flex-wrap gap-2" aria-label="Saved answer filters">
        {([
          ['active', 'Active'],
          ['official', 'Official'],
          ['archived', 'Archived'],
        ] as const).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? 'default' : 'outline'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      {mutationError && <ErrorNote>{mutationError}</ErrorNote>}
      {saved.loading && <Loading what="Reading saved answers…" />}
      {saved.error && <ErrorNote>{saved.error}</ErrorNote>}
      {!saved.loading && !saved.error && saved.data?.length === 0 && (
        <Panel>
          <EmptyState
            headline={filter === 'archived' ? 'No archived answers' : 'No saved answers yet'}
            lead="Run a registry-backed Product or Funnel answer, then save the validated evidence snapshot."
          />
        </Panel>
      )}
      {!saved.loading && !saved.error && saved.data && saved.data.length > 0 && (
        <Panel>
          <div role="list" aria-label="Saved answers" className="-m-5 divide-y">
            {saved.data.map((answer) => (
              <SavedAnswerCard
                key={answer.id}
                answer={answer}
                focused={answer.id === focusedAnswer}
                officialAllowed={officialAllowed}
                onOfficial={() => changeOfficial(answer)}
                onArchive={() => setArchiveTarget(answer)}
              />
            ))}
          </div>
        </Panel>
      )}

      {archiveTarget && (
        <Confirm
          title="Archive saved answer"
          body={<>This removes official status and keeps the validated answer plus append-only audit available for read-back.</>}
          error={mutationError ?? undefined}
          confirmLabel="Archive answer"
          tone="warn"
          onConfirm={archive}
          onCancel={() => setArchiveTarget(null)}
        />
      )}
    </div>
  );
}

export function SavedAnswerCard({
  answer,
  focused = false,
  officialAllowed,
  onOfficial,
  onArchive,
}: {
  answer: SavedAnswer;
  focused?: boolean;
  officialAllowed: boolean;
  onOfficial: () => void;
  onArchive: () => void;
}) {
  const trustLabel = answer.evidence.state === 'trusted'
    ? 'Trusted evidence'
    : `${answer.evidence.state.replaceAll('_', ' ')} evidence`;
  return (
    <article
      role="listitem"
      id={`saved-answer-${encodeURIComponent(answer.id)}`}
      data-testid={`saved-answer-${answer.id}`}
      data-focused={focused ? 'true' : 'false'}
      tabIndex={focused ? -1 : undefined}
      className={`p-5 outline-none ${focused ? 'relative z-10 rounded-panel ring-2 ring-ring ring-offset-2' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="serif text-2xl font-normal">{answer.title}</h2>
        {answer.official ? <Badge>Official</Badge> : <Badge variant="outline">Saved</Badge>}
      </div>
      <div className="space-y-4">
        <div className="mt-3">
          <p className="text-sm font-medium">{answer.answer.headline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{answer.answer.takeaway}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-normal">{trustLabel}</Badge>
          <span>{answer.evidence.freshness}</span>
          <code>{answer.env}</code>
          <span>Updated {fmtRelative(answer.updated_at)}</span>
        </div>
        <details className="rounded-control border bg-muted/10 px-4 py-2">
          <DisclosureSummary className="cursor-pointer text-sm font-medium">Evidence and provenance</DisclosureSummary>
          <div className="mt-2 space-y-1 text-sm text-muted-foreground">
            <p>Schema v{answer.schema_version} · {answer.visualization_spec.kind.replaceAll('_', ' ')}</p>
            <p>As of {new Date(answer.evidence.as_of).toLocaleString()}</p>
            <p>{answer.answer.why_it_matters}</p>
            {answer.description && <p>{answer.description}</p>}
          </div>
        </details>
        {answer.status === 'active' && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            {officialAllowed ? (
              <Button type="button" size="sm" variant="outline" onClick={onOfficial}>
                {answer.official ? 'Remove official status' : 'Mark official'}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Only a workspace owner or admin can change official status.</p>
            )}
            <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onArchive}>
              Archive saved answer
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
