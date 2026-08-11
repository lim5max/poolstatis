import type { AuthContext } from '../http/auth.js';

export function accountModeForAuth(auth: AuthContext, hosted: boolean) {
  const role = auth.userRole ?? null;
  const roleAllowsOrganization = role === null || role === 'owner' || role === 'admin';
  const organizationWide = auth.projectId === null
    && (auth.kind === 'personal' || auth.kind === 'user')
    && roleAllowsOrganization;
  const hostedUser = hosted && auth.kind === 'user';
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
    },
    primary_action: hosted
      ? hostedAccountAction
      : { id: 'open_local_setup', kind: 'navigate' as const, label: 'Open local setup', href: '/setup' },
  };
}
