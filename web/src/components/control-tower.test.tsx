import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ControlTower } from './control-tower';
import type { ControlTowerResult } from '../api/types';

const result: ControlTowerResult = {
  schema_version: 1,
  request_id: 'request-1',
  generated_at: '2026-08-11T10:00:00.000Z',
  scope: {
    project_slug: 'alpha',
    environment: 'prod',
    window: { from: '2026-07-12T10:00:00.000Z', to: '2026-08-11T10:00:00.000Z', timezone: 'UTC' },
  },
  answer: {
    state: 'partial',
    headline: '2 items need attention',
    takeaway: 'Rejected events are losing evidence.',
    primary_value: { value: 2, unit: 'count', formatted: '2' },
    why_it_matters: 'Missing evidence weakens product answers.',
  },
  attention: [{
    id: 'ingest.rejected',
    rule_id: 'ingest.rejected',
    rule_version: 1,
    severity: 'high',
    state: 'open',
    title: 'Rejected observations',
    reason: 'Two observations were rejected.',
    impact: 'They are absent from answers.',
    affected: [{ kind: 'project', ref: 'alpha:prod' }],
    evidence: {
      state: 'blocked',
      as_of: '2026-08-11T10:00:00.000Z',
      freshness: 'fresh',
      source_refs: [{ kind: 'operator_rule', rule_id: 'ingest.rejected', rule_version: 1 }],
      warnings: [],
      unavailable_reasons: [],
    },
    primary_action: { id: 'review_ingest_rejected', kind: 'navigate', label: 'Review ingest warnings', href: '/events' },
  }],
  evidence: {
    state: 'blocked',
    as_of: '2026-08-11T10:00:00.000Z',
    freshness: 'fresh',
    source_refs: [{ kind: 'operator_rule', rule_id: 'ingest.warnings', rule_version: 1 }],
    warnings: [{ code: 'clock_skew', message: 'One clock-skew warning remains.' }],
    unavailable_reasons: [],
  },
  primary_action: { id: 'review_ingest_rejected', kind: 'navigate', label: 'Review ingest warnings', href: '/events' },
  secondary_actions: [],
};

describe('ControlTower', () => {
  it('renders the answer first, exposes attention evidence and delegates server-owned actions', () => {
    const onAction = vi.fn();
    render(<ControlTower result={result} onAction={onAction} />);

    expect(screen.getByRole('heading', { name: '2 items need attention' })).toBeInTheDocument();
    expect(screen.getByText('Rejected observations')).toBeInTheDocument();
    expect(screen.getAllByText('Evidence and trust')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Review ingest warnings' })[0]!);
    expect(onAction).toHaveBeenCalledWith(result.primary_action);
  });

  it('uses accessible status semantics without hiding unavailable evidence', () => {
    render(<ControlTower result={{
      ...result,
      answer: { ...result.answer, state: 'unavailable', headline: 'Answer unavailable' },
      evidence: { ...result.evidence, state: 'unavailable', unavailable_reasons: [{ code: 'missing_denominator', message: 'Metric denominator is unavailable.' }] },
    }} onAction={() => {}} />);

    expect(screen.getByRole('status')).toHaveTextContent('Answer unavailable');
    expect(screen.getByText('Metric denominator is unavailable.')).toBeInTheDocument();
  });
});
