// E2E (`npm run test:e2e`): a throwaway RP using the phase-1 SDK build against the real API and
// page, with mock identity providers, in Playwright Chromium.
//
// The API, page and mocks come from a local checkout of guestack-launcher at GUESTACK_STACK_DIR
// (default ../guestack-launcher). Its test/lib/stack.js, wrangler.js, serve.js, mock-providers.js
// and rp/verify-jwt.js are used as they are; their exported interfaces are a contract between
// the two repositories. Everything this run writes goes under this repo's test/.out/.
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../build.mjs";
import { startRp } from "./e2e/rp-server.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STACK = resolve(process.env.GUESTACK_STACK_DIR ?? join(ROOT, "..", "guestack-launcher"));
if (!existsSync(join(STACK, "test", "lib", "stack.js"))) {
  process.stderr.write(`GUESTACK_STACK_DIR=${STACK} is not a guestack-launcher checkout (test/lib/stack.js missing).\n`
    + "Check out guestack-launcher next to this repository or set GUESTACK_STACK_DIR.\n");
  process.exit(1);
}
const load = (rel) => import(pathToFileURL(join(STACK, rel)).href);
const { prepareStack, runNodeTests, smokeStatus } = await load("test/lib/stack.js");
const { startPagesDev, waitFor } = await load("test/lib/wrangler.js");
const { freePort } = await load("test/lib/serve.js");

const pagePort = await freePort();
const apiPort = await freePort();
const rpPort = await freePort();
const pageOrigin = `http://localhost:${pagePort}`;
const apiBase = `http://localhost:${apiPort}`;
const out = join(ROOT, "test", ".out", "e2e");

const { mock, dev, apiDir, pageDir } = await prepareStack({ out, pageOrigin, apiBase });

// SDK built exactly as a developer would: phase 1, config pointing at this stack's page.
const configPath = join(out, "config.js");
writeFileSync(configPath, `export const PAGE_URL = ${JSON.stringify(pageOrigin)};
export const PROOF_BASE = "https://proofs.invalid";
export const MONITOR = Object.freeze({ repo: "test/guestack-monitor", workflow: ".github/workflows/monitor.yml", commit: "0" });
`);
const sdk = build({ phase1: true, configPath, outDir: join(out, "dist") });

const api = await startPagesDev({ cwd: apiDir, port: apiPort, bindings: dev.secrets });
const page = await startPagesDev({ cwd: pageDir, dir: ".", port: pagePort });
const rp = await startRp({ port: rpPort, distDir: join(out, "dist"), iifeName: "guestack-phase1.iife.js", mjsName: "guestack-phase1.mjs" });

const e2eJson = join(out, "e2e.json");
writeFileSync(e2eJson, JSON.stringify({
  pageOrigin,
  apiBase,
  rpOrigin: `http://localhost:${rpPort}`,
  mockBase: mock.base,
  config: dev.config,
  sdkVersion: sdk.version,
  verifyJwtModule: pathToFileURL(join(STACK, "test", "rp", "verify-jwt.js")).href,
}));

let code = 1;
try {
  await Promise.all([
    waitFor(api, async () => (await smokeStatus(api.base)) === 400),
    waitFor(page, async () => (await fetch(`${page.base}/`)).ok),
  ]);
  code = await runNodeTests(join(ROOT, "test", "e2e"), { GUESTACK_SDK_E2E_JSON: e2eJson });
} catch (err) {
  process.stderr.write(`${err.message}\n`);
} finally {
  await Promise.all([api.stop(), page.stop()]);
  await rp.close();
  await mock.close();
}
process.exit(code);
