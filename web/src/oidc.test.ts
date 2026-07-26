import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHostedUserManager,
  hostedAccessToken,
  hostedAuthScope,
  signoutHostedUser,
} from './oidc';
import type { User } from 'oidc-client-ts';

describe('customer OIDC client policy', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('uses authorization code PKCE, an explicit API resource, and no persistent token store', async () => {
    const manager = createHostedUserManager(window, {
      authority: 'https://auth.poolstatis.xyz',
      clientId: 'poolstatis-customer-web',
      audience: 'https://api.poolstatis.xyz',
      apiUrl: 'https://api.poolstatis.xyz',
    });
    expect(manager.settings.response_type).toBe('code');
    expect(manager.settings.scope).toBe(hostedAuthScope);
    expect(manager.settings.resource).toBe('https://api.poolstatis.xyz');
    expect(manager.settings.extraTokenParams).toEqual({
      resource: 'https://api.poolstatis.xyz',
    });
    expect(manager.settings.automaticSilentRenew).toBe(false);
    expect(manager.settings.loadUserInfo).toBe(false);
    await manager.settings.userStore.set('access', 'secret-token');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await manager.settings.userStore.get('access')).toBe('secret-token');
    await manager.settings.stateStore.set('flow', 'pkce-state');
    expect(sessionStorage.length).toBe(1);
    expect(localStorage.length).toBe(0);
  });

  it('preserves the user and id_token_hint until end-session starts', async () => {
    const calls: string[] = [];
    await signoutHostedUser({
      signoutRedirect: async () => {
        calls.push('signout');
      },
    });
    expect(calls).toEqual(['signout']);
  });

  it('uses the callback user immediately without re-reading the in-memory user store', async () => {
    const callbackUser = {
      access_token: 'callback-access-token',
      expired: false,
    } as User;
    const manager = {
      getUser: async () => {
        throw new Error('the callback user is not visible through the store yet');
      },
      signinSilent: async () => {
        throw new Error('silent renewal is not needed');
      },
    };

    await expect(hostedAccessToken(
      manager,
      callbackUser,
      'https://api.poolstatis.xyz',
    )).resolves.toBe('callback-access-token');
  });
});
