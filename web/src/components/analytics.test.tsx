import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalAnswer, EvidenceLine } from './analytics';

describe('CanonicalAnswer', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('keeps one answer and one next step above the chart and moves supporting context into Details', () => {
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
    const next = within(answer).getByText(/Next: Break this movement down/);
    const chart = within(answer).getByRole('img', { name: 'Canonical chart' });
    for (const beforeChart of [takeaway, next]) {
      expect(beforeChart.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(answer).queryByText('Takeaway')).not.toBeInTheDocument();
    expect(within(answer).getByText('Trusted')).toBeInTheDocument();
    expect(within(answer).getByText('Previous exact period')).not.toBeVisible();
    expect(within(answer).getByText(/Count people who reach a meaningful product outcome/)).not.toBeVisible();
    expect(within(answer).getByText(/Observed · Trusted · 34 events ·/)).not.toBeVisible();
    expect(within(answer).getByText(/Aggregation: unique actors/)).not.toBeVisible();
    fireEvent.click(within(answer).getByText('Details'));
    expect(within(answer).getByText(/Aggregation: unique actors/)).toBeVisible();
    expect(within(answer).getByText('Previous exact period')).toBeVisible();
    expect(within(answer).getByText(/Count people who reach a meaningful product outcome/)).toBeVisible();
    expect(within(answer).getByRole('button', { name: 'Copy follow-up task' })).toBeInTheDocument();
  });

  it('keeps blocked evidence distinct from partial and unavailable states', () => {
    render(<EvidenceLine trust="blocked" eventCount={12} env="prod" />);

    expect(screen.getByText(/Observed · Blocked · 12 events ·/)).toBeInTheDocument();
  });
});
