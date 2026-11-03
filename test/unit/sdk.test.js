import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoginUrl, GuestackError, Guestack, init, login, parseFragment, validateReturnPath, validateSession, VERSION,
} from "../../guestack.js";
import { PAGE_URL } from "../../config.js";

const JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-_";

/** A minimal window: location, history and top, recording what the SDK does. */
function fakeWindow({ hash = "", pathname = "/", search = "", framed = false } = {}) {
  const win = {
    replaced: [],
    assigned: [],
    location: { hash, pathname, search, assign: (url) => win.assigned.push(url) },
    history: { state: { keep: 1 }, replaceState: (state, title, url) => win.replaced.push({ state, title, url }) },
  };
  win.top = framed ? {} : win;
  return win;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const rejectsWith = (code) => (err) => err instanceof GuestackError && err.code === code;

test("parseFragment accepts exactly #gs_jwt=<jws> or #gs_error=<code>", () => {
  assert.deepEqual(parseFragment(`#gs_jwt=${JWT}`), { jwt: JWT });
  assert.deepEqual(parseFragment("#gs_error=user_cancelled"), { error: "user_cancelled" });
  for (const hash of ["", "#", "#section", `#gs_jwt=${JWT}&x=1`, `#x=1&gs_jwt=${JWT}`, "#gs_jwt=a.b", "#gs_jwt=a.b.c.d",
    "#gs_jwt=a/b.c.d", "#gs_jwt=a%2Eb.c.d", "#gs_error=User_Cancelled", "#gs_error=", `#gs_error=${"x".repeat(65)}`,
    `gs_jwt=${JWT}`, null, undefined]) {
    assert.equal(parseFragment(hash), null, String(hash));
  }
});

test("session and return path follow the page's rules", () => {
  for (const s of ["a", "abc-DEF_123.~", "x".repeat(256)]) assert.equal(validateSession(s), true, s);
  for (const s of ["", "x".repeat(257), "a b", "a/b", "é", null, 7]) assert.equal(validateSession(s), false, String(s));
  for (const p of ["/", "/done", "/a/b?c=d&e=f", "/a%23b"]) assert.equal(validateReturnPath(p), true, p);
  for (const p of ["", "done", "//evil.example", "/a#b", "/\\evil.example", "/a b", "/a\tb", "https://evil.example", null]) {
    assert.equal(validateReturnPath(p), false, String(p));
  }
});

test("buildLoginUrl encodes session and return path", () => {
  assert.equal(buildLoginUrl("https://abc.page.pages.dev", "s-1", "/done?x=1&y=2"),
    "https://abc.page.pages.dev?session=s-1&return=%2Fdone%3Fx%3D1%26y%3D2");
});

test("init delivers a JWT asynchronously, once, and strips the fragment", async () => {
  const win = fakeWindow({ hash: `#gs_jwt=${JWT}`, pathname: "/app", search: "?q=1" });
  const calls = [];
  init({ handler: (r) => calls.push(r) }, win);
  assert.equal(calls.length, 0, "not called synchronously");
  assert.deepEqual(win.replaced, [{ state: { keep: 1 }, title: "", url: "/app?q=1" }]);
  await flush();
  assert.deepEqual(calls, [{ jwt: JWT }]);
});

test("init delivers errors and ignores unrelated fragments", async () => {
  const err = fakeWindow({ hash: "#gs_error=token_rejected" });
  const calls = [];
  init({ handler: (r) => calls.push(r) }, err);
  await flush();
  assert.deepEqual(calls, [{ error: "token_rejected" }]);

  const other = fakeWindow({ hash: "#section-2" });
  init({ handler: () => calls.push("unexpected") }, other);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(other.replaced, [], "a foreign fragment is left alone");
});

test("init requires a handler function", () => {
  assert.throws(() => init({}, fakeWindow()), TypeError);
  assert.throws(() => init(undefined, fakeWindow()), TypeError);
});

test("login navigates top-level to the page with session and return path", async () => {
  const win = fakeWindow({ pathname: "/shop/cart" });
  assert.equal(await login({ session: "s-1", returnPath: "/done?x=1" }, win), undefined);
  assert.deepEqual(win.assigned, [`${PAGE_URL}?session=s-1&return=%2Fdone%3Fx%3D1`]);
  const dflt = fakeWindow({ pathname: "/shop/cart" });
  await login({ session: "s-2" }, dflt);
  assert.deepEqual(dflt.assigned, [`${PAGE_URL}?session=s-2&return=%2Fshop%2Fcart`], "default: current path");
});

test("login rejects before navigating: frame first, then session, then return path", async () => {
  const framed = fakeWindow({ framed: true });
  await assert.rejects(login({ session: "bad session", returnPath: "//x" }, framed), rejectsWith("not_top_level"));
  for (const [opts, code] of [
    [{ session: "a b" }, "bad_session"],
    [{}, "bad_session"],
    [{ session: "ok", returnPath: "//evil.example" }, "bad_return_path"],
    [{ session: "ok", returnPath: "/a#b" }, "bad_return_path"],
    [{ session: "ok", returnPath: "/\\evil.example" }, "bad_return_path"],
    [{ session: "ok", returnPath: "relative" }, "bad_return_path"],
  ]) {
    const win = fakeWindow();
    await assert.rejects(login(opts, win), rejectsWith(code), JSON.stringify(opts));
    assert.deepEqual(win.assigned, [], JSON.stringify(opts));
  }
  const odd = fakeWindow({ pathname: "/a b" });
  await assert.rejects(login({ session: "ok" }, odd), rejectsWith("bad_return_path"), "default path is validated too");
});

test("public object: frozen, version, error class", () => {
  assert.ok(Object.isFrozen(Guestack));
  assert.deepEqual(Object.keys(Guestack), ["init", "login", "version", "GuestackError"]);
  assert.equal(Guestack.version, VERSION);
  const e = new Guestack.GuestackError("bad_session");
  assert.ok(e instanceof Error);
  assert.equal(e.name, "GuestackError");
  assert.equal(e.code, "bad_session");
});
