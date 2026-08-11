import type pg from 'pg';

export async function listMonitorFindings(pool: pg.Pool, projectId: string) {
  const { rows } = await pool.query(
    `SELECT f.id, f.policy_id, f.run_id, f.policy_version, f.severity, f.snapshot, f.evidence,
       f.notification_state, f.created_at, p.policy_key, p.name AS policy_name
     FROM monitor_findings f JOIN monitor_policies p ON p.id = f.policy_id AND p.project_id = f.project_id
     WHERE f.project_id = $1 ORDER BY f.created_at DESC, f.id`, [projectId],
  );
  return rows;
}

export async function listInsightFeedSnapshots(pool: pg.Pool, projectId: string) {
  const { rows } = await pool.query(
    `SELECT x.id, x.schedule_id, x.run_id, x.resolved_window, x.definition_fingerprint,
       x.answer, x.evidence, x.created_at, s.schedule_key, s.name AS schedule_name
     FROM insight_feed_snapshots x JOIN insight_feed_schedules s ON s.id = x.schedule_id AND s.project_id = x.project_id
     WHERE x.project_id = $1 ORDER BY x.created_at DESC, x.id`, [projectId],
  );
  return rows;
}

export async function listNotificationInbox(pool: pg.Pool, projectId: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.delivery_id, i.payload, i.created_at
     FROM notification_inbox i WHERE i.project_id = $1 ORDER BY i.created_at DESC, i.id`, [projectId],
  );
  return rows;
}

export async function listNotificationDeliveries(pool: pg.Pool, projectId: string) {
  const { rows } = await pool.query(
    `SELECT d.id, d.destination_id, n.key AS destination_key, n.kind AS destination_kind,
       d.finding_id, d.feed_run_id, d.status, d.attempt_count, d.last_error_code,
       d.delivered_at, d.created_at, d.updated_at
     FROM notification_deliveries d LEFT JOIN notification_destinations n
       ON n.project_id = d.project_id AND n.id = d.destination_id
     WHERE d.project_id = $1 ORDER BY d.created_at DESC, d.id`, [projectId],
  );
  return rows;
}
