import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { build, BuildError } from "../../build.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OUT = join(ROOT, "test", ".out", "build");

let n = 0;
/** A scratch source dir: guestack.js (optionally edited) + config.js (+ extra files). */
function scratch({ edit = (s) => s, config, extra = {} } = {}) {
  const dir = join(OUT, `case-${++n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "guestack.js"), edit(readFileSync(join(ROOT, "guestack.js"), "utf8")));
  writeFileSync(join(dir, "config.js"), config ?? readFileSync(join(ROOT, "config.js"), "utf8"));
  for (const [name, src] of Object.entries(extra)) writeFileSync(join(dir, name), src);
  return { srcDir: dir, configPath: join(dir, "config.js"), outDir: join(dir, "dist") };
}

const FILLED_CONFIG = `export const PAGE_URL = "https://1a2b3c4d.page.pages.dev";
export const PROOF_BASE = "https://proofs.test";
export const MONITOR = Object.freeze({ repo: "owner/guestack-monitor", workflow: ".github/workflows/monitor.yml", commit: "${"a".repeat(40)}" });
`;
const PROOF_JS = `export async function verifyProof() { return true; }\n`;
const fillRegions = (s) => s
  .replace("// @@PROOF_BEGIN imports\n", "// @@PROOF_BEGIN imports\nimport { verifyProof } from \"./proof.js\";\n")
  .replace("  // @@PROOF_BEGIN login\n", "  // @@PROOF_BEGIN login\n  await verifyProof();\n");
const codeOnly = (code) => code.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const fails = (pattern) => (err) => err instanceof BuildError && pattern.test(err.message);

test("phase-1 build: no proof code, stamped version, phase-1 file names", async () => {
  const opts = scratch();
  const { iifePath, mjsPath, version } = build({ ...opts, phase1: true });
  assert.equal(version, "0.1.0-phase1");
  assert.match(iifePath, /guestack-phase1\.iife\.js$/);
  assert.match(mjsPath, /guestack-phase1\.mjs$/);
  for (const path of [iifePath, mjsPath]) {
    const code = readFileSync(path, "utf8");
    assert.doesNotMatch(codeOnly(code), /@@PROOF|verifyProof/);
    assert.doesNotMatch(code, /^\s*import /m);
  }
  const mod = await import(pathToFileURL(mjsPath).href);
  assert.equal(mod.default.version, "0.1.0-phase1");
  assert.equal(mod.version, "0.1.0-phase1");
  assert.deepEqual(Object.keys(mod).sort(), ["GuestackError", "default", "init", "login", "version"]);
});

test("the IIFE adds exactly one global", () => {
  const opts = scratch();
  const { iifePath } = build({ ...opts, phase1: true });
  const ctx = vm.createContext({ queueMicrotask });
  const before = new Set(Object.getOwnPropertyNames(vm.runInContext("globalThis", ctx)));
  vm.runInContext(readFileSync(iifePath, "utf8"), ctx);
  const added = Object.getOwnPropertyNames(vm.runInContext("globalThis", ctx)).filter((k) => !before.has(k));
  assert.deepEqual(added, ["Guestack"]);
  assert.equal(ctx.Guestack.version, "0.1.0-phase1");
});

test("release build refuses the phase-1 flag and needs an explicit mode", () => {
  const opts = scratch();
  assert.throws(() => build({ ...opts, release: true, phase1: true }), fails(/refuses the PHASE1 flag/));
  assert.throws(() => build({ ...opts }), fails(/choose --release or --phase1/));
});

test("release build fails while the proof regions are empty (the phase-1 state)", () => {
  assert.throws(() => build({ ...scratch(), release: true }), fails(/proof region\(s\) empty: imports, login/));
});

test("release build needs proof.js, a verifyProof call in login, and a filled config", () => {
  assert.throws(() => build({ ...scratch({ edit: fillRegions, config: FILLED_CONFIG }), release: true }),
    fails(/proof\.js is missing/));
  const noCall = (s) => fillRegions(s).replace("  await verifyProof();\n", "  void 0;\n");
  assert.throws(() => build({ ...scratch({ edit: noCall, config: FILLED_CONFIG, extra: { "proof.js": PROOF_JS } }), release: true }),
    fails(/must await verifyProof/));
  assert.throws(() => build({ ...scratch({ edit: fillRegions, extra: { "proof.js": PROOF_JS } }), release: true }),
    fails(/REPLACE-ME/));
});

test("a complete release build succeeds and keeps the proof code", async () => {
  const opts = scratch({ edit: fillRegions, config: FILLED_CONFIG, extra: { "proof.js": PROOF_JS } });
  const { iifePath, mjsPath, version } = build({ ...opts, release: true });
  assert.equal(version, "0.1.0");
  assert.match(iifePath, /[/\\]guestack\.iife\.js$/);
  const code = readFileSync(mjsPath, "utf8");
  assert.match(code, /async function verifyProof\(/);
  assert.match(code, /await verifyProof\(\);/);
  assert.doesNotMatch(codeOnly(code), /@@PROOF/, "markers removed (comments may mention them)");
  assert.equal((await import(pathToFileURL(mjsPath).href)).version, "0.1.0");
});

test("module syntax outside the concatenation grammar fails the build", () => {
  for (const [why, edit, pattern] of [
    ["default import", (s) => s.replace('import { PAGE_URL } from "./config.js";', 'import cfg from "./config.js";'), /only `import \{ … \}/],
    ["bare specifier", (s) => s.replace('"./config.js"', '"config"'), /only `import \{ … \}/],
    ["multi-line import", (s) => s.replace("import { PAGE_URL } from", "import {\n  PAGE_URL,\n} from"), /only `import \{ … \}/],
    ["dynamic import", (s) => s.replace("export const VERSION", "const lazy = () => import(\"./x.js\");\nexport const VERSION"), /dynamic import/],
    ["export default", (s) => `${s}\nexport default Guestack;\n`, /only `export` on a top-level declaration/],
    ["re-export", (s) => `${s}\nexport { init };\n`, /only `export` on a top-level declaration/],
    ["unbalanced markers", (s) => s.replace("  // @@PROOF_END\n  win.location", "  win.location"), /unterminated|nested/],
  ]) {
    assert.throws(() => build({ ...scratch({ edit }), phase1: true }), fails(pattern), why);
  }
});

test("the shipped sources build as phase 1 from the CLI defaults", () => {
  const out = join(OUT, "cli");
  rmSync(out, { recursive: true, force: true });
  cpSync(join(ROOT, "config.js"), join(OUT, "cli-config.js"));
  const { version } = build({ phase1: true, outDir: out, configPath: join(OUT, "cli-config.js") });
  assert.equal(version, "0.1.0-phase1");
});
