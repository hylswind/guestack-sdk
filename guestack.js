// Guestack browser SDK: sends the user to the Guestack page for a per-site pseudonymous ID and
// hands the resulting JWT (or error) back to the site's own code. It never decodes, verifies or
// stores the JWT and never contacts the site's backend.
//
//   Guestack.init({ handler })                     on every page load
//   Guestack.login({ session, returnPath })        from a click handler; navigates away
//   Guestack.version
//
// Source format: the build concatenates this file with config.js into a single script, so the
// only module syntax allowed is `import { … } from "./x.js";` and `export` on top-level
// declarations. Regions between @@PROOF_BEGIN and @@PROOF_END hold the proof check; a
// development build strips them, a release build requires them to be filled.

import { PAGE_URL } from "./config.js";
// @@PROOF_BEGIN imports
// @@PROOF_END

export const VERSION = "0.1.0";

const SESSION_RE = /^[A-Za-z0-9._~-]{1,256}$/;
// Same rule as the page: "#" would swallow the #gs_jwt= fragment, and browsers normalize "\" to
// "/", which would turn "/\host" into an off-site navigation.
const RETURN_RE = /^\/(?!\/)[^\s#\\]*$/;
const JWT_FRAGMENT = /^#gs_jwt=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const ERROR_FRAGMENT = /^#gs_error=([a-z_]{1,64})$/;

/**
 * code ∈ not_top_level | bad_session | bad_return_path (and, with the proof check:
 * proof_unavailable | proof_failed | proof_stale | proof_bad_signature | attestation_invalid).
 */
export class GuestackError extends Error {
  constructor(code) {
    super(code);
    this.name = "GuestackError";
    this.code = code;
  }
}

/** "#gs_jwt=<jws>" → { jwt }, "#gs_error=<code>" → { error }, anything else → null. */
export function parseFragment(hash) {
  if (typeof hash !== "string") return null;
  const jwt = JWT_FRAGMENT.exec(hash);
  if (jwt) return { jwt: jwt[1] };
  const error = ERROR_FRAGMENT.exec(hash);
  if (error) return { error: error[1] };
  return null;
}

export function validateSession(session) {
  return typeof session === "string" && SESSION_RE.test(session);
}

export function validateReturnPath(path) {
  return typeof path === "string" && RETURN_RE.test(path);
}

export function buildLoginUrl(pageUrl, session, returnPath) {
  return `${pageUrl}?session=${encodeURIComponent(session)}&return=${encodeURIComponent(returnPath)}`;
}

/**
 * If the URL fragment carries a Guestack result, removes it from the address bar and calls
 * `handler({ jwt })` or `handler({ error })` asynchronously. Any other fragment is left alone.
 * `win` is injectable for tests.
 */
export function init({ handler } = {}, win = globalThis.window) {
  if (typeof handler !== "function") throw new TypeError("Guestack.init: handler must be a function");
  const result = parseFragment(win.location.hash);
  if (result === null) return;
  win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search);
  queueMicrotask(() => handler(result));
}

/**
 * Top-level navigation to the Guestack page. `session` is a value the site's backend issued
 * and will check in the JWT; `returnPath` (default: the current path) is where the user comes
 * back to. Throws GuestackError before navigating if anything is wrong. `win` is injectable.
 */
export async function login({ session, returnPath } = {}, win = globalThis.window) {
  if (win !== win.top) throw new GuestackError("not_top_level");
  const path = returnPath === undefined ? win.location.pathname : returnPath;
  if (!validateSession(session)) throw new GuestackError("bad_session");
  if (!validateReturnPath(path)) throw new GuestackError("bad_return_path");
  // @@PROOF_BEGIN login
  // @@PROOF_END
  win.location.assign(buildLoginUrl(PAGE_URL, session, path));
}

export const Guestack = Object.freeze({
  init: (options) => init(options),
  login: (options) => login(options),
  version: VERSION,
  GuestackError,
});
