import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ControlTowerResult } from '../api/types';
import { ControlTower } from './control-tower';

function result(state: ControlTowerResult['answer']['state']): ControlTowerResult {
  const now = '2026-08-12T00:00:00.000Z';
  return {
    schema_version: 1,
    request_id: 'req-control-tower',
    generated_at: now,
    scope: { window: { from: now, to: now, timezone: 'UTC' } },
    answer: {
      state,
      headline: state === 'error' ? 'Answer failed' : 'Answer ready',
      takeaway: 'Current answer state.',
      why_it_matters: 'The status must be announced with the right urgency.',
    },
    attention: [],
    evidence: {
      state: state === 'error' ? 'unavailable' : 'trusted',
      as_of: now,
      freshness: 'fresh',
      source_refs: [],
      warnings: [],
      unavailable_reasons: [],
    },
    primary_action: { id: 'retry', kind: 'retry', label: 'Reload' },
    secondary_actions: [],
  };
}

describe('ControlTower announcements', () => {
  it('announces error answers as alerts', () => {
    render(<ControlTower result={result('error')} onAction={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps non-error answers polite', () => {
    render(<ControlTower result={result('ready')} onAction={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
