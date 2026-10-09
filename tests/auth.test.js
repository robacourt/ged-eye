import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuth, AuthClientError, jwtExpiry } from '../src/auth.js';

const FORCE = { fetchOptions: { headers: { 'X-Force-Fetch': 'true' } } };
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (secondsLeft, claims = {}) =>
  `${b64url({ alg: 'EdDSA', kid: 'k1' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + secondsLeft, ...claims })}.signature`;
const sessionFor = (email, token = jwt(900)) => ({ session: { token }, user: { id: 'u1', email, name: 'Rose Smith', emailVerified: true } });
const ok = (data) => ({ data, error: null });

/**
 * A stand-in for the @neondatabase/auth client. `cached` is what a plain getSession() returns (the SDK's
 * in-memory cache); `server` is what a forced fetch returns (the cookie's session, with a fresh JWT).
 */
function fakeClient({ cached = null, server = cached } = {}) {
  const state = { cached, server };
  const client = {
    state,
    getSession: vi.fn(async (options) => {
      if (options?.fetchOptions?.headers?.['X-Force-Fetch'] === 'true') {
        state.cached = state.server;
        return ok(state.server);
      }
      return ok(state.cached);
    }),
    emailOtp: { sendVerificationOtp: vi.fn(async () => ok({ success: true })) },
    signIn: {
      emailOtp: vi.fn(async ({ email }) => ok({ token: 'opaque-session-token', user: { email } })),
      email: vi.fn(async ({ email }) => ok({ token: 'opaque-session-token', user: { email } })),
      social: vi.fn(async () => ok({ url: 'https://accounts.google.com/o/oauth2', redirect: true }))
    },
    signOut: vi.fn(async () => ok({ success: true }))
  };
  return client;
}

describe('auth', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  describe('init', () => {
    it('restores the session from the cookie and tells listeners', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const state = await auth.init();
      expect(state).toEqual({ user: { email: 'rose@example.com', name: 'Rose Smith' }, role: null, cookieBlocked: false });
      expect(listener).toHaveBeenCalledWith(state, 'restored');
      expect(client.getSession).toHaveBeenCalledWith();
    });

    it('stays signed out, without telling listeners, when there is no session', async () => {
      const auth = createAuth({ client: fakeClient() });
      const listener = vi.fn();
      auth.onChange(listener);
      expect(await auth.init()).toEqual({ user: null, role: null, cookieBlocked: false });
      expect(listener).not.toHaveBeenCalled();
    });

    it('stays signed out when the auth service is unreachable, so viewing still works', async () => {
      const client = fakeClient();
      client.getSession.mockRejectedValue(new TypeError('Failed to fetch'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const auth = createAuth({ client });
      expect(await auth.init()).toEqual({ user: null, role: null, cookieBlocked: false });
    });

    it('confirms the cookie after a Google redirect and reports a sign-in', async () => {
      window.history.replaceState(null, '', '/?person=I1&neon_auth_session_verifier=v123');
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const state = await auth.init();
      expect(state.user.email).toBe('rose@example.com');
      expect(listener).toHaveBeenCalledWith(state, 'signed-in');
      expect(client.getSession).toHaveBeenLastCalledWith(FORCE);
    });

    it('reports cookieBlocked when a Google sign-in completed but the cookie did not stick', async () => {
      window.history.replaceState(null, '', '/?neon_auth_session_verifier=v123');
      // The one-time verifier yields a session once, but the browser dropped the cookie.
      const client = fakeClient({ cached: sessionFor('rose@example.com'), server: null });
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const state = await auth.init();
      expect(state).toEqual({ user: null, role: null, cookieBlocked: true });
      expect(listener).toHaveBeenCalledWith(state, 'cookie-blocked');
    });

    it('reports cookieBlocked when a Google redirect comes back with no session at all', async () => {
      window.history.replaceState(null, '', '/?neon_auth_session_verifier=v123');
      const auth = createAuth({ client: fakeClient() });
      expect((await auth.init()).cookieBlocked).toBe(true);
    });
  });

  describe('getToken', () => {
    async function signedIn(client) {
      const auth = createAuth({ client });
      await auth.init();
      client.getSession.mockClear();
      return auth;
    }

    it('returns null without asking the server when signed out', async () => {
      const client = fakeClient();
      const auth = createAuth({ client });
      expect(await auth.getToken()).toBeNull();
      expect(client.getSession).not.toHaveBeenCalled();
    });

    it('returns the cached JWT while more than 60 s remain', async () => {
      const token = jwt(61);
      const client = fakeClient({ cached: sessionFor('rose@example.com', token) });
      const auth = await signedIn(client);
      expect(await auth.getToken()).toBe(token);
      expect(client.getSession).toHaveBeenCalledTimes(1);
      expect(client.getSession).toHaveBeenCalledWith();
    });

    it('forces a fresh fetch when fewer than 60 s remain', async () => {
      const fresh = jwt(900);
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(59)), server: sessionFor('rose@example.com', fresh) });
      const auth = await signedIn(client);
      expect(await auth.getToken()).toBe(fresh);
      expect(client.getSession).toHaveBeenLastCalledWith(FORCE);
    });

    it('forces a fresh fetch when the cached token is not a JWT (the opaque token right after sign-in)', async () => {
      const fresh = jwt(900);
      const client = fakeClient({ cached: sessionFor('rose@example.com', 'opaque-session-token'), server: sessionFor('rose@example.com', fresh) });
      const auth = await signedIn(client);
      expect(await auth.getToken()).toBe(fresh);
    });

    it('forces a fresh fetch when asked to', async () => {
      const fresh = jwt(900);
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(600)), server: sessionFor('rose@example.com', fresh) });
      const auth = await signedIn(client);
      expect(await auth.getToken({ force: true })).toBe(fresh);
      expect(client.getSession).toHaveBeenCalledTimes(1);
      expect(client.getSession).toHaveBeenCalledWith(FORCE);
    });

    it('shares one forced fetch between concurrent callers', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(10)), server: sessionFor('rose@example.com', jwt(900)) });
      const auth = await signedIn(client);
      const [a, b] = await Promise.all([auth.getToken(), auth.getToken()]);
      expect(a).toBe(b);
      expect(client.getSession.mock.calls.filter(([options]) => options)).toHaveLength(1);
    });

    it('signs out locally, telling listeners it expired, when the refresh finds no session', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(10)), server: null });
      const auth = await signedIn(client);
      auth.setRole('editor');
      const listener = vi.fn();
      auth.onChange(listener);
      expect(await auth.getToken()).toBeNull();
      expect(auth.getState()).toEqual({ user: null, role: null, cookieBlocked: false });
      expect(listener).toHaveBeenCalledWith(auth.getState(), 'expired');
    });

    it('throws an AuthClientError when the refresh cannot reach the auth service, staying signed in', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(10)) });
      const auth = await signedIn(client);
      client.getSession.mockRejectedValue(new TypeError('Failed to fetch'));
      const error = await auth.getToken().catch(e => e);
      expect(error).toBeInstanceOf(AuthClientError);
      expect(error.code).toBe('network');
      expect(auth.getState().user.email).toBe('rose@example.com');
    });

    it('does not sign back in when a refresh that was in flight finishes after sign-out', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(10)), server: sessionFor('rose@example.com', jwt(900)) });
      const auth = await signedIn(client);
      let finishRefresh;
      client.getSession.mockImplementation(async (options) => {
        if (!options) return ok(client.state.cached);
        await new Promise(resolve => { finishRefresh = resolve; });
        client.state.cached = client.state.server;
        return ok(client.state.server);
      });
      const pending = auth.getToken();
      await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
      await auth.signOut();
      finishRefresh();
      expect(await pending).toBeNull();
      expect(auth.getState().user).toBeNull();
    });

    it('does not sign back in when a plain session read that was in flight finishes after sign-out', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = await signedIn(client);
      let finishRead;
      client.getSession.mockImplementationOnce(async () => {
        await new Promise(resolve => { finishRead = resolve; });
        return ok(sessionFor('rose@example.com'));
      });
      const pending = auth.getToken();
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
      await auth.signOut();
      finishRead();
      expect(await pending).toBeNull();
      expect(auth.getState().user).toBeNull();
    });

    it('does not share a refresh from before a sign-out with the next user', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com', jwt(10)), server: sessionFor('rose@example.com', jwt(900)) });
      const auth = await signedIn(client);
      const finishers = [];
      client.getSession.mockImplementation(async (options) => {
        if (!options) return ok(client.state.cached);
        await new Promise(resolve => finishers.push(resolve));
        client.state.cached = client.state.server;
        return ok(client.state.server);
      });
      const before = auth.getToken();
      await vi.waitFor(() => expect(finishers).toHaveLength(1));
      await auth.signOut();
      const tomToken = jwt(900);
      client.state.server = sessionFor('tom@example.com', tomToken);
      const signIn = auth.verifyEmailCode('tom@example.com', '123456');
      await vi.waitFor(() => expect(finishers).toHaveLength(2));
      finishers[1]();
      await signIn;
      const after = auth.getToken({ force: true });
      await vi.waitFor(() => expect(finishers).toHaveLength(3));
      finishers[0]();
      finishers[2]();
      expect(await after).toBe(tomToken);
      expect(await before).toBe(tomToken);
      expect(auth.getState().user.email).toBe('tom@example.com');
    });

    it('follows a switch to another account made in another tab, dropping the role', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = await signedIn(client);
      auth.setRole('admin');
      const listener = vi.fn();
      auth.onChange(listener);
      const other = jwt(900);
      client.state.cached = sessionFor('tom@example.com', other);
      expect(await auth.getToken()).toBe(other);
      expect(auth.getState()).toMatchObject({ user: { email: 'tom@example.com' }, role: null });
      expect(listener).toHaveBeenCalledWith(auth.getState(), 'signed-in');
    });
  });

  describe('email code sign-in', () => {
    it('sends a sign-in code', async () => {
      const client = fakeClient();
      await createAuth({ client }).sendEmailCode('rose@example.com');
      expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({ email: 'rose@example.com', type: 'sign-in' });
    });

    it('turns an error result into an AuthClientError with the server message', async () => {
      const client = fakeClient();
      client.emailOtp.sendVerificationOtp.mockResolvedValue({ data: null, error: { message: 'Too many requests', code: 'RATE_LIMITED', status: 429 } });
      const error = await createAuth({ client }).sendEmailCode('rose@example.com').catch(e => e);
      expect(error).toBeInstanceOf(AuthClientError);
      expect(error).toMatchObject({ message: 'Too many requests', code: 'RATE_LIMITED', status: 429 });
    });

    it('verifies the code, confirms the session with a fresh fetch, and tells listeners', async () => {
      const client = fakeClient({ server: sessionFor('rose@example.com') });
      client.state.cached = null;
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const state = await auth.verifyEmailCode('rose@example.com', '123456');
      expect(client.signIn.emailOtp).toHaveBeenCalledWith({ email: 'rose@example.com', otp: '123456' });
      expect(client.getSession).toHaveBeenCalledWith(FORCE);
      expect(state).toEqual({ user: { email: 'rose@example.com', name: 'Rose Smith' }, role: null, cookieBlocked: false });
      expect(listener).toHaveBeenCalledWith(state, 'signed-in');
    });

    it('rethrows a wrong code (the SDK throws for non-2xx) as an AuthClientError, without telling listeners', async () => {
      const client = fakeClient();
      client.signIn.emailOtp.mockRejectedValue(Object.assign(new Error('Invalid OTP'), { status: 400, code: 'invalid_otp' }));
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const error = await auth.verifyEmailCode('rose@example.com', '000000').catch(e => e);
      expect(error).toBeInstanceOf(AuthClientError);
      expect(error).toMatchObject({ message: 'Invalid OTP', status: 400, code: 'invalid_otp' });
      expect(listener).not.toHaveBeenCalled();
    });

    it('reports cookieBlocked when a completed sign-in is followed by an empty session', async () => {
      const client = fakeClient({ server: null });
      const auth = createAuth({ client });
      const listener = vi.fn();
      auth.onChange(listener);
      const state = await auth.verifyEmailCode('rose@example.com', '123456');
      expect(state).toEqual({ user: null, role: null, cookieBlocked: true });
      expect(listener).toHaveBeenCalledWith(state, 'cookie-blocked');
    });

    it('clears cookieBlocked after a later sign-in works', async () => {
      const client = fakeClient({ server: null });
      const auth = createAuth({ client });
      await auth.verifyEmailCode('rose@example.com', '123456');
      client.state.server = sessionFor('rose@example.com');
      expect((await auth.verifyEmailCode('rose@example.com', '123456')).cookieBlocked).toBe(false);
    });
  });

  describe('Google sign-in', () => {
    it('starts the redirect back to the current page', async () => {
      window.history.replaceState(null, '', '/ged-eye/?person=I7');
      const client = fakeClient();
      await createAuth({ client }).signInWithGoogle();
      expect(client.signIn.social).toHaveBeenCalledWith({ provider: 'google', callbackURL: window.location.href });
      expect(client.signIn.social.mock.calls[0][0].callbackURL).toContain('person=I7');
    });

    it('reports a failure to start', async () => {
      const client = fakeClient();
      client.signIn.social.mockResolvedValue({ data: null, error: { message: 'Provider not found', status: 404 } });
      await expect(createAuth({ client }).signInWithGoogle()).rejects.toThrow('Provider not found');
    });
  });

  describe('password sign-in', () => {
    it('exists only in development', () => {
      expect(createAuth({ client: fakeClient(), dev: false }).signInWithPassword).toBeUndefined();
      expect(typeof createAuth({ client: fakeClient(), dev: true }).signInWithPassword).toBe('function');
    });

    it('signs in with email and password', async () => {
      const client = fakeClient({ server: sessionFor('dev-editor@example.test') });
      const auth = createAuth({ client, dev: true });
      const state = await auth.signInWithPassword('dev-editor@example.test', 'secret');
      expect(client.signIn.email).toHaveBeenCalledWith({ email: 'dev-editor@example.test', password: 'secret' });
      expect(state.user.email).toBe('dev-editor@example.test');
    });
  });

  describe('sign-out and role', () => {
    async function signedInAuth() {
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = createAuth({ client });
      await auth.init();
      return { auth, client };
    }

    it('signs out, clears the user and role, and tells listeners', async () => {
      const { auth, client } = await signedInAuth();
      auth.setRole('editor');
      const listener = vi.fn();
      auth.onChange(listener);
      await auth.signOut();
      expect(client.signOut).toHaveBeenCalled();
      expect(auth.getState()).toEqual({ user: null, role: null, cookieBlocked: false });
      expect(listener).toHaveBeenCalledWith(auth.getState(), 'signed-out');
    });

    it('still signs out locally when the server call fails, and reports the failure', async () => {
      const { auth, client } = await signedInAuth();
      client.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
      const listener = vi.fn();
      auth.onChange(listener);
      await expect(auth.signOut()).rejects.toBeInstanceOf(AuthClientError);
      expect(auth.getState().user).toBeNull();
      expect(listener).toHaveBeenCalledWith(auth.getState(), 'signed-out');
    });

    it('caches the role for the signed-in user only', async () => {
      const { auth } = await signedInAuth();
      auth.setRole('editor', 'ROSE@example.com');
      expect(auth.getRole()).toBe('editor');
      auth.setRole('admin', 'tom@example.com');
      expect(auth.getRole()).toBe('editor');
      auth.setRole(null);
      expect(auth.getRole()).toBeNull();
    });

    it('ignores a role while signed out', () => {
      const auth = createAuth({ client: fakeClient() });
      auth.setRole('editor');
      expect(auth.getRole()).toBeNull();
    });

    it('stops calling a listener after it unsubscribes, and survives a listener that throws', async () => {
      const client = fakeClient({ cached: sessionFor('rose@example.com') });
      const auth = createAuth({ client });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const thrower = vi.fn(() => { throw new Error('boom'); });
      const removed = vi.fn();
      const kept = vi.fn();
      auth.onChange(thrower);
      auth.onChange(removed)();
      auth.onChange(kept);
      await auth.init();
      expect(thrower).toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(kept).toHaveBeenCalled();
    });
  });

  describe('jwtExpiry', () => {
    it('reads exp from a base64url payload, including non-ASCII claims', () => {
      expect(jwtExpiry(`${b64url({})}.${b64url({ exp: 1234, name: 'Zoë Ø' })}.sig`)).toBe(1234);
    });

    it('returns null for anything that is not a JWT with a numeric exp', () => {
      expect(jwtExpiry('opaque-session-token')).toBeNull();
      expect(jwtExpiry(`${b64url({})}.${b64url({ exp: 'soon' })}.sig`)).toBeNull();
      expect(jwtExpiry('a.!!!.c')).toBeNull();
      expect(jwtExpiry(null)).toBeNull();
    });
  });
});

describe('auth default client', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@neondatabase/auth');
  });

  it('is created lazily from VITE_NEON_AUTH_URL', async () => {
    const client = fakeClient({ cached: sessionFor('rose@example.com') });
    const createAuthClient = vi.fn(() => client);
    vi.doMock('@neondatabase/auth', () => ({ createAuthClient }));
    vi.stubEnv('VITE_NEON_AUTH_URL', 'https://auth.test/neondb/auth');
    const auth = await import('../src/auth.js');
    const listener = vi.fn();
    auth.onChange(listener);
    expect(auth.getRole()).toBeNull();
    expect(auth.getState()).toEqual({ user: null, role: null, cookieBlocked: false });
    expect(await auth.getToken()).toBeNull();
    expect(createAuthClient).not.toHaveBeenCalled();
    await auth.init();
    expect(createAuthClient).toHaveBeenCalledWith('https://auth.test/neondb/auth');
    expect(auth.getState().user.email).toBe('rose@example.com');
    expect(listener).toHaveBeenCalledWith(auth.getState(), 'restored');
    auth.setRole('editor', 'rose@example.com');
    expect(auth.getRole()).toBe('editor');
    expect(await auth.getToken()).toBe(client.state.cached.session.token);
    expect(typeof auth.signInWithPassword).toBe('function'); // vitest runs with import.meta.env.DEV
  });

  it('creates one client however many calls race to load it', async () => {
    const createAuthClient = vi.fn(() => fakeClient());
    vi.doMock('@neondatabase/auth', () => ({ createAuthClient }));
    vi.stubEnv('VITE_NEON_AUTH_URL', 'https://auth.test/neondb/auth');
    const auth = await import('../src/auth.js');
    await Promise.all([auth.init(), auth.sendEmailCode('rose@example.com'), auth.init()]);
    expect(createAuthClient).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when VITE_NEON_AUTH_URL is not configured', async () => {
    vi.doMock('@neondatabase/auth', () => ({ createAuthClient: vi.fn() }));
    vi.stubEnv('VITE_NEON_AUTH_URL', '');
    const auth = await import('../src/auth.js');
    await expect(auth.init()).rejects.toThrow('VITE_NEON_AUTH_URL is not configured');
  });
});
