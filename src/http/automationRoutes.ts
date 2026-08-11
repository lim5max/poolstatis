import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { Project } from '../services/projects.js';
import {
  insightFeedScheduleInputSchema, monitorPolicyInputSchema, notificationDestinationLifecycleSchema,
  notificationDestinationInputSchema, resourceLifecycleSchema, reviewAutomationProposalSchema,
  reviseInsightFeedScheduleSchema, reviseMonitorPolicySchema,
} from '../services/automationSchemas.js';
import { createNotificationDestination, listNotificationDestinations, notificationCapabilities, transitionNotificationDestination } from '../services/notifications.js';
import { createMonitorPolicy, getMonitorPolicy, listMonitorPolicies, reviseMonitorPolicy, transitionMonitorPolicy } from '../services/monitorPolicies.js';
import { createInsightFeedSchedule, getInsightFeedSchedule, listInsightFeedSchedules, reviseInsightFeedSchedule, transitionInsightFeedSchedule } from '../services/insightFeeds.js';
import { getAutomationProposal, listAutomationProposals, reviewAutomationProposal } from '../services/automationProposals.js';
import { listInsightFeedSnapshots, listMonitorFindings, listNotificationDeliveries, listNotificationInbox } from '../services/automationReadModels.js';

export function registerAutomationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  helpers: {
    platform(req: FastifyRequest): void;
    resolveProject(req: FastifyRequest): Promise<Project>;
    actor(req: FastifyRequest): string;
  },
): void {
  const project = async (req: FastifyRequest) => { helpers.platform(req); return helpers.resolveProject(req); };

  app.get('/api/v1/projects/:slug/automation/capabilities', async (req) => {
    await project(req); return notificationCapabilities;
  });
  app.post('/api/v1/projects/:slug/automation/destinations', async (req, reply) => {
    const scoped = await project(req);
    return reply.status(201).send(await createNotificationDestination(
      ctx.pool, scoped.id, notificationDestinationInputSchema.parse(req.body), helpers.actor(req),
    ));
  });
  app.get('/api/v1/projects/:slug/automation/destinations', async (req) => {
    const scoped = await project(req); return { destinations: await listNotificationDestinations(ctx.pool, scoped.id) };
  });
  app.patch('/api/v1/projects/:slug/automation/destinations/:id', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    const body = notificationDestinationLifecycleSchema.parse(req.body);
    return transitionNotificationDestination(ctx.pool, scoped.id, id, body.status, helpers.actor(req));
  });
  app.post('/api/v1/projects/:slug/monitors', async (req, reply) => {
    const scoped = await project(req);
    return reply.status(201).send(await createMonitorPolicy(ctx.pool, scoped.id, monitorPolicyInputSchema.parse(req.body), helpers.actor(req)));
  });
  app.get('/api/v1/projects/:slug/monitors', async (req) => {
    const scoped = await project(req); return { policies: await listMonitorPolicies(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/monitors/:id', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    return getMonitorPolicy(ctx.pool, scoped.id, id);
  });
  app.patch('/api/v1/projects/:slug/monitors/:id', async (req) => {
    const scoped = await project(req);
    const { id } = req.params as { id: string };
    const body = reviseMonitorPolicySchema.parse(req.body);
    return reviseMonitorPolicy(ctx.pool, scoped.id, id, body.expected_version, body.revision, helpers.actor(req));
  });
  app.post('/api/v1/projects/:slug/monitors/:id/lifecycle', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    const body = resourceLifecycleSchema.parse(req.body);
    return transitionMonitorPolicy(ctx.pool, scoped.id, id, body.expected_version, body.status, helpers.actor(req));
  });
  app.post('/api/v1/projects/:slug/insight-feed/schedules', async (req, reply) => {
    const scoped = await project(req);
    return reply.status(201).send(await createInsightFeedSchedule(
      ctx.pool, scoped.id, insightFeedScheduleInputSchema.parse(req.body), helpers.actor(req),
    ));
  });
  app.get('/api/v1/projects/:slug/insight-feed/schedules', async (req) => {
    const scoped = await project(req); return { schedules: await listInsightFeedSchedules(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/insight-feed/schedules/:id', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    return getInsightFeedSchedule(ctx.pool, scoped.id, id);
  });
  app.patch('/api/v1/projects/:slug/insight-feed/schedules/:id', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    const body = reviseInsightFeedScheduleSchema.parse(req.body);
    return reviseInsightFeedSchedule(ctx.pool, scoped.id, id, body.expected_version, body.revision, helpers.actor(req));
  });
  app.post('/api/v1/projects/:slug/insight-feed/schedules/:id/lifecycle', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    const body = resourceLifecycleSchema.parse(req.body);
    return transitionInsightFeedSchedule(ctx.pool, scoped.id, id, body.expected_version, body.status, helpers.actor(req));
  });
  app.get('/api/v1/projects/:slug/automation/proposals', async (req) => {
    const scoped = await project(req); return { proposals: await listAutomationProposals(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/automation/proposals/:id', async (req) => {
    const scoped = await project(req); const { id } = req.params as { id: string };
    return getAutomationProposal(ctx.pool, scoped.id, id);
  });
  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/api/v1/projects/:slug/automation/proposals/:id/${decision}`, async (req) => {
      const scoped = await project(req); const { id } = req.params as { id: string };
      const body = reviewAutomationProposalSchema.parse(req.body);
      return reviewAutomationProposal(ctx.pool, scoped.id, id, decision === 'approve' ? 'approved' : 'rejected',
        body.confirmation_fingerprint, body.rationale, helpers.actor(req));
    });
  }
  app.get('/api/v1/projects/:slug/automation/findings', async (req) => {
    const scoped = await project(req); return { findings: await listMonitorFindings(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/insight-feed/snapshots', async (req) => {
    const scoped = await project(req); return { snapshots: await listInsightFeedSnapshots(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/automation/inbox', async (req) => {
    const scoped = await project(req); return { notifications: await listNotificationInbox(ctx.pool, scoped.id) };
  });
  app.get('/api/v1/projects/:slug/automation/deliveries', async (req) => {
    const scoped = await project(req); return { deliveries: await listNotificationDeliveries(ctx.pool, scoped.id) };
  });
}
