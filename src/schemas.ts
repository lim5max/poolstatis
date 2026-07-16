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

const eventName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9$][a-z0-9_.]*$/, 'event names are snake_case object.action, e.g. checkout.completed');

const semanticText = z.string().trim().min(10, 'write a real sentence — this field feeds the insights layer');

const keySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/, 'keys are snake_case identifiers, e.g. checkout_conversion');

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
});

export type CreateExperienceSurfaceInput = z.infer<typeof experienceSurfaceSchema>;

const experienceLabelSchema = z.string().trim().min(1).max(120).regex(
  /^[a-z][a-z0-9_.:-]*$/,
  'label must be a stable lowercase identifier, not captured page text',
);
const experienceRouteSchema = experienceLabelSchema.describe('a developer-provided stable route key, never a raw URL or path');
const experienceCommonSchema = z.object({
  distinct_id: z.string().min(1).max(200),
  session_id: z.string().min(1).max(200),
  route: experienceRouteSchema,
  sequence: z.number().int().min(0).max(1_000_000),
});

export const experienceEventSchema = z.discriminatedUnion('kind', [
  experienceCommonSchema.extend({ kind: z.literal('page_viewed') }).strict(),
  experienceCommonSchema.extend({
    kind: z.literal('element_clicked'), label: experienceLabelSchema,
    x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  }).strict(),
  experienceCommonSchema.extend({ kind: z.literal('scroll_depth'), depth: z.number().int().min(0).max(100) }).strict(),
  experienceCommonSchema.extend({ kind: z.literal('client_error'), error_type: z.enum(['error', 'unhandled_rejection']) }).strict(),
]);

export const experienceCaptureSchema = z.object({
  surface: keySchema,
  batch_id: z.string().min(1).max(200),
  events: z.array(experienceEventSchema).min(1).max(100),
}).strict();

export type ExperienceCaptureInput = z.infer<typeof experienceCaptureSchema>;

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

export const metricCategorySchema = z.enum([
  'acquisition', 'activation', 'retention', 'revenue', 'referral', 'quality',
]);

const eventSourceBase = z.object({
  event: eventName,
  filters: z.array(propertyFilterSchema).default([]),
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
  breakdown: z.object({ property: z.string().min(1) }).optional(),
  env: z.string().default('prod'),
});

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
  date_from: dateStr.default('-7d'),
  date_to: dateStr.nullable().optional(),
  limit: z.number().int().min(1).max(500).default(200),
  env: z.string().default('prod'),
});

export const purgeDataSchema = z.object({
  env: z.string().min(1),
  scope: z.enum(['events', 'entities', 'all']),
  confirm_slug: z.string().min(1),
  distinct_id: z.string().min(1).max(200).optional(),
});

export type PurgeDataInput = z.infer<typeof purgeDataSchema>;

export const querySchema = z.discriminatedUnion('kind', [
  trendQuerySchema,
  funnelQuerySchema,
  entitiesQuerySchema,
  retentionQuerySchema,
  lifecycleQuerySchema,
  stickinessQuerySchema,
  interactionMapQuerySchema,
  experienceSessionQuerySchema,
]);

export type TrendQueryInput = z.infer<typeof trendQuerySchema>;
export type FunnelQueryInput = z.infer<typeof funnelQuerySchema>;
export type EntitiesQueryInput = z.infer<typeof entitiesQuerySchema>;
export type RetentionQueryInput = z.infer<typeof retentionQuerySchema>;
export type LifecycleQueryInput = z.infer<typeof lifecycleQuerySchema>;
export type StickinessQueryInput = z.infer<typeof stickinessQuerySchema>;
export type InteractionMapQueryInput = z.infer<typeof interactionMapQuerySchema>;
export type ExperienceSessionQueryInput = z.infer<typeof experienceSessionQuerySchema>;
export type QueryInput = z.infer<typeof querySchema>;
