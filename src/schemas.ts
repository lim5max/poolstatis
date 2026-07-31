import { z } from 'zod';

// ===== Shared =====

export const filterOpSchema = z.enum([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_set', 'is_not_set',
]);

export const propertyFilterSchema = z
  .object({
    property: z.string().min(1),
    op: filterOpSchema,
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
  })
  .refine(
    (f) => (f.op === 'is_set' || f.op === 'is_not_set' ? f.value === undefined : f.value !== undefined),
    { message: 'value is required for all ops except is_set / is_not_set' },
  );

export type PropertyFilter = z.infer<typeof propertyFilterSchema>;

export const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(200),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const createProjectSchema = z.object({
  slug: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
});

export const createPersonalTokenSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
});

export const hostedOnboardingSchema = z.object({
  workspace_name: z.string().trim().min(1).max(200),
  project_slug: z.string().trim().min(1).max(200),
  project_name: z.string().trim().min(1).max(200),
});

export const actorDistinctIdSchema = z.string().trim().min(1).max(200);

const eventName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9$][a-z0-9_.]*$/, 'event names are snake_case object.action, e.g. checkout.completed');

const semanticText = z.string().trim().min(10, 'write a real sentence — this field feeds the insights layer');

export const keySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/, 'keys are snake_case identifiers, e.g. checkout_conversion');

// ===== Product decision loop trust foundation =====

export const actorLinkSchema = z.object({
  source_distinct_id: actorDistinctIdSchema,
  target_distinct_id: actorDistinctIdSchema,
  env: z.string().trim().min(1).max(100).default('prod'),
}).refine(
  (link) => link.source_distinct_id !== link.target_distinct_id,
  { path: ['target_distinct_id'], message: 'source and target actors must be different' },
);

export type ActorLinkInput = z.infer<typeof actorLinkSchema>;

export const propertyDefinitionSchema = z.object({
  key: z.string().trim().min(1).max(200),
  scope: z.enum(['event', 'actor', 'entity']),
  value_type: z.enum(['string', 'number', 'boolean', 'datetime', 'enum']),
  purpose: semanticText,
  status: z.enum(['proposed', 'trusted', 'untrusted']).default('proposed'),
  source: z.enum(['native', 'posthog']).default('native'),
  source_connection_id: z.string().uuid().optional(),
  enum_values: z.array(z.string().trim().min(1).max(200)).min(1).max(100).optional(),
}).superRefine((property, ctx) => {
  if (property.value_type === 'enum' && !property.enum_values) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enum_values'],
      message: 'enum properties require enum_values',
    });
  }
  if (property.value_type !== 'enum' && property.enum_values) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['enum_values'],
      message: 'enum_values are only valid for enum properties',
    });
  }
  if (property.source === 'posthog' && !property.source_connection_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_connection_id'],
      message: 'PostHog properties require source_connection_id',
    });
  }
  if (property.source === 'native' && property.source_connection_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['source_connection_id'],
      message: 'native properties cannot reference an external source connection',
    });
  }
});

export type PropertyDefinitionInput = z.infer<typeof propertyDefinitionSchema>;

// Keep the patch schema as a plain object: propertyDefinitionSchema is a
// ZodEffects after cross-field validation and therefore intentionally has no
// object-only omit/partial helpers. The service merges a patch with the stored
// row and re-validates the complete propertyDefinitionSchema.
export const updatePropertyDefinitionSchema = z.object({
  value_type: z.enum(['string', 'number', 'boolean', 'datetime', 'enum']).optional(),
  purpose: semanticText.optional(),
  status: z.enum(['proposed', 'trusted', 'untrusted']).optional(),
  enum_values: z.array(z.string().trim().min(1).max(200)).min(1).max(100).nullable().optional(),
});

export type UpdatePropertyDefinitionInput = z.infer<typeof updatePropertyDefinitionSchema>;

export const measurementTrustSchema = z.object({
  metric_key: keySchema,
  env: z.string().trim().min(1).max(100).default('prod'),
  target_filters: z.array(propertyFilterSchema).max(20).default([]),
  since_days: z.number().int().min(1).max(365).default(30),
});

export type MeasurementTrustInput = z.infer<typeof measurementTrustSchema>;

function safePostHogHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== '/' && url.pathname !== '') return false;
    if (url.protocol === 'https:') return true;
    const loopback = url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || url.hostname === '[::1]';
    return url.protocol === 'http:' && loopback;
  } catch {
    return false;
  }
}

export const posthogConnectionSchema = z.object({
  name: keySchema,
  host: z.string().trim().refine(
    safePostHogHost,
    'host must be an HTTPS origin, or loopback HTTP for controlled local testing',
  ).transform((host) => host.replace(/\/$/, '')),
  project_id: z.union([z.string().trim().min(1).max(100), z.number().int().nonnegative()])
    .transform(String),
  personal_api_key: z.string().trim().min(8).max(500).regex(
    /^phx_/,
    'use a PostHog personal API key (phx_) with Query Read permission',
  ),
});

export type PostHogConnectionInput = z.infer<typeof posthogConnectionSchema>;

// ===== Measurement contracts and release provenance =====

const externalReferencesSchema = z.object({
  issue_url: z.string().url().optional(),
  pr_url: z.string().url().optional(),
  commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/i, 'commit_sha must be a 7-64 character hex SHA').optional(),
  deploy_url: z.string().url().optional(),
}).strict();

export const measurementContractSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  business_hypothesis: semanticText,
  decision_owner: z.string().trim().min(1).max(200),
  primary_metric_key: keySchema,
  guardrail_metric_keys: z.array(keySchema).max(20).default([]),
  target_filters: z.array(propertyFilterSchema).max(20).default([]),
  baseline_window_days: z.number().int().min(1).max(365),
  observation_window_days: z.number().int().min(1).max(365).default(14),
  minimum_sample_size: z.number().int().min(1).max(10_000_000).default(100),
  expected_direction: z.enum(['increase', 'decrease', 'stay_within_range']),
  minimum_meaningful_effect: z.number().finite().nonnegative().optional(),
  flag_key: keySchema.optional(),
  experiment_key: keySchema.optional(),
  references: externalReferencesSchema.default({}),
  status: z.enum(['draft', 'active', 'archived']).default('active'),
}).superRefine((contract, ctx) => {
  const guardrails = new Set<string>();
  contract.guardrail_metric_keys.forEach((key, index) => {
    if (guardrails.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardrail_metric_keys', index],
        message: `duplicate guardrail metric "${key}"`,
      });
    }
    if (key === contract.primary_metric_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['guardrail_metric_keys', index],
        message: 'the primary metric cannot also be a guardrail',
      });
    }
    guardrails.add(key);
  });
});

export type MeasurementContractInput = z.infer<typeof measurementContractSchema>;

export const measurementDeclarationSchema = z.object({
  version: z.literal(1),
  contracts: z.array(measurementContractSchema).max(100),
}).superRefine((declaration, ctx) => {
  const keys = new Set<string>();
  declaration.contracts.forEach((contract, index) => {
    if (keys.has(contract.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contracts', index, 'key'],
        message: `duplicate contract key "${contract.key}"`,
      });
    }
    keys.add(contract.key);
  });
});

export type MeasurementDeclaration = z.infer<typeof measurementDeclarationSchema>;

export const applyMeasurementDeclarationSchema = z.object({
  declaration: measurementDeclarationSchema,
  confirm_existing_changes: z.boolean().default(false),
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});

export type ApplyMeasurementDeclarationInput = z.infer<typeof applyMeasurementDeclarationSchema>;

export const registerReleaseSchema = z.object({
  idempotency_key: z.string().trim().min(1).max(200),
  contract_key: keySchema,
  env: z.string().trim().min(1).max(100).default('prod'),
  repository: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(500).optional(),
  commit_sha: z.string().trim().regex(/^[a-f0-9]{7,64}$/i, 'commit_sha must be a 7-64 character hex SHA'),
  pr_url: z.string().url().optional(),
  deployed_at: z.string().datetime({ offset: true }).optional(),
  flag_key: keySchema.optional(),
  experiment_key: keySchema.optional(),
  variant: keySchema.optional(),
  originating_decision_id: z.string().uuid().optional(),
  status: z.enum(['planned', 'deployed']).default('deployed'),
}).superRefine((release, ctx) => {
  if (release.status === 'planned' && release.deployed_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deployed_at'], message: 'planned releases cannot have deployed_at' });
  }
});

export type RegisterReleaseInput = z.infer<typeof registerReleaseSchema>;

export const transitionReleaseSchema = z.object({
  status: z.enum(['deployed', 'observing', 'decided', 'cancelled']),
  deployed_at: z.string().datetime({ offset: true }).optional(),
}).superRefine((transition, ctx) => {
  if (transition.status !== 'deployed' && transition.deployed_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deployed_at'],
      message: 'deployed_at is only valid for the deployed transition',
    });
  }
});

export type TransitionReleaseInput = z.infer<typeof transitionReleaseSchema>;

export const reviewDecisionSchema = z.object({
  rationale: semanticText,
});

export const editDecisionSchema = z.object({
  outcome: z.enum(['keep', 'fix', 'rollback', 'inconclusive']),
  rationale: semanticText,
});

const actionTypeSchema = z.enum([
  'draft_implementation_prompt', 'prepare_flag_rollback',
  'schedule_observation', 'request_more_data', 'generic_webhook',
  'create_issue', 'open_draft_pr',
]);

export const prepareDecisionActionSchema = z.object({
  action_type: actionTypeSchema,
  idempotency_key: z.string().trim().min(1).max(200),
  target: z.record(z.unknown()),
  payload: z.record(z.unknown()),
  expected_effect: semanticText,
}).superRefine((action, ctx) => {
  if (action.action_type === 'prepare_flag_rollback') {
    const parsed = z.object({ flag_key: keySchema, variants: z.array(featureFlagVariantSchema).min(1) }).safeParse(action.payload);
    if (!parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'flag rollback requires flag_key and valid variants' });
  }
  if (action.action_type === 'schedule_observation') {
    const parsed = z.object({ at: z.string().datetime({ offset: true }) }).safeParse(action.payload);
    if (!parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payload'], message: 'schedule observation requires an ISO at timestamp' });
  }
  if (action.action_type === 'draft_implementation_prompt' && typeof action.payload.prompt !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'prompt'], message: 'draft prompt requires prompt text' });
  }
});

export type PrepareDecisionActionInput = z.infer<typeof prepareDecisionActionSchema>;

export const approveDecisionActionSchema = z.object({
  confirmation_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const rejectDecisionActionSchema = z.object({ rationale: semanticText });

export const webhookDestinationSchema = z.object({
  name: keySchema,
  url: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
  }, 'webhook URL must use HTTPS (HTTP is allowed only for loopback tests)'),
  authorization: z.string().trim().min(1).max(1000).optional(),
});

export type WebhookDestinationInput = z.infer<typeof webhookDestinationSchema>;

// ===== Feature delivery: flags and experiments =====

const rolloutPercentageSchema = z.number().min(0).max(100).finite()
  .refine((percentage) => Math.abs(percentage * 100 - Math.round(percentage * 100)) < 1e-8,
    'rollout percentage must use no more than two decimal places');

export const featureFlagVariantSchema = z.object({
  key: keySchema,
  rollout_percentage: rolloutPercentageSchema,
  payload: z.record(z.unknown()).optional(),
});

function validateVariants(
  variants: Array<{ key: string; rollout_percentage: number }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, variant] of variants.entries()) {
    if (seen.has(variant.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants', index, 'key'],
        message: `duplicate variant key "${variant.key}"`,
      });
    }
    seen.add(variant.key);
  }
  const totalBasisPoints = variants.reduce((sum, variant) => sum + Math.round(variant.rollout_percentage * 100), 0);
  if (totalBasisPoints > 10_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['variants'],
      message: `variant allocation totals ${totalBasisPoints / 100}%; it must not exceed 100%`,
    });
  }
}

export const featureFlagSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1),
  purpose: semanticText,
  variants: z.array(featureFlagVariantSchema).min(1).max(10),
  status: z.enum(['draft', 'active']).default('draft'),
}).superRefine((flag, ctx) => validateVariants(flag.variants, ctx));

export type CreateFeatureFlagInput = z.infer<typeof featureFlagSchema>;

export const updateFeatureFlagSchema = z.object({
  name: z.string().trim().min(1).optional(),
  purpose: semanticText.optional(),
  variants: z.array(featureFlagVariantSchema).min(1).max(10).optional(),
  status: z.enum(['draft', 'active']).optional(),
}).superRefine((flag, ctx) => {
  if (flag.variants) validateVariants(flag.variants, ctx);
});

export type UpdateFeatureFlagInput = z.infer<typeof updateFeatureFlagSchema>;

export const flagEvaluationSchema = z.object({
  key: keySchema,
  distinct_id: z.string().min(1).max(200),
  session_id: z.string().max(200).optional(),
});

export type FlagEvaluationInput = z.infer<typeof flagEvaluationSchema>;

// ===== Browser Experience =====

export const experienceSurfaceSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1),
  purpose: semanticText,
  route_pattern: z.string().trim().min(1).max(200).regex(
    /^\/[^?#]*$/,
    'route_pattern must be a canonical path pattern without query or hash',
  ).optional(),
});

export type CreateExperienceSurfaceInput = z.infer<typeof experienceSurfaceSchema>;

const experienceLabelSchema = z.string().trim().min(1).max(120).regex(
  /^[a-z][a-z0-9_.:-]*$/,
  'label must be a stable lowercase identifier, not captured page text',
);
const experienceRouteSchema = experienceLabelSchema.describe('a developer-provided stable route key, never a raw URL or path');
const experienceVersionSchema = z.string().trim().min(1).max(120).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  'version must be a stable release identifier',
);
const experienceDimensionSchema = z.number().int().min(1).max(50_000);
export const experienceRouteRegistrationSchema = z.object({
  key: experienceRouteSchema,
  name: z.string().trim().min(1).max(120),
  path_pattern: z.string().trim().min(1).max(200).regex(
    /^\/[^?#]*$/,
    'path_pattern must be canonical and must not contain a query string or hash',
  ),
}).strict();
export type RegisterExperienceRouteInput = z.infer<typeof experienceRouteRegistrationSchema>;

const experienceCommonSchema = z.object({
  distinct_id: z.string().min(1).max(200),
  session_id: z.string().min(1).max(200),
  route: experienceRouteSchema,
  version: experienceVersionSchema.default('unversioned'),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  viewport_width: experienceDimensionSchema.default(1280),
  viewport_height: experienceDimensionSchema.default(720),
  document_width: experienceDimensionSchema.default(1280),
  document_height: experienceDimensionSchema.default(720),
  sequence: z.number().int().min(0).max(1_000_000),
});

export const experienceEventSchema = z.discriminatedUnion('kind', [
  experienceCommonSchema.extend({ kind: z.literal('page_viewed') }).strict(),
  experienceCommonSchema.extend({
    kind: z.literal('element_clicked'), label: experienceLabelSchema,
    x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
    viewport_x: z.number().finite().min(0).max(1).optional(),
    viewport_y: z.number().finite().min(0).max(1).optional(),
  }).strict(),
  experienceCommonSchema.extend({ kind: z.literal('scroll_depth'), depth: z.number().int().min(0).max(100) }).strict(),
  experienceCommonSchema.extend({
    kind: z.literal('section_exposed'),
    section: experienceLabelSchema,
    top: z.number().finite().min(0).max(1),
  }).strict(),
  experienceCommonSchema.extend({ kind: z.literal('client_error'), error_type: z.enum(['error', 'unhandled_rejection']) }).strict(),
]);

export const experienceCaptureSchema = z.object({
  surface: keySchema,
  batch_id: z.string().min(1).max(200),
  events: z.array(experienceEventSchema).min(1).max(100),
}).strict();

export type ExperienceCaptureInput = z.infer<typeof experienceCaptureSchema>;

export const experienceSnapshotMetaSchema = z.object({
  surface: keySchema,
  route: experienceRouteSchema,
  version: experienceVersionSchema,
  device: z.enum(['desktop', 'mobile']),
  env: z.string().trim().min(1).max(40).default('prod'),
  release_hash: experienceVersionSchema,
  viewport_width: z.number().int().min(240).max(10_000),
  viewport_height: z.number().int().min(240).max(10_000),
  document_width: z.number().int().min(1).max(10_000),
  document_height: z.number().int().min(1).max(50_000),
  captured_at: z.string().datetime({ offset: true }),
  retention_days: z.number().int().min(1).max(3650).default(90),
}).strict();
export type ExperienceSnapshotMetaInput = z.infer<typeof experienceSnapshotMetaSchema>;

const experimentMetricKeysSchema = z.array(keySchema).max(5).default([]).superRefine((keys, ctx) => {
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `duplicate metric key "${key}"` });
    }
    seen.add(key);
  }
});

export const createExperimentSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1),
  hypothesis: semanticText,
  flag_key: keySchema,
  primary_metric_key: keySchema,
  secondary_metric_keys: experimentMetricKeysSchema,
});

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

export const updateExperimentSchema = z.object({
  name: z.string().trim().min(1).optional(),
  hypothesis: semanticText.optional(),
  primary_metric_key: keySchema.optional(),
  secondary_metric_keys: experimentMetricKeysSchema.optional(),
});

export type UpdateExperimentInput = z.infer<typeof updateExperimentSchema>;

export const concludeExperimentSchema = z.object({
  decision: z.object({
    outcome: z.enum(['ship', 'iterate', 'stop', 'inconclusive']),
    rationale: semanticText,
  }).optional(),
});

// ===== Metric registry =====

export const metricCategorySchema = keySchema;

const metricCategoryColorSchema = z.string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB')
  .transform((value) => value.toUpperCase());

export const createMetricCategorySchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  description: semanticText,
  domain: z.literal('custom').default('custom'),
  color: metricCategoryColorSchema,
}).strict();
export type CreateMetricCategoryInput = z.infer<typeof createMetricCategorySchema>;

export const updateMetricCategorySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: semanticText.optional(),
  color: metricCategoryColorSchema.optional(),
}).strict().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: 'at least one editable field is required' },
);
export type UpdateMetricCategoryInput = z.infer<typeof updateMetricCategorySchema>;

const eventSourceBase = z.object({
  event: eventName,
  filters: z.array(propertyFilterSchema).default([]),
  data_source: z.enum(['native', 'posthog']).default('native'),
  source_connection_id: z.string().uuid().optional(),
});

export const metricSourceSchemas = {
  count: eventSourceBase,
  unique_actors: eventSourceBase,
  value: eventSourceBase.extend({
    value_property: z.string().min(1),
    agg: z.enum(['sum', 'avg', 'min', 'max', 'p90']).default('sum'),
  }),
  conversion: z.object({
    from: eventSourceBase,
    to: eventSourceBase,
    window_seconds: z.number().int().positive().default(3600),
  }),
  state: z.object({
    entity_type: z.string().min(1),
    filters: z.array(propertyFilterSchema).default([]),
    agg: z.literal('count').default('count'),
  }),
} as const;

export type MetricType = keyof typeof metricSourceSchemas;

// Free-form labels beyond the AARRR category (e.g. 'product', 'north-star').
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20);

export const registerMetricSchema = z
  .object({
    key: keySchema,
    name: z.string().trim().min(1),
    purpose: semanticText,
    category: metricCategorySchema.optional(),
    tags: tagsSchema.optional(),
    type: z.enum(['count', 'unique_actors', 'value', 'conversion', 'state']),
    source: z.unknown(),
  })
  .superRefine((m, ctx) => {
    const parsed = metricSourceSchemas[m.type].safeParse(m.source);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source', ...issue.path],
          message: `source for type=${m.type}: ${issue.message}`,
        });
      }
      return;
    }
    const sources = m.type === 'conversion'
      ? [
          (parsed.data as { from: unknown }).from,
          (parsed.data as { to: unknown }).to,
        ]
      : m.type === 'state'
        ? []
        : [parsed.data];
    for (const [index, rawSource] of sources.entries()) {
      const source = rawSource as {
        data_source?: 'native' | 'posthog';
        source_connection_id?: string;
      };
      if (source.data_source === 'posthog' && !source.source_connection_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source', ...(m.type === 'conversion' ? [index === 0 ? 'from' : 'to'] : []), 'source_connection_id'],
          message: 'PostHog metric sources require source_connection_id',
        });
      }
      if (source.data_source !== 'posthog' && source.source_connection_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source', ...(m.type === 'conversion' ? [index === 0 ? 'from' : 'to'] : []), 'source_connection_id'],
          message: 'native metric sources cannot reference an external connection',
        });
      }
      if (m.type === 'conversion' && source.data_source === 'posthog') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['source'],
          message: 'PostHog conversion metrics are unsupported; define event metrics and query a funnel',
        });
      }
    }
  });

export type RegisterMetricInput = z.infer<typeof registerMetricSchema>;

export const updateMetricSchema = z.object({
  name: z.string().trim().min(1).optional(),
  purpose: semanticText.optional(),
  category: metricCategorySchema.nullable().optional(),
  tags: tagsSchema.optional(),
  status: z.enum(['proposed', 'active']).optional(),
  source: z.unknown().optional(),
});

export type UpdateMetricInput = z.infer<typeof updateMetricSchema>;

export const deprecateMetricSchema = z.object({
  reason: semanticText,
});

export type DeprecateMetricInput = z.infer<typeof deprecateMetricSchema>;

// ===== Entity types & funnels =====

export const registerEntityTypeSchema = z.object({
  name: keySchema,
  description: semanticText,
  prop_schema: z.record(z.unknown()).optional(),
});

export const defineFunnelSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1),
  goal: semanticText,
  steps: z
    .array(z.object({ metric_key: keySchema, label: z.string().trim().min(1) }))
    .min(2, 'a funnel needs at least 2 steps'),
  window_seconds: z.number().int().positive().default(604800),
});

export type DefineFunnelInput = z.infer<typeof defineFunnelSchema>;

// ===== Ingest =====

export const ingestEventSchema = z.object({
  event: eventName,
  timestamp: z.string().datetime({ offset: true }).optional(),
  distinct_id: z.string().min(1).max(200),
  session_id: z.string().max(200).optional(),
  properties: z.record(z.unknown()).default({}),
});

// The envelope is validated at the route; individual events are validated
// one by one in IngestService so a single bad event yields a 207 with
// per-element errors instead of sinking the whole batch.
export const ingestEnvelopeSchema = z.object({
  batch_id: z.string().min(1).max(200).optional(),
  events: z.array(z.unknown()).min(1).max(500),
}).strict();

export type IngestEnvelope = z.infer<typeof ingestEnvelopeSchema>;

export const historicalEventSchema = ingestEventSchema.extend({
  timestamp: z.string().datetime({ offset: true }),
}).strict();

export const previewEventBackfillSchema = z.object({
  env: z.string().min(1).max(100).default('prod'),
  events: z.array(z.unknown()).min(1).max(500),
}).strict();

export const commitEventBackfillSchema = previewEventBackfillSchema.extend({
  batch_id: z.string().trim().min(1).max(200),
  reason: semanticText,
  expected_payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const eventRevisionPatchSchema = z.object({
  event: eventName.optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
  distinct_id: z.string().min(1).max(200).optional(),
  session_id: z.string().max(200).nullable().optional(),
  set_properties: z.record(z.unknown()).default({}),
  unset_properties: z.array(z.string().min(1).max(200)).max(100).default([]),
}).strict().refine(
  (value) => value.event !== undefined
    || value.timestamp !== undefined
    || value.distinct_id !== undefined
    || value.session_id !== undefined
    || Object.keys(value.set_properties).length > 0
    || value.unset_properties.length > 0,
  'at least one event field or property change is required',
).refine(
  (value) => value.unset_properties.every(
    (key) => !Object.prototype.hasOwnProperty.call(value.set_properties, key),
  ),
  'a property cannot be set and unset in the same revision',
);

export const previewEventRevisionSchema = z.object({
  env: z.string().min(1).max(100).default('prod'),
  patch: eventRevisionPatchSchema,
}).strict();

export const commitEventRevisionSchema = previewEventRevisionSchema.extend({
  expected_revision: z.number().int().positive(),
  expected_preview_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: semanticText,
}).strict();

export type HistoricalEventInput = z.infer<typeof historicalEventSchema>;
export type EventRevisionPatch = z.infer<typeof eventRevisionPatchSchema>;

/** UTC calendar month used by the server-side accepted-event meter. */
export const usagePeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const entityUpsertSchema = z.object({
  entities: z
    .array(
      z.object({
        entity_type: z.string().min(1),
        entity_id: z.string().min(1).max(200),
        properties: z.record(z.unknown()).default({}),
      }).strict(),
    )
    .min(1)
    .max(500),
}).strict();

export type EntityUpsertInput = z.infer<typeof entityUpsertSchema>;

// ===== Query DSL =====

const dateStr = z.string().min(1); // relative '-30d' or ISO date; parsed in query layer

export const trendQuerySchema = z.object({
  kind: z.literal('trend'),
  metric: keySchema,
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  interval: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  filters: z.array(propertyFilterSchema).max(20).default([]),
  breakdown: z.object({ property: z.string().min(1) }).optional(),
  env: z.string().default('prod'),
});

export const webAnalyticsQuerySchema = z.object({
  kind: z.literal('web_analytics'),
  metric: keySchema,
  key_metric: keySchema.optional(),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  filters: z.array(propertyFilterSchema).max(20).default([]),
  dimensions: z.array(z.enum([
    'route',
    'source',
    'device',
    'browser',
    'os',
    'language',
    'timezone',
    'country',
  ])).min(1).max(8).default(['route', 'device', 'browser']),
  env: z.string().trim().min(1).max(100).default('prod'),
}).strict();

const browserRouteKeySchema = z.string().trim().min(1).max(100)
  .regex(/^[a-z][a-z0-9_.:-]{0,99}$/, 'route keys must be stable lowercase identifiers');

export const browserRouteKeysSchema = z.array(browserRouteKeySchema).min(1).max(100);

export const browserAnalyticsSetupSchema = z.object({
  route_keys: browserRouteKeysSchema,
}).strict().transform((input) => ({
  route_keys: [...new Set(input.route_keys)].sort(),
}));

export type BrowserAnalyticsSetupInput = z.infer<typeof browserAnalyticsSetupSchema>;

export const webSessionsQuerySchema = z.object({
  kind: z.literal('web_sessions'),
  metric: keySchema,
  key_metric: keySchema.optional(),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  filters: z.array(propertyFilterSchema).max(20).default([]),
  limit: z.number().int().min(1).max(100).default(50),
  env: z.string().trim().min(1).max(100).default('prod'),
}).strict();

export const webSessionQuerySchema = z.object({
  kind: z.literal('web_session'),
  metric: keySchema,
  key_metric: keySchema.optional(),
  session_id: z.string().trim().min(1).max(200),
  actor_id: z.string().trim().min(1).max(200).optional(),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  filters: z.array(propertyFilterSchema).max(20).default([]),
  page_limit: z.number().int().min(1).max(200).default(100),
  env: z.string().trim().min(1).max(100).default('prod'),
}).strict();

export const pageEngagementQuerySchema = z.object({
  kind: z.literal('page_engagement'),
  metric: keySchema,
  page_view_id: z.string().trim().min(1).max(200),
  actor_id: z.string().trim().min(1).max(200).optional(),
  session_id: z.string().trim().min(1).max(200).optional(),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  filters: z.array(propertyFilterSchema).max(20).default([]),
  env: z.string().trim().min(1).max(100).default('prod'),
}).strict();

// funnel XOR steps is enforced in QueryService (zod .refine would break the
// discriminated union below).
export const funnelQuerySchema = z.object({
  kind: z.literal('funnel'),
  funnel: keySchema.optional(),
  steps: z.array(z.object({ metric: keySchema })).min(2).optional(),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  env: z.string().default('prod'),
});

export const entitiesQuerySchema = z.object({
  kind: z.literal('entities'),
  entity_type: z.string().min(1),
  filters: z.array(propertyFilterSchema).default([]),
  order_by: z.object({ property: z.string().min(1), dir: z.enum(['asc', 'desc']).default('desc') }).optional(),
  limit: z.number().int().positive().max(200).default(50),
  env: z.string().default('prod'),
});

export const actorsQuerySchema = z.object({
  kind: z.literal('actors'),
  env: z.string().trim().min(1).max(100).default('prod'),
  from: dateStr.optional(),
  to: dateStr.nullable().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(8192).optional(),
  order: z.enum(['last_seen_desc', 'first_seen_desc', 'events_desc']).default('last_seen_desc'),
  search: z.object({
    kind: z.literal('exact_id'),
    value: z.string().trim().min(1).max(200),
  }).strict().optional(),
  propertyFilters: z.array(propertyFilterSchema).max(20).default([]),
  activityMetric: keySchema.optional(),
}).strict();

export const personQuerySchema = z.object({
  env: z.string().trim().min(1).max(100).default('prod'),
  from: dateStr.optional(),
  to: dateStr.nullable().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(8192).optional(),
}).strict();

// Retention: of the actors who did `start_metric` in a cohort bucket, how many
// came back and did `return_metric` in each later bucket. Both reference
// event-based registry metrics; the actor is distinct_id (the standard mandates
// a stable id, so distinct_id IS the actor until identity-merge lands).
export const retentionQuerySchema = z.object({
  kind: z.literal('retention'),
  start_metric: keySchema,
  return_metric: keySchema.optional(), // defaults to start_metric (classic retention)
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  interval: z.enum(['day', 'week', 'month']).default('week'),
  periods: z.number().int().min(2).max(31).default(8),
  env: z.string().default('prod'),
});

// Lifecycle: per interval, split active actors into new / returning /
// resurrecting, plus the dormant who went quiet, for one event-based metric.
export const lifecycleQuerySchema = z.object({
  kind: z.literal('lifecycle'),
  metric: keySchema,
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  interval: z.enum(['day', 'week', 'month']).default('week'),
  env: z.string().default('prod'),
});

// Stickiness: histogram of how many distinct intervals each actor was active in.
export const stickinessQuerySchema = z.object({
  kind: z.literal('stickiness'),
  metric: keySchema,
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  interval: z.enum(['day', 'week', 'month']).default('week'),
  env: z.string().default('prod'),
});

// Browser Experience map: meaningful interaction evidence for one
// purpose-tagged surface. This maps clicks, not cursor movement or gaze.
export const interactionMapQuerySchema = z.object({
  kind: z.literal('interaction_map'),
  surface: keySchema,
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  grid: z.number().int().min(2).max(64).default(16),
  env: z.string().default('prod'),
});

export const experienceSessionQuerySchema = z.object({
  kind: z.literal('experience_session'),
  surface: keySchema,
  session_id: z.string().min(1).max(200),
  actor_id: z.string().trim().min(1).max(200).optional(),
  date_from: dateStr.default('-7d'),
  date_to: dateStr.nullable().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  env: z.string().default('prod'),
});

export const visualExperienceQuerySchema = z.object({
  kind: z.literal('visual_experience'),
  surface: keySchema,
  route: experienceRouteSchema,
  version: experienceVersionSchema,
  device: z.enum(['desktop', 'mobile']),
  date_from: dateStr,
  date_to: dateStr.nullable().optional(),
  grid: z.number().int().min(4).max(64).default(24),
  env: z.string().default('prod'),
});

export const visualExperienceCompareSchema = z.object({
  kind: z.literal('visual_experience_compare'),
  surface: keySchema,
  route: experienceRouteSchema,
  baseline: z.object({
    version: experienceVersionSchema,
    device: z.enum(['desktop', 'mobile']),
    date_from: dateStr,
    date_to: dateStr.nullable().optional(),
  }).strict(),
  comparison: z.object({
    version: experienceVersionSchema,
    device: z.enum(['desktop', 'mobile']),
    date_from: dateStr,
    date_to: dateStr.nullable().optional(),
  }).strict(),
  grid: z.number().int().min(4).max(64).default(24),
  env: z.string().default('prod'),
}).strict();

export const purgeDataSchema = z.object({
  env: z.string().min(1),
  scope: z.enum(['events', 'entities', 'all']),
  confirm_slug: z.string().min(1),
  distinct_id: z.string().min(1).max(200).optional(),
});

export type PurgeDataInput = z.infer<typeof purgeDataSchema>;

export const querySchema = z.discriminatedUnion('kind', [
  trendQuerySchema,
  webAnalyticsQuerySchema,
  webSessionsQuerySchema,
  webSessionQuerySchema,
  pageEngagementQuerySchema,
  funnelQuerySchema,
  entitiesQuerySchema,
  actorsQuerySchema,
  retentionQuerySchema,
  lifecycleQuerySchema,
  stickinessQuerySchema,
  interactionMapQuerySchema,
  experienceSessionQuerySchema,
  visualExperienceQuerySchema,
  visualExperienceCompareSchema,
]);

export type TrendQueryInput = z.infer<typeof trendQuerySchema>;
export type WebAnalyticsQueryInput = z.infer<typeof webAnalyticsQuerySchema>;
export type WebSessionsQueryInput = z.infer<typeof webSessionsQuerySchema>;
export type WebSessionQueryInput = z.infer<typeof webSessionQuerySchema>;
export type PageEngagementQueryInput = z.infer<typeof pageEngagementQuerySchema>;
export type FunnelQueryInput = z.infer<typeof funnelQuerySchema>;
export type EntitiesQueryInput = z.infer<typeof entitiesQuerySchema>;
export type ActorsQueryInput = z.infer<typeof actorsQuerySchema>;
export type PersonQueryInput = z.infer<typeof personQuerySchema>;
export type RetentionQueryInput = z.infer<typeof retentionQuerySchema>;
export type LifecycleQueryInput = z.infer<typeof lifecycleQuerySchema>;
export type StickinessQueryInput = z.infer<typeof stickinessQuerySchema>;
export type InteractionMapQueryInput = z.infer<typeof interactionMapQuerySchema>;
export type ExperienceSessionQueryInput = z.infer<typeof experienceSessionQuerySchema>;
export type VisualExperienceQueryInput = z.infer<typeof visualExperienceQuerySchema>;
export type VisualExperienceCompareInput = z.infer<typeof visualExperienceCompareSchema>;
export type QueryInput = z.infer<typeof querySchema>;
