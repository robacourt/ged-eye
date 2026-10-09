// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

async function sign(claims = {}, {
  key = privateKey,
  alg = 'EdDSA',
  issuer = ISSUER,
  audience = ISSUER,
  expiresIn = '15m'
} = {}) {
  const jwt = new SignJWT({ email: 'Rob@Example.com', emailVerified: true, name: 'Rob', ...claims })
    .setProtectedHeader({ alg, kid: 'test-key' })
    .setSubject(claims.sub ?? 'user-1')
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience);
  jwt.setExpirationTime(expiresIn);
  return jwt.sign(key);
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
    const token = await sign({}, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
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

  beforeAll(async () => {
    hits = 0;
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'EdDSA', use: 'sig' };
    server = createServer((request, response) => {
      hits += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${server.address().port}/jwks.json`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('verifies against the JWKS endpoint and fetches it once per authenticator', async () => {
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const before = hits;
    for (let i = 0; i < 3; i += 1) {
      const user = await remote(req(`Bearer ${await sign()}`));
      expect(user.email).toBe('rob@example.com');
    }
    expect(hits - before).toBe(1);
  });

  it('rejects a token whose kid is not in the JWKS with 401', async () => {
    const remote = createAuthenticator({ jwksUrl, issuer: ISSUER });
    const jwt = new SignJWT({ email: 'rob@example.com', emailVerified: true })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown-key' })
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setExpirationTime('15m');
    const error = await rejection(remote(req(`Bearer ${await jwt.sign(privateKey)}`)));
    expect(error).toBeInstanceOf(AuthError);
    expect(error.status).toBe(401);
  });

  it('does not report an unreachable JWKS endpoint as a bad token', async () => {
    const remote = createAuthenticator({ jwksUrl: 'http://127.0.0.1:1/jwks.json', issuer: ISSUER });
    const error = await rejection(remote(req(`Bearer ${await sign()}`)));
    expect(error).not.toBeInstanceOf(AuthError);
  });
});
