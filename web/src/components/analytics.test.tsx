import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalAnswer } from './analytics';

describe('CanonicalAnswer', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('keeps the answer, comparison, trust and purpose before the chart and provenance in Evidence', () => {
    render(
      <CanonicalAnswer
        takeaway="Weekly active users rose by 12%."
        comparison="Previous exact period"
        trust="trusted"
        eventCount={34}
        env="prod"
        purpose="Count people who reach a meaningful product outcome."
        followUp="Break this movement down by one trusted property."
        followUpTask="Investigate one trusted property."
        saveState="idle"
        onSave={vi.fn()}
        chart={<div role="img" aria-label="Canonical chart">Chart</div>}
        evidence={<p>Aggregation: unique actors. Source: registered metric.</p>}
      />,
    );

    const answer = screen.getByRole('region', { name: 'Canonical answer' });
    const takeaway = within(answer).getByText('Weekly active users rose by 12%.');
    const comparison = within(answer).getByText('Previous exact period');
    const trust = within(answer).getByText(/Observed · Trusted · 34 events ·/);
    const purpose = within(answer).getByText(/Count people who reach a meaningful product outcome/);
    const chart = within(answer).getByRole('img', { name: 'Canonical chart' });
    for (const beforeChart of [takeaway, comparison, trust, purpose]) {
      expect(beforeChart.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(answer).getByText(/Aggregation: unique actors/)).not.toBeVisible();
    fireEvent.click(within(answer).getByText('Evidence'));
    expect(within(answer).getByText(/Aggregation: unique actors/)).toBeVisible();
    expect(within(answer).getByText(/Next question: Break this movement down/)).toBeInTheDocument();
    expect(within(answer).getByRole('button', { name: 'Copy follow-up task' })).toBeInTheDocument();
  });
});
