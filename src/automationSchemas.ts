import { z } from 'zod';
import { keySchema } from './schemas.js';

const boundedText = z.string().trim().min(3).max(500);
const destinationIds = z.array(z.string().uuid()).max(20).default([])
  .refine((ids) => new Set(ids).size === ids.length, 'destination_ids must be unique');
const proposalVariantSchema = z.object({
  key: keySchema,
  rollout_percentage: z.number().min(0).max(100),
}).strict();
const proposalTargetSchema = z.object({
  flag_key: keySchema,
  variants: z.array(proposalVariantSchema).min(1).max(10),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.variants.map((variant) => variant.key)).size !== input.variants.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants'], message: 'proposal variant keys must be unique' });
  }
  const total = input.variants.reduce((sum, variant) => sum + variant.rollout_percentage, 0);
  if (Math.abs(total - 100) > 0.000_001) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variants'], message: 'proposal rollout percentages must sum to 100' });
  }
});

export const notificationDestinationInputSchema = z.object({
  key: keySchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['in_product', 'outbox']),
}).strict();
export const notificationDestinationLifecycleSchema = z.object({
  status: z.enum(['active', 'disabled']),
}).strict();

export const monitorPolicyInputSchema = z.object({
  policy_key: keySchema,
  name: z.string().trim().min(1).max(200),
  env: z.string().trim().min(1).max(100),
  target_kind: z.enum(['project', 'release', 'experiment']),
  target_id: z.string().uuid().nullable(),
  metric_key: keySchema,
  comparison_rule: z.enum(['above', 'below', 'change_up_percent', 'change_down_percent']),
  threshold: z.number().finite(),
  minimum_sample: z.number().int().min(0).max(1_000_000_000),
  window_minutes: z.number().int().min(5).max(525_600),
  cadence_minutes: z.number().int().min(1).max(525_600),
  cooldown_seconds: z.number().int().min(0).max(31_536_000),
  owner: boundedText,
  destination_ids: destinationIds,
  proposal_kind: z.enum(['pause', 'rollback']).nullable(),
  proposal_target: proposalTargetSchema.nullable(),
}).strict().superRefine((input, ctx) => {
  if ((input.target_kind === 'project') !== (input.target_id === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target_id'], message: 'project target requires null; release/experiment requires an id' });
  }
  if ((input.proposal_kind === null) !== (input.proposal_target === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proposal_target'], message: 'proposal kind and target must be configured together' });
  }
});
export type MonitorPolicyInput = z.infer<typeof monitorPolicyInputSchema>;

export const reviseMonitorPolicySchema = z.object({
  expected_version: z.number().int().positive(),
  revision: monitorPolicyInputSchema,
}).strict();

const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'local_time must use HH:mm');
export const insightFeedScheduleInputSchema = z.object({
  schedule_key: keySchema,
  name: z.string().trim().min(1).max(200),
  env: z.string().trim().min(1).max(100),
  metric_key: keySchema,
  template_kind: z.literal('metric_trend'),
  window_days: z.number().int().min(1).max(365),
  timezone: z.string().trim().min(1).max(100),
  frequency: z.enum(['daily', 'weekly']),
  local_time: localTimeSchema,
  weekday: z.number().int().min(0).max(6).nullable(),
  destination_ids: destinationIds,
  owner: boundedText,
}).strict().superRefine((input, ctx) => {
  if ((input.frequency === 'daily') !== (input.weekday === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['weekday'], message: 'daily requires null weekday; weekly requires weekday 0..6' });
  }
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); }
  catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timezone'], message: 'timezone must be a valid IANA name' }); }
});
export type InsightFeedScheduleInput = z.infer<typeof insightFeedScheduleInputSchema>;

export const reviseInsightFeedScheduleSchema = z.object({
  expected_version: z.number().int().positive(),
  revision: insightFeedScheduleInputSchema,
}).strict();

export const resourceLifecycleSchema = z.object({
  expected_version: z.number().int().positive(),
  status: z.enum(['active', 'paused', 'archived']),
}).strict();

export const reviewAutomationProposalSchema = z.object({
  confirmation_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  rationale: boundedText,
}).strict();
