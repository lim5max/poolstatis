export type AnalysisCapability =
  | 'query.trend'
  | 'query.funnel'
  | 'query.retention'
  | 'query.lifecycle'
  | 'query.stickiness'
  | 'web.analytics'
  | 'release.evidence'
  | 'experiment.results'
  | 'measurement.trust';

export type TimeRangePreset = '7d' | '30d' | '90d';

export type TemplateResource =
  | 'metric'
  | 'funnel'
  | 'release'
  | 'experiment'
  | 'trust_report';

export interface AnalysisTemplateSlot {
  key: string;
  label: string;
  resource: TemplateResource;
  required: boolean;
  queryKind?: 'trend' | 'funnel' | 'retention' | 'lifecycle' | 'stickiness';
}

export interface AnalysisTemplate {
  key: string;
  version: number;
  title: string;
  question: string;
  purpose: string;
  requiredCapabilities: AnalysisCapability[];
  slots: AnalysisTemplateSlot[];
  defaultRange: TimeRangePreset;
  allowedBreakdowns: string[];
  allowedActions: Array<
    'open_metric'
    | 'open_funnel'
    | 'open_query'
    | 'see_actors'
    | 'compare_segment'
    | 'annotate_release'
    | 'open_decision'
    | 'save_view'
  >;
}

export const CORE_ANALYZE_CAPABILITIES = new Set<AnalysisCapability>([
  'query.trend',
  'query.funnel',
  'query.retention',
  'query.lifecycle',
  'query.stickiness',
]);

export const ANALYSIS_TEMPLATES: AnalysisTemplate[] = [
  {
    key: 'product-health',
    version: 1,
    title: 'Product health',
    question: 'Is a trusted product outcome moving over time?',
    purpose: 'Tracks one active registry metric as the clearest current product-health signal.',
    requiredCapabilities: ['query.trend'],
    slots: [{ key: 'primary_metric', label: 'Health metric', resource: 'metric', required: true, queryKind: 'trend' }],
    defaultRange: '30d',
    allowedBreakdowns: ['trusted_property'],
    allowedActions: ['open_metric', 'open_query', 'compare_segment'],
  },
  {
    key: 'web-overview',
    version: 1,
    title: 'Web overview',
    question: 'How is the measured web surface performing?',
    purpose: 'Summarizes privacy-safe web acquisition and engagement only when the web contract is available.',
    requiredCapabilities: ['web.analytics'],
    slots: [{ key: 'web_report', label: 'Web report', resource: 'trust_report', required: true }],
    defaultRange: '30d',
    allowedBreakdowns: [],
    allowedActions: ['open_query'],
  },
  {
    key: 'activation-funnel',
    version: 1,
    title: 'Activation funnel',
    question: 'Where do users stop before reaching first value?',
    purpose: 'Measures a saved, goal-bearing funnel made only from active registry metrics.',
    requiredCapabilities: ['query.funnel'],
    slots: [{ key: 'activation_funnel', label: 'Activation funnel', resource: 'funnel', required: true, queryKind: 'funnel' }],
    defaultRange: '30d',
    allowedBreakdowns: [],
    allowedActions: ['open_funnel', 'open_query', 'see_actors'],
  },
  {
    key: 'retention',
    version: 1,
    title: 'Retention',
    question: 'Do actors return after their first meaningful action?',
    purpose: 'Shows registry-backed cohort retention and makes right-censored periods explicit.',
    requiredCapabilities: ['query.retention'],
    slots: [{ key: 'return_metric', label: 'Return metric', resource: 'metric', required: true, queryKind: 'retention' }],
    defaultRange: '90d',
    allowedBreakdowns: [],
    allowedActions: ['open_metric', 'open_query'],
  },
  {
    key: 'feature-adoption',
    version: 1,
    title: 'Feature adoption',
    question: 'Is adoption of a registered feature outcome growing?',
    purpose: 'Tracks an active registry metric without substituting raw feature events.',
    requiredCapabilities: ['query.trend'],
    slots: [{ key: 'adoption_metric', label: 'Adoption metric', resource: 'metric', required: true, queryKind: 'trend' }],
    defaultRange: '30d',
    allowedBreakdowns: ['trusted_property'],
    allowedActions: ['open_metric', 'open_query', 'compare_segment'],
  },
  {
    key: 'release-impact',
    version: 1,
    title: 'Release impact',
    question: 'What changed during a release evidence window?',
    purpose: 'Connects a registered release to its immutable evidence and decision record.',
    requiredCapabilities: ['release.evidence'],
    slots: [{ key: 'release', label: 'Release', resource: 'release', required: true }],
    defaultRange: '30d',
    allowedBreakdowns: [],
    allowedActions: ['annotate_release', 'open_decision'],
  },
  {
    key: 'experiment-result',
    version: 1,
    title: 'Experiment result',
    question: 'Which variant has decision-ready evidence?',
    purpose: 'Shows server-computed experiment evidence without recreating statistical semantics in the client.',
    requiredCapabilities: ['experiment.results'],
    slots: [{ key: 'experiment', label: 'Experiment', resource: 'experiment', required: true }],
    defaultRange: '30d',
    allowedBreakdowns: [],
    allowedActions: ['open_decision'],
  },
  {
    key: 'data-trust',
    version: 1,
    title: 'Data trust',
    question: 'Which measurement blockers prevent a product decision?',
    purpose: 'Surfaces server-owned trust reports and their exact next actions.',
    requiredCapabilities: ['measurement.trust'],
    slots: [{ key: 'trust_report', label: 'Trust report', resource: 'trust_report', required: true }],
    defaultRange: '30d',
    allowedBreakdowns: [],
    allowedActions: ['open_metric'],
  },
];

const RESOURCE_KINDS = new Set<TemplateResource>(['metric', 'funnel', 'release', 'experiment', 'trust_report']);
const CAPABILITY_KINDS = new Set<AnalysisCapability>([
  'query.trend',
  'query.funnel',
  'query.retention',
  'query.lifecycle',
  'query.stickiness',
  'web.analytics',
  'release.evidence',
  'experiment.results',
  'measurement.trust',
]);
const QUERY_KINDS = new Set(['trend', 'funnel', 'retention', 'lifecycle', 'stickiness']);
const ACTION_KINDS = new Set<AnalysisTemplate['allowedActions'][number]>([
  'open_metric',
  'open_funnel',
  'open_query',
  'see_actors',
  'compare_segment',
  'annotate_release',
  'open_decision',
  'save_view',
]);

export function validateAnalysisTemplate(value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return { valid: false, errors: ['template must be an object'] };
  const template = value as Partial<AnalysisTemplate>;
  if (!template.key || typeof template.key !== 'string') errors.push('key is required');
  if (!Number.isInteger(template.version) || (template.version ?? 0) < 1) errors.push('version must be a positive integer');
  if (!template.title || !template.question || !template.purpose) errors.push('title, question and purpose are required');
  if (!Array.isArray(template.requiredCapabilities) || template.requiredCapabilities.length === 0) {
    errors.push('requiredCapabilities are required');
  } else if (template.requiredCapabilities.some((capability) => !CAPABILITY_KINDS.has(capability))) {
    errors.push('requiredCapabilities contains an unsupported capability');
  }
  if (!Array.isArray(template.slots) || template.slots.length === 0) {
    errors.push('at least one slot is required');
  } else {
    for (const slot of template.slots) {
      if (!slot || typeof slot !== 'object') {
        errors.push('slot must be an object');
        continue;
      }
      if (!slot.key || !slot.label) errors.push('slot key and label are required');
      if (!RESOURCE_KINDS.has(slot.resource)) errors.push(`unsupported slot resource: ${String(slot.resource)}`);
      if (typeof slot.required !== 'boolean') errors.push('slot required must be boolean');
      if (slot.queryKind !== undefined && !QUERY_KINDS.has(slot.queryKind)) errors.push('slot queryKind is unsupported');
    }
  }
  if (!['7d', '30d', '90d'].includes(String(template.defaultRange))) errors.push('defaultRange is invalid');
  if (!Array.isArray(template.allowedBreakdowns) || template.allowedBreakdowns.some((breakdown) => typeof breakdown !== 'string')) {
    errors.push('allowedBreakdowns must be a string array');
  }
  if (!Array.isArray(template.allowedActions) || template.allowedActions.some((action) => !ACTION_KINDS.has(action))) {
    errors.push('allowedActions contains an unsupported action');
  }
  return { valid: errors.length === 0, errors };
}

export function resolveTemplateCapability(
  templateKey: string,
  capabilities: ReadonlySet<AnalysisCapability>,
): { status: 'available' | 'unavailable'; missing: AnalysisCapability[] } {
  const template = ANALYSIS_TEMPLATES.find((candidate) => candidate.key === templateKey);
  if (!template) return { status: 'unavailable', missing: [] };
  const missing = template.requiredCapabilities.filter((capability) => !capabilities.has(capability));
  return { status: missing.length === 0 ? 'available' : 'unavailable', missing };
}
