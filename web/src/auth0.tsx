import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { useCallback } from 'react';
import type { ReactNode } from 'react';

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN as string | undefined,
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined,
  audience: import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined,
  apiUrl: ((import.meta.env.VITE_POOLSTATIS_API_URL as string | undefined) ?? '').replace(/\/$/, ''),
};

export const hostedAuthScope = 'openid profile email';

export const auth0Enabled = Boolean(auth0Config.domain && auth0Config.clientId && auth0Config.audience && auth0Config.apiUrl);
export const auth0Incomplete = Boolean(auth0Config.domain || auth0Config.clientId || auth0Config.audience || auth0Config.apiUrl) && !auth0Enabled;

export function OptionalAuth0Provider({ children }: { children: ReactNode }) {
  if (!auth0Enabled) return <>{children}</>;
  return (
    <Auth0Provider
      domain={auth0Config.domain!}
      clientId={auth0Config.clientId!}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Config.audience!,
        scope: hostedAuthScope,
      }}
      onRedirectCallback={(appState) => {
        window.history.replaceState({}, document.title, appState?.returnTo || window.location.pathname);
      }}
    >
      {children}
    </Auth0Provider>
  );
}

export function useHostedToken() {
  const { getAccessTokenSilently } = useAuth0();
  return useCallback(() => getAccessTokenSilently({
    authorizationParams: {
      audience: auth0Config.audience!,
      scope: hostedAuthScope,
    },
  }), [getAccessTokenSilently]);
}
