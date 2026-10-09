// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createAuthenticator, requireEditor, AuthError } from '../api/auth.js';

const ISSUER = 'https://auth.example.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

let publicKey;
let privateKey;
let authenticate;

beforeAll(async () => {
  ({ publicKey, privateKey } = await generateKeyPair('EdDSA'));
  authenticate = createAuthenticator({ jwksUrl: JWKS_URL, issuer: ISSUER, getKey: async () => publicKey });
});

// expiresIn / issuedAt: undefined = default (15m from now / now), null = omit the claim,
// a number = that absolute epoch-seconds value. subject: null omits `sub`.
async function sign(claims = {}, {
  key = privateKey,
  alg = 'EdDSA',
  issuer = ISSUER,
  audience = ISSUER,
  subject = 'user-1',
  issuedAt,
  expiresIn
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ email: 'Rob@Example.com', emailVerified: true, name: 'Rob', ...claims })
    .setProtectedHeader({ alg, kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience);
  if (subject !== null) jwt.setSubject(subject);
  if (issuedAt !== null) jwt.setIssuedAt(issuedAt ?? now);
  if (expiresIn !== null) jwt.setExpirationTime(expiresIn ?? now + 15 * 60);
  return jwt.sign(key);
}

// jose will not sign with alg "none", so build the unsecured JWT by hand.
function unsecuredToken(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.`;
}

function req(authorization) {
  const headers = authorization === undefined ? {} : { authorization };
  return new Request('https://api.example.test/me', { headers });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('createAuthenticator', () => {
  it('accepts a valid token and returns the lower-cased email, name and sub', async () => {
    const token = await sign();
    const user = await authenticate(req(`Bearer ${token}`));
    expect(user).toEqual({ email: 'rob@example.com', name: 'Rob', sub: 'user-1' });
  });

  it('accepts a case-insensitive Bearer scheme', async () => {
    const token = await sign();
    const user = await authenticate(req(`bearer ${token}`));
    expect(user.email).toBe('rob@example.com');
  });

  it('returns a null name when the token has none', async () => {
    const token = await sign({ name: undefined });
    const user = await authenticate(req(`Bearer ${token}`));
    expect(user).toEqual({ email: 'rob@example.com', name: null, sub: 'user-1' });
  });

  it('returns null when there is no Authorization header', async () => {
    expect(await authenticate(req())).toBeNull();
  });

  it('rejects an expired token with 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({}, { issuedAt: now - 120, expiresIn: now - 60 });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await sign({}, { issuer: 'https://evil.example.test' });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const token = await sign({}, { audience: 'https://other.example.test' });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('EdDSA');
    const token = await sign({}, { key: other.privateKey });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('accepts the Ed25519 algorithm name (RFC 9864 renames EdDSA)', async () => {
    const token = await sign({}, { alg: 'Ed25519' });
    const user = await authenticate(req(`Bearer ${token}`));
    expect(user.email).toBe('rob@example.com');
  });

  it('rejects a token with no exp claim (it would be valid forever)', async () => {
    const token = await sign({}, { expiresIn: null });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token with no sub claim', async () => {
    const token = await sign({}, { subject: null });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token with no iat claim', async () => {
    const token = await sign({}, { issuedAt: null });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token issued more than an hour ago even if exp is in the future', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign({}, { issuedAt: now - 2 * 60 * 60, expiresIn: now + 15 * 60 });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects an unsecured (alg: none) token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = unsecuredToken({
      email: 'rob@example.com', emailVerified: true, name: 'Rob', sub: 'user-1',
      iss: ISSUER, aud: ISSUER, iat: now, exp: now + 900
    });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects an HS256-signed token (algorithm is pinned to EdDSA)', async () => {
    const secret = new TextEncoder().encode('x'.repeat(32));
    const token = await sign({}, { key: secret, alg: 'HS256' });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects emailVerified: false with 401', async () => {
    const token = await sign({ emailVerified: false });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1]
  ])('rejects emailVerified as %s (it must be boolean true)', async (_label, value) => {
    const token = await sign({ emailVerified: value });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('rejects a token with no emailVerified claim', async () => {
    const token = await sign({ emailVerified: undefined });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error.status).toBe(401);
  });

  it('rejects a token with no email', async () => {
    const token = await sign({ email: undefined });
    const error = await rejection(authenticate(req(`Bearer ${token}`)));
    expect(error.status).toBe(401);
  });

  it.each([
    ['a Basic scheme', 'Basic x'],
    ['Bearer with no token', 'Bearer'],
    ['Bearer with only a space', 'Bearer '],
    ['a non-JWT token', 'Bearer not-a-jwt'],
    ['an empty header', '']
  ])('rejects %s with 401', async (_label, header) => {
    const error = await rejection(authenticate(req(header)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
  });
});

describe('requireEditor', () => {
  const user = { email: 'rob@example.com', name: 'Token Rob', sub: 'user-1' };

  it('returns the editor with its role', async () => {
    const lookup = async (email) => ({ email, name: 'Rob', role: 'editor' });
    expect(await requireEditor(user, lookup)).toEqual({ email: 'rob@example.com', name: 'Rob', role: 'editor' });
  });

  it('returns an admin', async () => {
    const lookup = async (email) => ({ email, name: 'Rob', role: 'admin' });
    expect((await requireEditor(user, lookup)).role).toBe('admin');
  });

  it('passes the lower-cased email to the lookup', async () => {
    const seen = [];
    await requireEditor(user, async (email) => {
      seen.push(email);
      return { email, name: 'Rob', role: 'editor' };
    });
    expect(seen).toEqual(['rob@example.com']);
  });

  it('falls back to the token name when the editor row has none', async () => {
    const lookup = async (email) => ({ email, name: null, role: 'editor' });
    expect((await requireEditor(user, lookup)).name).toBe('Token Rob');
  });

  it('throws 403 not_an_editor for an unlisted user', async () => {
    const error = await rejection(requireEditor(user, async () => null));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('not_an_editor');
  });

  it('throws 401 unauthenticated for a null user, without calling lookup', async () => {
    let called = false;
    const error = await rejection(requireEditor(null, async () => { called = true; return null; }));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('unauthenticated');
    expect(called).toBe(false);
  });
});

describe('createAuthenticator without getKey (remote JWKS)', () => {
  let server;
  let jwksUrl;
  let hits;
  let goodJwk;
  let respond;

  // Each test gets a fresh authenticator (and so a fresh JWKS cache); `respond` picks what the
  // JWKS endpoint says.
  const serveKeys = (keys) => (response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys }));
  };

  beforeAll(async () => {
    goodJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'EdDSA', use: 'sig' };
    server = createServer((request, response) => {
      hits += 1;
      respond(response);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${server.address().port}/jwks.json`;
  });

  beforeEach(() => {
    hits = 0;
    respond = serveKeys([goodJwk]);
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('verifies against the JWKS endpoint and fetches it once per authenticator', async () => {
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    for (let i = 0; i < 3; i += 1) {
      const user = await remote(req(`Bearer ${await sign()}`));
      expect(user.email).toBe('rob@example.com');
    }
    expect(hits).toBe(1);
  });

  it('rejects a token whose kid is not in the JWKS with 401', async () => {
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ email: 'rob@example.com', emailVerified: true })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown-key' })
      .setSubject('user-1')
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(privateKey);
    const error = await rejection(remote(req(`Bearer ${token}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  // The JWKS is ours to get right, not the caller's: these are server errors, never 401.
  it('rethrows (does not 401) when the JWKS endpoint is unreachable', async () => {
    const remote = createAuthenticator({ jwksUrl: 'http://127.0.0.1:1/jwks.json', issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TypeError'); // fetch failed, not a JOSE token error
    expect(String(error.code ?? '')).not.toMatch(/^ERR_J/);
  });

  it('rethrows when the JWKS endpoint answers with an error status', async () => {
    respond = (response) => {
      response.statusCode = 503;
      response.end('unavailable');
    };
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it('rethrows when the JWKS body is not JSON', async () => {
    respond = (response) => response.end('<html>not json</html>');
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it('rethrows ERR_JWKS_MULTIPLE_MATCHING_KEYS when the JWKS has duplicate kids', async () => {
    respond = serveKeys([goodJwk, { ...goodJwk }]);
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error.code).toBe('ERR_JWKS_MULTIPLE_MATCHING_KEYS');
  });

  it('rethrows ERR_JWKS_INVALID when the JWKS contains a private key', async () => {
    const extractable = await generateKeyPair('EdDSA', { extractable: true });
    respond = serveKeys([{ ...goodJwk, ...(await exportJWK(extractable.privateKey)) }]);
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error.code).toBe('ERR_JWKS_INVALID');
  });

  it('rethrows ERR_JWKS_INVALID when the JWKS is not a key set', async () => {
    respond = (response) => response.end(JSON.stringify({ keys: 'nope' }));
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error.code).toBe('ERR_JWKS_INVALID');
  });

  it('rethrows when the matching JWK is malformed', async () => {
    respond = serveKeys([{ ...goodJwk, x: 'AAAA' }]);
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
  });
});
