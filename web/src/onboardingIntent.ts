export type AnalyticsJobId = 'activation' | 'funnel' | 'web' | 'release';

export interface AnalyticsJob {
  id: AnalyticsJobId;
  label: string;
  description: string;
  request: string;
}

export const ANALYTICS_JOBS: AnalyticsJob[] = [
  {
    id: 'activation',
    label: 'Understand activation',
    description: 'Find whether new users reach the first value moment.',
    request: 'Define and measure the shortest trustworthy path from a new user to first value.',
  },
  {
    id: 'funnel',
    label: 'Find funnel drop-off',
    description: 'See where a key product journey loses users.',
    request: 'Define the key product funnel and find the first meaningful drop-off.',
  },
  {
    id: 'web',
    label: 'Add web analytics',
    description: 'Measure visits and engagement without collecting raw content.',
    request: 'Add privacy-safe web analytics and produce one verified engagement answer.',
  },
  {
    id: 'release',
    label: 'Measure a release',
    description: 'Check whether a shipped change moved its intended outcome.',
    request: 'Measure a real release against its intended product outcome without claiming causality from correlation.',
  },
];

export function analyticsJobById(id: AnalyticsJobId): AnalyticsJob {
  return ANALYTICS_JOBS.find((job) => job.id === id) ?? ANALYTICS_JOBS[0]!;
}

export function buildAnalyticsAgentRequest(input: {
  jobId: AnalyticsJobId;
  outcome?: string;
  project: string;
  env: string;
}): string {
  const job = analyticsJobById(input.jobId);
  const outcome = input.outcome?.trim();
  const scope = `Poolstatis project ${JSON.stringify(input.project)} in environment ${JSON.stringify(input.env)}`;

  return [
    `Set up the smallest trustworthy analytics loop for ${scope}.`,
    '',
    `Job: ${job.request}`,
    ...(outcome ? [`Product outcome: ${outcome}`] : []),
    '',
    'Work in the product repository and use the connected Poolstatis MCP server plus the installed poolstatis-instrument workflow.',
    '',
    'Before editing:',
    '1. Inspect the repository, existing analytics, and the real product path.',
    '2. Read the live Poolstatis instrumentation standard and project schema for the exact scope above.',
    '3. Reuse existing definitions where possible. Propose the smallest purpose-backed metric and funnel plan, and list anything that needs owner approval.',
    '',
    'Then implement and verify:',
    '1. Keep agent-created definitions proposed until the owner activates them.',
    '2. Use one shared capture path and only a write-only pk_ runtime key from the product environment. Never put pt_ or sk_ credentials in product code or in your report.',
    '3. Exercise a real product path; do not generate synthetic production events just to satisfy setup checks.',
    '4. Verify accepted observations, ingest warnings, data-quality issues, one typed query, and get_onboarding_status.',
    '5. Save an insight or decision only from a query result you actually produced.',
    '',
    'Return the exact files changed, metric purpose, identity strategy, query grain and window, observed result, server evidence, approvals still needed, and the single next onboarding blocker. Do not claim MCP connectivity, accepted data, or a result unless the server proves it.',
  ].join('\n');
}
