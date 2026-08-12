import type { AuthContext } from '../http/auth.js';

export function accountModeForAuth(auth: AuthContext, hosted: boolean) {
  const role = auth.userRole ?? null;
  const roleAllowsOrganization = role === null || role === 'owner' || role === 'admin';
  const signedInReviewer = auth.kind === 'user'
    && Boolean(auth.userId)
    && (role === 'owner' || role === 'admin');
  const legacySelfHostReviewer = !hosted
    && auth.kind === 'personal'
    && auth.userId === undefined
    && auth.userRole === undefined;
  const organizationManager = signedInReviewer
    || (auth.kind === 'personal' && (legacySelfHostReviewer || role === 'owner' || role === 'admin'));
  const organizationWide = auth.projectId === null
    && (auth.kind === 'personal' || auth.kind === 'user')
    && roleAllowsOrganization;
  const hostedUser = hosted && auth.kind === 'user';
  const selfHostUsageManagement = !hosted && auth.kind === 'personal' && organizationWide;
  const hostedAccountAction = {
    id: hostedUser ? 'manage_hosted_account' as const : 'sign_in_to_manage_account' as const,
    kind: 'navigate' as const,
    label: hostedUser ? 'Manage account' : 'Sign in to manage account',
    href: 'https://auth.poolstatis.xyz/profile',
  };
  return {
    schema_version: 1 as const,
    deployment: {
      mode: hosted ? 'hosted' as const : 'self_host' as const,
      hosted_account: hosted ? 'available' as const : 'not_configured' as const,
    },
    session: {
      kind: auth.kind,
      scope: organizationWide ? 'organization' as const : 'project' as const,
      role,
    },
    capabilities: {
      portfolio: organizationWide
        ? 'available' as const
        : auth.kind === 'secret'
          ? 'project_only' as const
          : 'unavailable' as const,
      compare_projects: organizationWide,
      manage_profile: hostedUser,
      manage_personal_tokens: hostedUser && (role === 'owner' || role === 'admin'),
      review_decisions: signedInReviewer || legacySelfHostReviewer,
      set_official_answers: organizationManager,
      configure_usage_entitlement: selfHostUsageManagement
        ? 'available' as const
        : hosted
          ? 'unavailable_hosted' as const
          : 'unavailable_scope' as const,
      review_plan: 'unavailable' as const,
      set_usage_alert: 'unavailable' as const,
    },
    primary_action: hosted
      ? hostedAccountAction
      : { id: 'open_local_setup', kind: 'navigate' as const, label: 'Open local setup', href: '/setup' },
  };
}
