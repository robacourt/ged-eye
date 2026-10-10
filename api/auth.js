import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ApiError } from './http.js';

export class AuthError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

// jose errors that mean "this token is no good". Anything else is our problem, not the caller's,
// and propagates as a 500: JWKS timeout, network failure, a malformed JWKS response, a malformed
// JWK (ERR_JWK_INVALID, ERR_JWKS_INVALID) or duplicate kids in the JWKS (ERR_JWKS_MULTIPLE_MATCHING_KEYS).
const TOKEN_ERROR_CODES = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY'
]);

// Asymmetric only. RFC 9864 renames EdDSA to Ed25519/Ed448; Neon Auth signs with EdDSA today.
const ALGORITHMS = ['EdDSA', 'Ed25519'];
const MAX_TOKEN_AGE = '1h';

const BEARER = /^Bearer[ \t]+(\S+)$/i;

function unauthenticated(message) {
  return new AuthError(401, 'unauthenticated', message);
}

/**
 * @param jwksUrl  Neon Auth JWKS endpoint (ignored when getKey is given)
 * @param issuer   origin of the Neon Auth base URL; used as both `iss` and `aud`
 * @param getKey   optional key or key resolver for jwtVerify (tests inject a local public key)
 * @returns authenticate(request) -> Promise<{ email, name, sub } | null>
 */
export function createAuthenticator({ jwksUrl, issuer, getKey }) {
  // Created once so jose can cache the key set across requests.
  const keys = getKey ?? createRemoteJWKSet(new URL(jwksUrl));

  return async function authenticate(request) {
    const header = request.headers.get('authorization');
    if (header === null) return null;

    const match = BEARER.exec(header.trim());
    if (!match) throw unauthenticated('malformed Authorization header');

    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], keys, {
        issuer,
        audience: issuer,
        algorithms: ALGORITHMS,
        // jose does not require exp by default: without it a signed token would never expire.
        requiredClaims: ['exp', 'sub'],
        maxTokenAge: MAX_TOKEN_AGE
      }));
    } catch (error) {
      if (TOKEN_ERROR_CODES.has(error?.code)) throw unauthenticated(error.message);
      throw error;
    }

    if (payload.emailVerified !== true) throw unauthenticated('email not verified');
    if (typeof payload.email !== 'string' || payload.email === '') throw unauthenticated('token has no email');

    return {
      email: payload.email.toLowerCase(),
      name: typeof payload.name === 'string' && payload.name !== '' ? payload.name : null,
      sub: payload.sub
    };
  };
}

/**
 * The Function's authenticator, from the env vars Neon injects when Auth is enabled on the branch.
 * Without them, requests with no Authorization header are anonymous (the public site still works),
 * but a request with one is a 500: its token can't be checked, and must never be silently ignored.
 * That misconfiguration is logged once, not per request.
 */
export function authenticatorFromEnv({ NEON_AUTH_JWKS_URL, NEON_AUTH_BASE_URL }, { log = console.error } = {}) {
  if (NEON_AUTH_JWKS_URL && NEON_AUTH_BASE_URL) {
    return createAuthenticator({ jwksUrl: NEON_AUTH_JWKS_URL, issuer: new URL(NEON_AUTH_BASE_URL).origin });
  }
  let logged = false;
  return async function authenticate(request) {
    if (request.headers.get('authorization') === null) return null;
    if (!logged) {
      logged = true;
      log('Neon Auth is not configured (NEON_AUTH_JWKS_URL and NEON_AUTH_BASE_URL): requests with an Authorization header get 500');
    }
    throw new ApiError(500, 'internal');
  };
}

/**
 * @param user          result of authenticate(), or null
 * @param lookupEditor  (email) => Promise<{ email, name, role } | null>
 * @returns { email, name, role } where name prefers the editor row over the token
 */
export async function requireEditor(user, lookupEditor) {
  if (!user) throw new AuthError(401, 'unauthenticated');
  const editor = await lookupEditor(user.email);
  if (!editor) throw new AuthError(403, 'not_an_editor');
  return { email: user.email, name: editor.name ?? user.name, role: editor.role };
}

/**
 * The editor making `request`, for a Function's routes (api and media share it).
 * @param request       the incoming Request
 * @param authenticate  (request) → { email, name } | null; throws AuthError(401) for a bad token
 * @param lookupEditor  (email) => Promise<{ email, name, role } | null>
 * @returns { email, name, role }, as requireEditor does. Throws AuthError 401 unauthenticated for no user, and
 *   ApiError 403 not_an_editor, carrying the account's `email`, for a signed-in account not on the editors list.
 */
export async function requireEditorOf(request, authenticate, lookupEditor) {
  const user = await authenticate(request);
  try {
    return await requireEditor(user, lookupEditor);
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) throw new ApiError(403, 'not_an_editor', { email: user.email });
    throw error;
  }
}
