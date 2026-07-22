import type pg from 'pg';
import {
  createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey,
} from 'jose';
import { hashToken } from '../keys.js';
import { unauthorized, ApiError } from '../errors.js';
import { getOrCreateAuthenticatedAccount } from '../services/accounts.js';

export interface JwtAuthOptions {
  issuer: string;
  audience: string;
  jwksUri?: string;
  jwks?: () => Promise<JSONWebKeySet> | JSONWebKeySet;
  claims?: {
    email: string;
    emailVerified: string;
    displayName: string;
    picture: string;
  };
  connectionStrategy?: string;
}

export interface AuthContext {
  keyId: string | null;
  orgId: string;
  /** Bound project for ingest/secret keys; null for personal (org-wide) tokens. */
  projectId: string | null;
  kind: 'ingest' | 'secret' | 'personal' | 'user';
  env: string;
  userId?: string;
  userEmail?: string | null;
  userRole?: 'owner' | 'admin' | 'member';
  user?: {
    id: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    picture: string | null;
    connectionStrategy: string;
  };
}

const standardClaimNames = {
  email: 'email',
  emailVerified: 'email_verified',
  displayName: 'name',
  picture: 'picture',
};

function stringClaim(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

function bearer(header: string | undefined): string {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw unauthorized();
  return token;
}

function jwksKey(options: JwtAuthOptions): JWTVerifyGetKey {
  if (options.jwks) {
    let local: JWTVerifyGetKey | null = null;
    return async (protectedHeader, token) => {
      if (!local) local = createLocalJWKSet(await options.jwks!());
      return local(protectedHeader, token);
    };
  }
  const uri = options.jwksUri ?? new URL('.well-known/jwks.json', options.issuer).toString();
  return createRemoteJWKSet(new URL(uri));
}

const verifierCache = new WeakMap<JwtAuthOptions, JWTVerifyGetKey>();

async function authenticateJwt(pool: pg.Pool, token: string, options: JwtAuthOptions): Promise<AuthContext> {
  let key = verifierCache.get(options);
  if (!key) {
    key = jwksKey(options);
    verifierCache.set(options, key);
  }
  let payload;
  try {
    const verified = await jwtVerify(token, key, {
      issuer: options.issuer,
      audience: options.audience,
    });
    payload = verified.payload;
  } catch {
    throw unauthorized('invalid hosted auth token');
  }
  if (!payload.sub) throw unauthorized('hosted auth token is missing subject');
  const claims = options.claims ?? standardClaimNames;
  if (payload[claims.emailVerified] !== true) {
    throw new ApiError(
      403,
      'email_verification_required',
      'email verification is required',
      'verify the email address with your identity provider before signing in',
    );
  }
  const account = await getOrCreateAuthenticatedAccount(pool, {
    issuer: options.issuer,
    subject: payload.sub,
    email: stringClaim(payload, claims.email),
    emailVerified: true,
    displayName: stringClaim(payload, claims.displayName),
    pictureUrl: stringClaim(payload, claims.picture),
    connectionStrategy: options.connectionStrategy ?? 'oidc',
  });
  return {
    keyId: null,
    orgId: account.organization.id,
    projectId: null,
    kind: 'user',
    env: 'prod',
    userId: account.user.id,
    userEmail: account.user.email,
    userRole: account.organization.role,
    user: {
      id: account.user.id,
      email: account.user.email,
      emailVerified: account.user.email_verified,
      displayName: account.user.display_name,
      picture: account.user.picture_url,
      connectionStrategy: account.user.connection_strategy,
    },
  };
}

export async function authenticate(
  pool: pg.Pool,
  header: string | undefined,
  jwtOptions?: JwtAuthOptions | null,
): Promise<AuthContext> {
  const token = bearer(header);
  const { rows } = await pool.query(
    `SELECT id, org_id, project_id, kind, env FROM api_keys
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!rows[0]) {
    if (jwtOptions) return authenticateJwt(pool, token, jwtOptions);
    throw unauthorized('unknown or revoked API key');
  }
  return {
    keyId: rows[0].id,
    orgId: rows[0].org_id,
    projectId: rows[0].project_id,
    kind: rows[0].kind,
    env: rows[0].env,
  };
}

export function requireKind(auth: AuthContext, ...kinds: AuthContext['kind'][]): void {
  if (!kinds.includes(auth.kind)) {
    throw new ApiError(
      403,
      'wrong_key_kind',
      `this endpoint requires a ${kinds.join(' or ')} key, got ${auth.kind}`,
      auth.kind === 'ingest'
        ? 'ingest keys (pk_) only write events; use a secret key (sk_) or personal token (pt_) for the platform API'
        : 'use the right key prefix: pk_ for ingest, sk_/pt_ for platform',
    );
  }
}
