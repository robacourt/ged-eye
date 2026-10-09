/**
 * Sign-in for editors, through Neon Auth (Managed Better Auth) and its `@neondatabase/auth` client.
 *
 * The session lives in a cross-site, partitioned cookie on the Auth domain. The API never sees that cookie:
 * it gets a short-lived JWT (15 minutes) as a bearer token, which `getSession()` returns as `session.token`.
 *
 * Besides the signed-in user, this module caches the user's role from `GET /me` (set by `editApi.me()`),
 * so the data loader knows whether to ask for unmasked views.
 */

/** Refresh the JWT when fewer than this many seconds remain. */
const REFRESH_MARGIN_S = 60;
/** The Auth server appends this to the callback URL when an OAuth (Google) sign-in completes. */
const OAUTH_VERIFIER_PARAM = 'neon_auth_session_verifier';

/** A sign-in failure: `message` is the Auth server's (or a network message), `code` 'network' when unreachable. */
export class AuthClientError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = 'AuthClientError';
    this.status = status;
    this.code = code;
  }
}

function toAuthClientError(error) {
  if (error instanceof AuthClientError) return error;
  if (error instanceof TypeError) {
    return new AuthClientError("Couldn't reach the sign-in service. Check your connection and try again.", { code: 'network' });
  }
  return new AuthClientError(error?.message || 'Sign-in failed.', { status: error?.status ?? null, code: error?.code ?? null });
}

/** The `exp` claim (seconds since the epoch) of a JWT, or null if `token` isn't a JWT with a numeric exp. */
export function jwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const binary = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    return typeof payload?.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// A fresh object each time, so nothing the SDK does to the options leaks into the next call.
const forceFetch = () => ({ fetchOptions: { headers: { 'X-Force-Fetch': 'true' } } });

const sameEmail = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * @param client  a `createAuthClient(url)` instance (or a fake with the same methods)
 * @param dev     whether to offer the password sign-in (development accounts only)
 */
export function createAuth({ client, dev = import.meta.env.DEV }) {
  let user = null; // { email, name }
  let role = null; // 'admin' | 'editor' | null, from GET /me
  let cookieBlocked = false;
  // Bumped whenever the signed-in user changes, so a session read that started before then is ignored.
  let epoch = 0;
  let refreshing = null;
  const listeners = new Set();

  const getState = () => ({ user, role, cookieBlocked });

  function emit(reason) {
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state, reason);
      } catch (error) {
        console.error('Sign-in listener failed', error);
      }
    }
  }

  function setUser(next, reason) {
    epoch++;
    user = next ? { email: next.email, name: next.name ?? null } : null;
    role = null;
    if (next) cookieBlocked = false;
    emit(reason);
  }

  function reportCookieBlocked() {
    epoch++;
    user = null;
    role = null;
    cookieBlocked = true;
    emit('cookie-blocked');
  }

  /** Runs a client call. The SDK both throws (non-2xx, network) and returns `{ error }`; both become AuthClientError. */
  async function call(run) {
    let result;
    try {
      result = await run();
    } catch (error) {
      throw toAuthClientError(error);
    }
    if (result?.error) throw toAuthClientError(result.error);
    return result?.data ?? null;
  }

  /** `{ session, user }`, or null when signed out. `force` skips the SDK's cache and reads the cookie's session. */
  async function readSession(force) {
    const data = await call(() => (force ? client.getSession(forceFetch()) : client.getSession()));
    return data?.session && data?.user ? data : null;
  }

  /** Keeps `user` in step with the cookie, which another tab may have signed out or switched. */
  function follow(session) {
    if (!session) {
      if (user) setUser(null, 'expired');
      return null;
    }
    if (!sameEmail(session.user.email, user?.email)) setUser(session.user, 'signed-in');
    return session.session.token ?? null;
  }

  const STALE = Symbol('stale');

  /** A forced session read, shared by concurrent callers. STALE if the user changed while it was in flight. */
  function refresh() {
    if (refreshing?.epoch === epoch) return refreshing.promise;
    const startedIn = epoch;
    const promise = readSession(true)
      .then(session => (startedIn === epoch ? follow(session) : STALE))
      .finally(() => {
        if (refreshing?.promise === promise) refreshing = null;
      });
    refreshing = { epoch: startedIn, promise };
    return promise;
  }

  /** After a sign-in call succeeds: a fresh read proves the cookie stuck (and fetches the JWT). */
  async function completeSignIn() {
    const session = await readSession(true);
    if (session) setUser(session.user, 'signed-in');
    else reportCookieBlocked();
    return getState();
  }

  const auth = {
    getState,

    getRole: () => role,

    /** Caches the role from GET /me. Ignored unless `email` (when given) is the signed-in user's. */
    setRole(nextRole, email) {
      if (!user) return;
      if (email != null && !sameEmail(email, user.email)) return;
      role = nextRole ?? null;
    },

    /** `listener(state, reason)`, reason one of restored, signed-in, signed-out, expired, cookie-blocked. Returns an unsubscribe function. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Restores the session on page load, including the return from a Google redirect. Never throws for an
     * unreachable Auth service: viewing works signed out.
     */
    async init() {
      const returningFromOAuth = new URLSearchParams(globalThis.location?.search ?? '').has(OAUTH_VERIFIER_PARAM);
      let session;
      try {
        session = await readSession(false);
        // The one-time verifier can yield a session even when the browser refused the cookie; check it stuck.
        if (session && returningFromOAuth) session = await readSession(true);
      } catch (error) {
        console.warn('Could not restore the sign-in session', error);
        return getState();
      }
      if (session) setUser(session.user, returningFromOAuth ? 'signed-in' : 'restored');
      else if (returningFromOAuth) reportCookieBlocked();
      return getState();
    },

    /**
     * The JWT for the API, or null when signed out. Refreshes it when fewer than 60 s remain (or when `force`).
     * A refresh that finds no session signs out locally (listeners hear 'expired') and returns null.
     * Throws AuthClientError when the Auth service can't be reached.
     */
    async getToken({ force = false } = {}) {
      if (!user) return null;
      if (!force) {
        const startedIn = epoch;
        const session = await readSession(false);
        // Signed in or out meanwhile: start again for whoever is signed in now.
        if (startedIn !== epoch) return auth.getToken();
        const token = follow(session);
        const exp = token ? jwtExpiry(token) : null;
        if (exp !== null && exp - Date.now() / 1000 >= REFRESH_MARGIN_S) return token;
        if (!user) return null;
      }
      const token = await refresh();
      return token === STALE ? auth.getToken({ force }) : token;
    },

    async sendEmailCode(email) {
      await call(() => client.emailOtp.sendVerificationOtp({ email, type: 'sign-in' }));
    },

    /** Resolves to the new state: signed in, or `cookieBlocked` when the browser dropped the session cookie. */
    async verifyEmailCode(email, otp) {
      await call(() => client.signIn.emailOtp({ email, otp }));
      return completeSignIn();
    },

    /** Navigates to Google; `init()` picks up the session when the browser comes back to this page. */
    async signInWithGoogle() {
      await call(() => client.signIn.social({ provider: 'google', callbackURL: globalThis.location.href }));
    },

    /** Signs out locally even when the server call fails (which is then rethrown). */
    async signOut() {
      try {
        await call(() => client.signOut());
      } finally {
        if (user) setUser(null, 'signed-out');
      }
    }
  };

  if (dev) {
    /** Development accounts only (`dev-*@example.test` on the `editing` branch). */
    auth.signInWithPassword = async (email, password) => {
      await call(() => client.signIn.email({ email, password }));
      return completeSignIn();
    };
  }

  return auth;
}

// The app's client. The SDK (about 100 KB gzipped) is loaded on first use, so it stays off viewing's critical path.
let instance = null; // once loaded
let loading = null;  // Promise<instance>
const listeners = new Set();

function defaultAuth() {
  loading ??= (async () => {
    const url = import.meta.env.VITE_NEON_AUTH_URL;
    if (!url) throw new Error('VITE_NEON_AUTH_URL is not configured');
    const { createAuthClient } = await import('@neondatabase/auth');
    const auth = createAuth({ client: createAuthClient(url) });
    auth.onChange((state, reason) => {
      for (const listener of [...listeners]) {
        try {
          listener(state, reason);
        } catch (error) {
          console.error('Sign-in listener failed', error);
        }
      }
    });
    instance = auth;
    return auth;
  })().catch(error => {
    loading = null; // a failed chunk load can be retried
    throw error;
  });
  return loading;
}

/** Restores the session; call once on page load. The other sign-in calls load the client too if needed. */
export async function init() { return (await defaultAuth()).init(); }
export async function sendEmailCode(email) { return (await defaultAuth()).sendEmailCode(email); }
export async function verifyEmailCode(email, otp) { return (await defaultAuth()).verifyEmailCode(email, otp); }
export async function signInWithGoogle() { return (await defaultAuth()).signInWithGoogle(); }
export async function signOut() { return (await defaultAuth()).signOut(); }
export const signInWithPassword = import.meta.env.DEV
  ? async (email, password) => (await defaultAuth()).signInWithPassword(email, password)
  : undefined;

/** `listener(state, reason)`; may be called before init(). Returns an unsubscribe function. */
export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// These answer "signed out" until the client has loaded, and never load it.
export function getState() { return instance ? instance.getState() : { user: null, role: null, cookieBlocked: false }; }
export function getRole() { return instance ? instance.getRole() : null; }
export function setRole(role, email) { instance?.setRole(role, email); }
export async function getToken(options) { return instance ? instance.getToken(options) : null; }
