import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ControlTowerView } from './ControlTower';

describe('route-ready control tower automation screen', () => {
  test('explains provider limits and keeps proposals human reviewed', () => {
    const onReview = vi.fn();
    render(<ControlTowerView data={{
      capabilities: { in_product: 'configured', outbox: 'configured', external: 'not_configured' },
      destinations: [{ id: 'd1', key: 'owner_inbox', name: 'Owner inbox', kind: 'in_product', status: 'active', created_at: '', updated_at: '' }],
      policies: [{
        id: 'm1', policy_key: 'activation_drop', name: 'Activation drop', current_version: 2,
        status: 'active', next_evaluation_at: '2026-08-11T12:00:00Z',
        revision: { metric_key: 'activation', env: 'prod', target_kind: 'project', target_id: null,
          comparison_rule: 'change_down_percent', threshold: 20,
          minimum_sample: 10, window_minutes: 1440, cadence_minutes: 60, cooldown_seconds: 3600,
          owner: 'growth', destination_ids: ['d1'], proposal_kind: 'pause', proposal_target: { flag_key: 'activation_rollout' }, version: 2 },
      }],
      schedules: [], findings: [], snapshots: [], inbox: [], deliveries: [],
      proposals: [{ id: 'p1', policy_id: 'm1', finding_id: 'f1', kind: 'pause', status: 'proposed', target: { flag_key: 'activation_rollout' },
        payload: { variants: [] }, undo: { variants: [] }, confirmation_fingerprint: 'a'.repeat(64),
        review_rationale: null, created_at: '2026-08-11T12:00:00Z' }],
    }} busy={false} error={null} reviewAccess="allowed" onReload={vi.fn()} onReview={onReview} onSetMonitorStatus={vi.fn()}
      onSetScheduleStatus={vi.fn()} onCreateDestination={vi.fn()} onCreateMonitor={vi.fn()} onCreateSchedule={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Control tower' })).toBeInTheDocument();
    expect(screen.getByText(/External delivery is not configured/i)).toBeInTheDocument();
    expect(screen.getByText('Activation drop')).toBeInTheDocument();
    expect(screen.getByText('Proposal ready for review')).toBeInTheDocument();
    expect(screen.getByText(/Frozen fingerprint/)).not.toBeVisible();
    fireEvent.change(screen.getByLabelText('Review rationale'), { target: { value: 'Reviewed frozen evidence and approved the existing mutation handoff.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve proposal' }));
    expect(onReview).toHaveBeenCalledWith('p1', 'approve', 'a'.repeat(64), 'Reviewed frozen evidence and approved the existing mutation handoff.');
  });

  test('keeps API-key sessions read-only and does not imply they can perform human review', () => {
    render(<ControlTowerView data={{
      capabilities: { in_product: 'configured', outbox: 'configured', external: 'not_configured' },
      destinations: [], policies: [], schedules: [], findings: [], snapshots: [], inbox: [], deliveries: [],
      proposals: [{ id: 'p1', policy_id: 'm1', finding_id: 'f1', kind: 'rollback', status: 'proposed', target: { flag_key: 'activation_rollout' },
        payload: { variants: [] }, undo: { variants: [] }, confirmation_fingerprint: 'b'.repeat(64),
        review_rationale: null, created_at: '2026-08-11T12:00:00Z' }],
    }} busy={false} error={null} reviewAccess="sign_in_required" onReload={vi.fn()} onReview={vi.fn()}
      onSetMonitorStatus={vi.fn()} onSetScheduleStatus={vi.fn()} onCreateDestination={vi.fn()}
      onCreateMonitor={vi.fn()} onCreateSchedule={vi.fn()} />);
    expect(screen.getByText(/API keys and MCP can inspect this frozen proposal but cannot approve or reject it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve proposal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Review rationale')).not.toBeInTheDocument();
  });
});
