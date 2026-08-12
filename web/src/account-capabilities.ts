import type { AccountMode } from './api/types';

export type AccountMutationAccess =
  | 'allowed'
  | 'legacy_self_host'
  | 'loading'
  | 'unavailable'
  | 'insufficient_role'
  | 'sign_in_required'
  | 'self_host_credential_required';

type MutationCapability = 'review_decisions' | 'set_official_answers';

export function accountMutationAccess(
  mode: AccountMode | null,
  capability: MutationCapability,
  loading: boolean,
  error: string | null,
): AccountMutationAccess {
  if (loading) return 'loading';
  if (error || !mode) return 'unavailable';
  if (mode.capabilities[capability]) {
    return mode.deployment.mode === 'self_host'
      && mode.session.kind === 'personal'
      && mode.session.role === null
      ? 'legacy_self_host'
      : 'allowed';
  }
  if (mode.session.role === 'member') return 'insufficient_role';
  return mode.deployment.mode === 'hosted' ? 'sign_in_required' : 'self_host_credential_required';
}

export function mutationAllowed(access: AccountMutationAccess): boolean {
  return access === 'allowed' || access === 'legacy_self_host';
}
