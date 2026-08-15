import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '@/store';
import type { ReplaySessionSummary } from '@/api/types';
import { ReplayPanel } from './ReplayPanel';

vi.mock('@/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store')>()),
  useStore: vi.fn(),
}));
vi.mock('@rrweb/replay', () => ({
  Replayer: class {
    iframe = document.createElement('iframe');
    constructor(_events: unknown[], config: { root: Element }) {
      const wrapper = document.createElement('div');
      wrapper.className = 'replayer-wrapper';
      const mouse = document.createElement('div');
      mouse.className = 'replayer-mouse';
      this.iframe.setAttribute('sandbox', 'allow-same-origin');
      wrapper.append(mouse, this.iframe);
      config.root.appendChild(wrapper);
    }
    disableInteract() {}
    destroy() { this.iframe.parentElement?.remove(); }
    play() {}
    pause() {}
    setConfig() {}
  },
}));

const mockedStore = vi.mocked(useStore);
const replay: ReplaySessionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  surface: 'workspace', route: 'workspace', env: 'prod', session_id: 'session-1', distinct_id: 'actor-1',
  host: 'app.example.test', version: 'release-1', device: 'desktop', consent_version: 'consent-v1',
  policy_version: 'privacy-v1', text_mode: 'masked', status: 'playable', chunk_count: 1,
  event_count: 2, byte_size: 200, started_at: '2026-08-15T10:00:00.000Z',
  completed_at: '2026-08-15T10:01:00.000Z', delete_after: '2026-08-22T10:00:00.000Z',
  viewer_path: '/experience?replay=11111111-1111-4111-8111-111111111111&env=prod',
};

function store(client: Record<string, unknown>) {
  return { client, project: 'alpha', env: 'prod' } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState({}, '', '/experience');
});

describe('Session replay admin panel', () => {
  it('renders loading and then the explicit opt-in empty state', async () => {
    let release!: (value: ReplaySessionSummary[]) => void;
    mockedStore.mockReturnValue(store({
      sessionReplays: vi.fn(() => new Promise<ReplaySessionSummary[]>((resolve) => { release = resolve; })),
    }));
    render(<ReplayPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading session replays');
    release([]);
    expect(await screen.findByText('No consented replays yet')).toBeInTheDocument();
  });

  it('surfaces a recoverable list error', async () => {
    mockedStore.mockReturnValue(store({ sessionReplays: vi.fn().mockRejectedValue(new Error('storage offline')) }));
    render(<ReplayPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('storage offline');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('keeps incomplete manifests visible but not playable', async () => {
    mockedStore.mockReturnValue(store({
      sessionReplays: vi.fn().mockResolvedValue([{ ...replay, status: 'incomplete' }]),
    }));
    render(<ReplayPanel />);
    expect(await screen.findByText('incomplete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch' })).toBeDisabled();
  });

  it('loads playable events only on demand into rrweb’s exact scriptless sandbox', async () => {
    const sessionReplayEvents = vi.fn().mockResolvedValue({
      replay,
      events: [
        { type: 4, timestamp: 100, data: { href: 'https://replay.invalid/workspace', width: 1280, height: 720 } },
        { type: 2, timestamp: 101, data: { node: { type: 0, childNodes: [] } } },
      ],
    });
    mockedStore.mockReturnValue(store({
      sessionReplays: vi.fn().mockResolvedValue([replay]),
      sessionReplayEvents,
    }));
    render(<ReplayPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(sessionReplayEvents).toHaveBeenCalledWith('alpha', replay.id, 'prod'));
    const frame = await screen.findByTitle(`Session replay content ${replay.id}`);
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
  });
});
