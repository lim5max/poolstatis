const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

/**
 * POST is also used by a small number of read/analysis operations. These
 * routes remain available while customer writes are disabled. Query-run and
 * agent-observation rows are internal telemetry, not customer product state.
 */
export const PENDING_ORGANIZATION_MUTATION_EXEMPTIONS = Object.freeze([
  'PATCH /api/v1/me',
  'DELETE /api/v1/me/tokens/:id',
  'POST /api/v1/projects/:slug/query',
  'POST /api/v1/projects/:slug/flags/:key/evaluate',
  'POST /api/v1/projects/:slug/measurement/trust',
  'POST /api/v1/projects/:slug/contracts/validate',
  'POST /api/v1/projects/:slug/contracts/diff',
  'POST /api/v1/projects/:slug/contracts/similar',
  'POST /api/v1/projects/:slug/onboarding/observe-agent',
] as const);

const EXEMPTIONS = new Set<string>(PENDING_ORGANIZATION_MUTATION_EXEMPTIONS);

export function requiresOrganizationWriteReadiness(
  method: string,
  route: string | undefined,
): boolean {
  const normalizedMethod = method.toUpperCase();
  if (!MUTATING_METHODS.has(normalizedMethod) || !route) return false;
  if (!route.startsWith('/api/v1/') && !route.startsWith('/i/v1/')) return false;
  return !EXEMPTIONS.has(`${normalizedMethod} ${route}`);
}
