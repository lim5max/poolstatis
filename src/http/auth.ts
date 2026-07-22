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
  /** Explicit operator opt-in for adopting pre-017 rows with no issuer binding. */
  legacyIssuer?: string | null;
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

function verifiedEmailClaim(payload: Record<string, unknown>, name: string): string | null {
  const email = stringClaim(payload, name)?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function hostedUnauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'authentication failed');
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
      requiredClaims: ['sub', 'exp'],
    });
    payload = verified.payload;
  } catch {
    throw hostedUnauthorized();
  }
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) throw hostedUnauthorized();
  const claims = options.claims ?? standardClaimNames;
  const email = verifiedEmailClaim(payload, claims.email);
  if (payload[claims.emailVerified] !== true || !email) {
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
    email,
    emailVerified: true,
    displayName: stringClaim(payload, claims.displayName),
    pictureUrl: stringClaim(payload, claims.picture),
    connectionStrategy: options.connectionStrategy ?? 'oidc',
    legacyIssuer: options.legacyIssuer ?? null,
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
    `SELECT k.id, k.org_id, k.project_id, k.kind, k.env, k.issued_by_user_id,
            om.role AS issued_user_role
     FROM api_keys k
     LEFT JOIN organization_members om
       ON om.org_id = k.org_id AND om.user_id = k.issued_by_user_id
     WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (!rows[0]) {
    if (jwtOptions) return authenticateJwt(pool, token, jwtOptions);
    throw unauthorized('unknown or revoked API key');
  }
  const key = rows[0];
  // NULL owner denotes a legacy/self-host token and preserves the existing
  // token protocol. Hosted personal tokens require a current membership.
  if (key.kind === 'personal' && key.issued_by_user_id && !key.issued_user_role) {
    throw unauthorized('personal token owner no longer belongs to this organization');
  }
  if (key.kind === 'personal') {
    await pool.query(
      'UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [key.id],
    );
  }
  return {
    keyId: key.id,
    orgId: key.org_id,
    projectId: key.project_id,
    kind: key.kind,
    env: key.env,
    ...(key.issued_by_user_id && key.issued_user_role ? {
      userId: key.issued_by_user_id as string,
      userRole: key.issued_user_role as NonNullable<AuthContext['userRole']>,
    } : {}),
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
