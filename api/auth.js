import { createRemoteJWKSet, jwtVerify } from 'jose';

export class AuthError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

// jose errors that mean "this token is no good". Anything else (JWKS timeout, network failure,
// a malformed JWKS response) is our problem, not the caller's, and propagates as a 500.
const TOKEN_ERROR_CODES = new Set([
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWK_INVALID'
]);

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
        algorithms: ['EdDSA']
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
