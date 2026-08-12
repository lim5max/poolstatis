import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccountMode } from '../api/types';
import { useStore } from '../store';
import { SavedAnswers } from './SavedAnswers';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const analysisViews = vi.fn();
const archiveAnalysisView = vi.fn();
const setAnalysisViewOfficial = vi.fn();
const accountMode = vi.fn();

function selfHostMode(kind: 'secret' | 'personal'): AccountMode {
  const personal = kind === 'personal';
  return {
    schema_version: 1,
    deployment: { mode: 'self_host', hosted_account: 'not_configured' },
    session: { kind, scope: personal ? 'organization' : 'project', role: null },
    capabilities: {
      portfolio: personal ? 'available' : 'project_only',
      compare_projects: personal,
      manage_profile: false,
      manage_personal_tokens: false,
      review_decisions: personal,
      set_official_answers: personal,
    },
    primary_action: { id: 'open_local_setup', kind: 'navigate', label: 'Open local setup', href: '/setup' },
  };
}

const savedAnswer = {
  id: '61b9b73d-89c2-4a31-b2fd-09008920a282',
  project: 'alpha',
  env: 'prod',
  title: 'Activation completion',
  description: 'Weekly activation evidence.',
  template_key: 'product_health',
  schema_version: 1,
  visualization_spec: { schemaVersion: 1, kind: 'trend' },
  answer: {
    state: 'ready',
    headline: 'Activation is measurable',
    takeaway: '42 people completed activation in the selected window.',
    why_it_matters: 'Activation is the first protected product outcome.',
  },
  evidence: {
    state: 'trusted',
    as_of: '2026-08-08T00:00:00.000Z',
    freshness: 'fresh',
    source_refs: [],
    warnings: [],
    unavailable_reasons: [],
  },
  status: 'active',
  official: true,
  created_by: { kind: 'personal', role: null },
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T01:00:00.000Z',
  archived_at: null,
} as const;

function renderScreen() {
  return render(
    <TooltipProvider>
      <MemoryRouter><SavedAnswers /></MemoryRouter>
    </TooltipProvider>,
  );
}

describe('SavedAnswers route-ready screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analysisViews.mockResolvedValue([savedAnswer]);
    archiveAnalysisView.mockResolvedValue({ ...savedAnswer, status: 'archived', official: false });
    setAnalysisViewOfficial.mockResolvedValue({ ...savedAnswer, official: false });
    accountMode.mockResolvedValue(selfHostMode('personal'));
    mockedStore.mockReturnValue({
      project: 'alpha',
      env: 'prod',
      tokenKind: 'personal',
      account: null,
      client: { analysisViews, archiveAnalysisView, setAnalysisViewOfficial, accountMode },
    } as never);
  });

  it('renders answer, trust and official state before audit detail', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Saved answers', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activation completion', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Official', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(screen.getByText('42 people completed activation in the selected window.')).toBeInTheDocument();
    expect(screen.getByText('Trusted evidence')).toBeInTheDocument();
    expect(screen.getByText('Evidence and provenance').closest('details')).not.toHaveAttribute('open');
    expect(analysisViews).toHaveBeenCalledWith('alpha', { env: 'prod', status: 'active' });
  });

  it('uses server mutations for official and archive actions, then reads the list back', async () => {
    renderScreen();
    await screen.findByText('Activation completion');

    fireEvent.click(screen.getByRole('button', { name: 'Remove official status' }));
    await waitFor(() => expect(setAnalysisViewOfficial).toHaveBeenCalledWith(
      'alpha', savedAnswer.id, false,
    ));
    await waitFor(() => expect(analysisViews).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Archive saved answer' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive saved answer' });
    expect(within(dialog).getByText(/removes official status/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive answer' }));
    await waitFor(() => expect(archiveAnalysisView).toHaveBeenCalledWith('alpha', savedAnswer.id));
    await waitFor(() => expect(analysisViews).toHaveBeenCalledTimes(3));
  });

  it('does not expose an official mutation to a project secret credential', async () => {
    accountMode.mockResolvedValueOnce(selfHostMode('secret'));
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod', tokenKind: 'secret', account: null,
      client: { analysisViews, archiveAnalysisView, setAnalysisViewOfficial, accountMode },
    } as never);
    renderScreen();
    await screen.findByText('Activation completion');
    expect(screen.queryByRole('button', { name: 'Remove official status' })).not.toBeInTheDocument();
    expect(screen.getByText('Only a workspace owner or admin can change official status.')).toBeInTheDocument();
  });

  it('focuses the exact answer requested by a downstream affected-answer link', async () => {
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/analyze/saved?answer=${savedAnswer.id}`]}><SavedAnswers /></MemoryRouter>
      </TooltipProvider>,
    );

    const focused = await screen.findByTestId(`saved-answer-${savedAnswer.id}`);
    await waitFor(() => expect(focused).toHaveFocus());
    expect(focused).toHaveAttribute('data-focused', 'true');
  });
});
