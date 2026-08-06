import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useStore } from '../store';
import { Measurement } from './Measurement';

vi.mock('../store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store')>()),
  useStore: vi.fn(),
}));

const mockedStore = vi.mocked(useStore);

describe('Definitions surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStore.mockReturnValue({
      project: 'alpha', env: 'prod',
      client: {
        properties: vi.fn().mockResolvedValue([]),
        actorLinks: vi.fn().mockResolvedValue({ links: [], audit: [] }),
        sources: vi.fn().mockResolvedValue([]),
        metrics: vi.fn().mockResolvedValue([]),
        contracts: vi.fn().mockResolvedValue([]),
      },
    } as never);
  });

  it('starts with four compact definition rows and progressive technical detail', async () => {
    render(<TooltipProvider><MemoryRouter><Measurement /></MemoryRouter></TooltipProvider>);

    expect(await screen.findByRole('heading', { name: 'Definitions', level: 1 })).toBeInTheDocument();
    for (const label of ['Tracking plan', 'Properties', 'Identity', 'Data sources']) {
      expect(screen.getByText(label, { selector: 'span' }).closest('details')).not.toHaveAttribute('open');
    }
    expect(screen.getByText('Advanced web reporting').closest('details')).not.toHaveAttribute('open');
  });
});
