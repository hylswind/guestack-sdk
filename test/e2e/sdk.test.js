// SDK end to end in Chromium. Run through `npm run test:e2e` (test/run-e2e.js).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const E = JSON.parse(readFileSync(process.env.GUESTACK_SDK_E2E_JSON, "utf8"));
const { verifyGuestackJwt } = await import(E.verifyJwtModule);

let browser;
const shared = {};

before(async () => {
  browser = await chromium.launch({ args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] });
});
after(async () => {
  await browser?.close();
});

const toMock = (path) => (route) => route.fulfill({
  status: 302,
  headers: { location: `${E.mockBase}${path}${new URL(route.request().url()).search}` },
});

async function newPage() {
  const context = await browser.newContext();
  await context.route(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/, toMock("/google/auth"));
  await context.route(/^https:\/\/oauth\.telegram\.org\/auth\?/, toMock("/telegram/auth"));
  const page = await context.newPage();
  return { context, page };
}

async function openRp(page, path = "/") {
  await page.goto(`${E.rpOrigin}${path}`);
  await page.waitForFunction(() => typeof window.tryLogin === "function");
  return page.textContent("#session");
}

async function result(page) {
  // "attached", not the default "visible": an empty result paragraph has no box.
  await page.waitForSelector('#result:not([data-state="pending"])', { state: "attached" });
  return {
    state: await page.getAttribute("#result", "data-state"),
    value: await page.textContent("#result"),
    deliveries: await page.getAttribute("#result", "data-deliveries"),
  };
}

async function consent(page, scenario) {
  await page.waitForSelector('#app[data-view="choose"]');
  await page.click("#google");
  await page.waitForURL(`${E.mockBase}/google/auth?**`);
  await page.click(`a[data-scenario="${scenario}"]`);
}

const verify = (jwt) => verifyGuestackJwt(jwt, { publicJwk: E.config.JWT_PUBLIC_JWK, aud: E.rpOrigin });
const authHits = async () => (await (await fetch(`${E.mockBase}/__stats`)).json()).authHits.google;

test("IIFE build: login → Google → back; handler gets the JWT once; fragment stripped", async () => {
  const { context, page } = await newPage();
  const session = await openRp(page);
  assert.equal(await page.evaluate(() => window.Guestack.version), E.sdkVersion);
  await page.click("#login");
  await consent(page, "google:ok");
  await page.waitForURL(`${E.rpOrigin}/**`);
  const r = await result(page);
  assert.equal(r.state, "jwt");
  assert.equal(r.deliveries, "1");
  const claims = await verify(r.value);
  assert.equal(claims.session, session);
  assert.equal(page.url(), `${E.rpOrigin}/`, "returned to the default path with no fragment left");
  // A second init on the same page finds nothing to deliver.
  const again = await page.evaluate(async () => {
    let called = false;
    window.Guestack.init({ handler: () => { called = true; } });
    await new Promise((r) => setTimeout(r, 20));
    return called;
  });
  assert.equal(again, false);
  Object.assign(shared, { context, page, sub: claims.sub });
});

test("ES module build: the second login skips the provider and keeps the sub", async () => {
  const { page } = shared;
  const hits = await authHits();
  const session = await openRp(page, "/esm");
  await page.click("#login");
  await page.waitForURL(`${E.rpOrigin}/esm`);
  const r = await result(page);
  assert.equal(r.state, "jwt");
  const claims = await verify(r.value);
  assert.equal(claims.session, session);
  assert.equal(claims.sub, shared.sub);
  assert.equal(await authHits(), hits, "no consent page");
});

test("default returnPath brings the user back to the page they started on", async () => {
  const { page } = shared;
  await openRp(page, "/app/deep/page");
  await page.click("#login");
  await page.waitForURL(`${E.rpOrigin}/app/deep/page`);
  assert.equal((await result(page)).state, "jwt");
});

test("denying consent delivers { error: user_cancelled }", async () => {
  const { context, page } = await newPage();
  await openRp(page);
  await page.click("#login");
  await consent(page, "deny");
  await page.waitForURL(`${E.rpOrigin}/**`);
  const r = await result(page);
  assert.deepEqual([r.state, r.value, r.deliveries], ["error", "user_cancelled", "1"]);
  await context.close();
});

test("bad arguments reject in the browser without navigating", async () => {
  const { context, page } = await newPage();
  await openRp(page);
  for (const [opts, code] of [
    [{ session: "a b" }, "bad_session"],
    [{}, "bad_session"],
    [{ session: "ok", returnPath: "//evil.example" }, "bad_return_path"],
    [{ session: "ok", returnPath: "/a#b" }, "bad_return_path"],
    [{ session: "ok", returnPath: "/\\evil.example" }, "bad_return_path"],
  ]) {
    assert.equal(await page.evaluate((o) => window.tryLogin(o), opts), code, JSON.stringify(opts));
  }
  assert.equal(page.url(), `${E.rpOrigin}/`);
  await context.close();
});

test("login inside an iframe rejects with not_top_level and navigates nothing", async () => {
  const { context, page } = await newPage();
  await page.goto(`${E.rpOrigin}/frame`);
  const frame = await (await page.waitForSelector("#f")).contentFrame();
  await frame.waitForFunction(() => typeof window.tryLogin === "function");
  assert.equal(await frame.evaluate(() => window.tryLogin({ session: "ok" })), "not_top_level");
  assert.equal(frame.url(), `${E.rpOrigin}/`);
  assert.equal(page.url(), `${E.rpOrigin}/frame`);
  await context.close();
});

test("an unrelated fragment is left alone and the handler is not called", async () => {
  const { context, page } = await newPage();
  await openRp(page, "/#section-2");
  const r = await result(page);
  assert.equal(r.state, "none");
  assert.equal(r.deliveries, null);
  assert.equal(page.url(), `${E.rpOrigin}/#section-2`);
  await context.close();
});

test("the IIFE build adds exactly one global", async () => {
  const { context, page } = await newPage();
  await openRp(page);
  assert.deepEqual(await page.evaluate(() => window.__newGlobals), ["Guestack"]);
  await openRp(page, "/esm");
  assert.deepEqual(await page.evaluate(() => window.__newGlobals), [], "the module build adds none");
  await context.close();
  await shared.context?.close();
});
