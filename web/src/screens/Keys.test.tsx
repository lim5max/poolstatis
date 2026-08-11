import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../components/ui/tooltip';
import { useStore } from '../store';
import { Keys } from './Keys';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);
const keys = vi.fn();
const personalTokens = vi.fn();
const issueKey = vi.fn();
const issuePersonalToken = vi.fn();
const revokeKey = vi.fn();
const revokePersonalToken = vi.fn();

function renderKeys() {
  return render(
    <TooltipProvider>
      <Keys />
    </TooltipProvider>,
  );
}

describe('Keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    keys.mockResolvedValue([
      {
        id: 'project-key-1',
        kind: 'secret',
        env: 'prod',
        label: 'Project MCP',
        masked_token: 'sk_...cafe',
        created_at: '2026-07-29T12:00:00.000Z',
        last_used_at: '2026-08-10T12:00:00.000Z',
        revoked_at: null,
      },
    ]);
    personalTokens.mockResolvedValue([
      {
        id: 'personal-key-1',
        label: 'Workspace MCP',
        token: 'pt_...beef',
        created_at: '2026-07-29T13:00:00.000Z',
        last_used_at: null,
        revoked_at: null,
      },
    ]);
    issueKey.mockResolvedValue({ id: 'new-project-key', token: 'sk_plaintext_once' });
    issuePersonalToken.mockResolvedValue({ id: 'new-personal-key', token: 'pt_plaintext_once' });
    revokeKey.mockResolvedValue({ revoked: true });
    revokePersonalToken.mockResolvedValue({ revoked: true });
    mockedStore.mockReturnValue({
      client: {
        keys,
        personalTokens,
        issueKey,
        issuePersonalToken,
        revokeKey,
        revokePersonalToken,
      },
      project: 'alpha',
      tokenKind: 'user',
    } as never);
  });

  it('combines project and personal key creation in one compact control', async () => {
    renderKeys();

    expect(await screen.findByRole('heading', { name: 'Create a key' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: /Create/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Ingest · pk_' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Ingest · pk_' })).toHaveClass('border-brand-strong', 'bg-primary/10');
    expect(screen.getByRole('button', { name: 'Project MCP · sk_' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workspace MCP · pt_' })).toBeInTheDocument();
  });

  it('issues a personal token and always reveals its plaintext once', async () => {
    renderKeys();
    await screen.findByText('sk_...cafe');

    fireEvent.click(screen.getByRole('button', { name: 'Workspace MCP · pt_' }));
    expect(screen.getByText('Every project in this workspace.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Codex account' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pt_ token' }));

    await waitFor(() => expect(issuePersonalToken).toHaveBeenCalledWith({ label: 'Codex account' }));
    const dialog = await screen.findByRole('dialog', { name: 'New workspace MCP token' });
    expect(within(dialog).getByText('pt_plaintext_once')).toBeInTheDocument();
    expect(personalTokens).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'I copied the token' }));
    await waitFor(() => expect(personalTokens).toHaveBeenCalledTimes(2));
  });

  it('keeps the one-time plaintext visible when refreshing the list fails', async () => {
    personalTokens
      .mockResolvedValueOnce([
        {
          id: 'personal-key-1',
          label: 'Workspace MCP',
          token: 'pt_...beef',
          created_at: '2026-07-29T13:00:00.000Z',
          last_used_at: null,
          revoked_at: null,
        },
      ])
      .mockRejectedValueOnce(new Error('refresh failed'));
    renderKeys();
    await screen.findByText('sk_...cafe');

    fireEvent.click(screen.getByRole('button', { name: 'Workspace MCP · pt_' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pt_ token' }));

    const dialog = await screen.findByRole('dialog', { name: 'New workspace MCP token' });
    expect(within(dialog).getByText('pt_plaintext_once')).toBeInTheDocument();
    expect(personalTokens).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByText('pt_plaintext_once')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'I copied the token' }));
    await waitFor(() => expect(personalTokens).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not refresh the key list: refresh failed',
    );
  });

  it('lists every key with its scope and opens safe details without pretending to recover it', async () => {
    renderKeys();

    const projectToken = await screen.findByRole('button', { name: 'View sk_...cafe details' });
    expect(screen.getByRole('button', { name: 'View pt_...beef details' })).toBeInTheDocument();
    expect(screen.getByText('alpha only')).toBeInTheDocument();
    expect(screen.getByText('All projects')).toBeInTheDocument();
    expect(screen.getByText('Credential health')).toBeInTheDocument();
    expect(screen.getByText(/Rotation is replacement-first/)).toBeInTheDocument();

    fireEvent.click(projectToken);
    const dialog = screen.getByRole('dialog', { name: 'Project MCP key' });
    expect(within(dialog).getByText('The full key cannot be shown again.')).toBeInTheDocument();
    expect(within(dialog).getByText('Poolstatis does not store its plaintext.')).toBeInTheDocument();
    expect(within(dialog).getByText('all')).toBeInTheDocument();
    expect(within(dialog).getByText(/Read and manage one project/)).toBeInTheDocument();
  });

  it('states the exact credential scope and immediate impact before revoke', async () => {
    renderKeys();

    const projectToken = await screen.findByRole('button', { name: 'View sk_...cafe details' });
    const row = projectToken.closest('tr');
    expect(row).not.toBeNull();
    const actions = within(row!).getByRole('button', { name: 'More actions' });
    actions.focus();
    fireEvent.keyDown(actions, { key: 'Enter', code: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke key' }));

    const dialog = screen.getByRole('dialog', { name: 'Revoke sk_...cafe?' });
    expect(dialog).toHaveTextContent('Scope: alpha only.');
    expect(dialog).toHaveTextContent('Read and manage one project; cannot access sibling projects.');
    expect(dialog).toHaveTextContent('Authentication with this key fails immediately');
  });

  it('does not offer an organization-wide personal token in a project-scoped session', async () => {
    mockedStore.mockReturnValue({
      client: { keys, issueKey, revokeKey },
      project: 'alpha',
      tokenKind: 'secret',
    } as never);
    renderKeys();

    await screen.findByText('sk_...cafe');
    expect(screen.queryByRole('button', { name: 'Workspace MCP · pt_' })).not.toBeInTheDocument();
    expect(personalTokens).not.toHaveBeenCalled();
  });

  it('gives legacy project keys a unique safe identifier', async () => {
    keys.mockResolvedValue([
      {
        id: '12345678-project-key',
        kind: 'secret',
        env: 'prod',
        label: null,
        masked_token: 'sk_...',
        created_at: '2026-07-29T12:00:00.000Z',
        revoked_at: null,
      },
    ]);
    renderKeys();

    expect(await screen.findByRole('button', {
      name: 'View sk_... · key 12345678 details',
    })).toBeInTheDocument();
  });

  it('never relabels keys from the previous project while switching projects', async () => {
    const view = renderKeys();
    expect(await screen.findByText('alpha only')).toBeInTheDocument();

    keys.mockImplementationOnce(() => new Promise(() => undefined));
    mockedStore.mockReturnValue({
      client: {
        keys,
        personalTokens,
        issueKey,
        issuePersonalToken,
        revokeKey,
        revokePersonalToken,
      },
      project: 'beta',
      tokenKind: 'user',
    } as never);
    view.rerender(
      <TooltipProvider>
        <Keys />
      </TooltipProvider>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('Reading keys…');
    expect(screen.queryByText('alpha only')).not.toBeInTheDocument();
    expect(screen.queryByText('beta only')).not.toBeInTheDocument();
  });

});
