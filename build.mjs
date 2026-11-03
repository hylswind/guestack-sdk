#!/usr/bin/env node
// Builds the single-file SDK by concatenation (no bundler, no dependencies).
//
//   node build.mjs --release            dist/guestack.iife.js, dist/guestack.mjs
//   node build.mjs --phase1             dist/guestack-phase1.iife.js, dist/guestack-phase1.mjs
//   PHASE1=1 node build.mjs             same as --phase1
//   options: --config <path> (default ./config.js), --out <dir> (default ./dist)
//
// A development (phase-1) build strips every @@PROOF_BEGIN…@@PROOF_END region and stamps the
// version with "-phase1"; its files are named so they cannot be mistaken for a release. A release
// build refuses the phase-1 flag, requires every proof region to be filled, proof.js to exist and
// login() to call verifyProof(), and refuses a config with REPLACE-ME values.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));

export class BuildError extends Error {}

const IMPORT_LINE = /^import \{[^}]*\} from "\.\/[a-z0-9-]+\.js";$/;
const EXPORT_DECL = /^export (?=(const|let|function|async function|class) )/;
const BEGIN = /^\s*\/\/ @@PROOF_BEGIN( \S+)?$/;
const END = /^\s*\/\/ @@PROOF_END$/;

/** Removes imports and `export` prefixes; anything outside the allowed grammar fails. */
function flatten(name, source) {
  return source.split("\n").flatMap((line, i) => {
    const where = `${name}:${i + 1}`;
    if (IMPORT_LINE.test(line)) return [];
    if (/^\s*import\b/.test(line)) throw new BuildError(`${where}: only \`import { … } from "./x.js";\` on one line is allowed`);
    if (/\bimport\s*\(/.test(line)) throw new BuildError(`${where}: dynamic import is not allowed`);
    if (EXPORT_DECL.test(line)) return [line.replace(EXPORT_DECL, "")];
    if (/^\s*export\b/.test(line)) throw new BuildError(`${where}: only \`export\` on a top-level declaration is allowed`);
    return [line];
  }).join("\n");
}

/** Returns { stripped, regions: [{ name, body }] }; markers must be balanced. */
function proofRegions(name, source) {
  const out = [];
  const regions = [];
  let current = null;
  source.split("\n").forEach((line, i) => {
    if (BEGIN.test(line)) {
      if (current) throw new BuildError(`${name}:${i + 1}: nested @@PROOF_BEGIN`);
      current = { name: (line.match(BEGIN)[1] || "").trim(), body: [] };
    } else if (END.test(line)) {
      if (!current) throw new BuildError(`${name}:${i + 1}: @@PROOF_END without @@PROOF_BEGIN`);
      regions.push({ name: current.name, body: current.body.join("\n").trim() });
      current = null;
    } else if (current) {
      current.body.push(line);
    } else {
      out.push(line);
    }
  });
  if (current) throw new BuildError(`${name}: unterminated @@PROOF_BEGIN`);
  return { stripped: out.join("\n"), regions };
}

/**
 * Builds into `outDir`. `srcDir` holds guestack.js (and proof.js / sigstore-lite.js for a
 * release); `configPath` is the instance config. Returns the written paths and the version.
 */
export function build({ srcDir = HERE, configPath = join(HERE, "config.js"), outDir = join(HERE, "dist"), phase1 = false, release = false } = {}) {
  if (release && phase1) throw new BuildError("the release build refuses the PHASE1 flag");
  if (!release && !phase1) throw new BuildError("choose --release or --phase1");

  const main = readFileSync(join(srcDir, "guestack.js"), "utf8");
  const config = readFileSync(configPath, "utf8");
  const { stripped, regions } = proofRegions("guestack.js", main);
  if (regions.length === 0) throw new BuildError("guestack.js: no @@PROOF regions found");

  const parts = [["config.js", config]];
  let body;
  let suffix = "";
  if (phase1) {
    body = stripped;
    suffix = "-phase1";
  } else {
    const empty = regions.filter((r) => r.body === "").map((r) => r.name || "(unnamed)");
    if (empty.length) throw new BuildError(`release build: proof region(s) empty: ${empty.join(", ")}`);
    const login = regions.find((r) => r.name === "login");
    if (!login || !/\bawait verifyProof\(/.test(login.body)) throw new BuildError("release build: login() must await verifyProof()");
    if (/REPLACE-ME/.test(config)) throw new BuildError("release build: config.js still has REPLACE-ME values");
    for (const extra of ["sigstore-lite.js", "proof.js"]) {
      const path = join(srcDir, extra);
      if (extra === "proof.js" && !existsSync(path)) throw new BuildError("release build: proof.js is missing");
      if (existsSync(path)) parts.push([extra, readFileSync(path, "utf8")]);
    }
    body = main.replace(/^\s*\/\/ @@PROOF_(BEGIN( \S+)?|END)\n/gm, "");
  }
  parts.push(["guestack.js", body]);

  let code = parts.map(([name, src]) => `// ---- ${name}\n${flatten(name, src)}`).join("\n");
  const versionLine = /^const VERSION = "([^"]+)";$/m;
  const match = versionLine.exec(code);
  if (!match) throw new BuildError("guestack.js: `export const VERSION = \"…\";` not found");
  const version = match[1] + suffix;
  code = code.replace(versionLine, `const VERSION = ${JSON.stringify(version)};`);
  const codeOnly = code.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // ignore full-line comments
  if (phase1 && /@@PROOF|verifyProof/.test(codeOnly)) throw new BuildError("phase-1 build still contains proof code");
  if (release && !/function verifyProof\b|const verifyProof\b/.test(code)) throw new BuildError("release build: verifyProof is not defined");

  const banner = `// Guestack SDK ${version}${phase1 ? " (development build without the proof check; not for publication)" : ""}. MIT License.\n`;
  const iife = `${banner}(() => {\n"use strict";\n${code}\nglobalThis.Guestack = Guestack;\n})();\n`;
  const mjs = `${banner}${code}\nexport default Guestack;\nexport { init, login, GuestackError, VERSION as version };\n`;

  // Both outputs must parse; the IIFE must add exactly one global.
  const context = vm.createContext({ queueMicrotask });
  const before = new Set(Object.getOwnPropertyNames(vm.runInContext("globalThis", context)));
  new vm.Script(iife, { filename: "guestack.iife.js" }).runInContext(context);
  const added = Object.getOwnPropertyNames(vm.runInContext("globalThis", context)).filter((k) => !before.has(k));
  if (added.join() !== "Guestack") throw new BuildError(`IIFE must add exactly one global, added: ${added.join(", ")}`);

  mkdirSync(outDir, { recursive: true });
  const base = phase1 ? "guestack-phase1" : "guestack";
  const iifePath = join(outDir, `${base}.iife.js`);
  const mjsPath = join(outDir, `${base}.mjs`);
  writeFileSync(iifePath, iife);
  writeFileSync(mjsPath, mjs);
  const check = spawnSync(process.execPath, ["--check", mjsPath], { encoding: "utf8" });
  if (check.status !== 0) throw new BuildError(`ES module output does not parse:\n${check.stderr}`);
  return { iifePath, mjsPath, version };
}

// CLI
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      release: { type: "boolean", default: false },
      phase1: { type: "boolean", default: false },
      config: { type: "string" },
      out: { type: "string" },
    },
  });
  const phase1 = values.phase1 || process.env.PHASE1 === "1";
  try {
    const result = build({
      phase1,
      release: values.release,
      configPath: values.config ? resolve(values.config) : undefined,
      outDir: values.out ? resolve(values.out) : undefined,
    });
    process.stdout.write(`built ${result.version}: ${result.iifePath}, ${result.mjsPath}\n`);
  } catch (err) {
    process.stderr.write(`build failed: ${err.message}\n`);
    process.exit(1);
  }
}
