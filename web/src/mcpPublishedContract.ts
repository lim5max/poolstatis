export const PUBLISHED_MCP_TOOL_GROUPS = [
  ['Context', ['list_projects', 'get_project_schema', 'get_onboarding_status']],
  ['Measurement trust', ['create_actor_link', 'list_actor_links', 'revoke_actor_link', 'register_property', 'list_properties', 'update_property']],
  ['External sources', ['configure_posthog', 'verify_posthog', 'get_posthog_schema']],
  ['Decision loop', ['validate_measurement_contracts', 'diff_measurement_contracts', 'apply_measurement_contracts', 'export_measurement_contracts', 'register_release', 'list_releases', 'get_release', 'evaluate_release', 'list_decisions', 'get_decision', 'approve_decision', 'reject_decision', 'edit_decision', 'explain_outcome', 'prepare_action', 'approve_action', 'get_decision_inbox', 'search_decision_history', 'find_similar_changes']],
  ['Delivery', ['configure_webhook', 'verify_webhook']],
  ['Registry', ['register_metric', 'update_metric', 'deprecate_metric', 'explain_metric_usage', 'list_metrics', 'delete_metric', 'register_entity_type', 'define_funnel', 'list_funnels', 'delete_funnel']],
  ['Feature delivery', ['create_feature_flag', 'list_feature_flags', 'update_feature_flag', 'archive_feature_flag', 'evaluate_feature_flag', 'create_experiment', 'list_experiments', 'update_experiment', 'start_experiment', 'conclude_experiment', 'get_experiment_results']],
  ['Queries', ['query_trend', 'query_funnel', 'query_entities', 'query_retention', 'query_lifecycle', 'query_stickiness', 'sample_events']],
  ['Diagnostics', ['list_ingest_warnings', 'list_data_quality_issues']],
  ['Insights', ['list_insights', 'create_insight', 'resolve_insight']],
] as const;
