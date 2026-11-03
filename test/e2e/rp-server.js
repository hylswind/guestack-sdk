// Dev-only throwaway relying party that integrates the SDK. Not shipped.
//
//   /, /app/deep/page   the IIFE build, loaded with a <script> tag
//   /esm                the ES module build
//   /frame              an iframe of "/", to check that login refuses to run inside frames
//   /sdk/<file>         the built SDK files
//
// Each page shows a server-issued session in #session, a login button, and the handler's result
// in #result (data-state = pending | none | jwt | error | thrown, data-deliveries = call count).
// window.tryLogin(opts) resolves to "navigating" or the GuestackError code.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const page = ({ session, loader }) => `<!doctype html>
<meta charset="utf-8"><title>SDK test RP</title>
<script>window.__before = new Set(Object.getOwnPropertyNames(window));</script>
${loader}
<p id="session">${session}</p>
<p id="result" data-state="pending"></p>
<button id="login" type="button">Log in with Guestack</button>
<script type="module">
  // Runs after the SDK in both variants (module scripts are deferred; the IIFE is sync).
  const G = window.__G || window.Guestack;
  window.__newGlobals = Object.getOwnPropertyNames(window).filter((k) => !window.__before.has(k) && !k.startsWith("__"));
  const out = document.getElementById("result");
  let deliveries = 0;
  G.init({ handler: (r) => {
    deliveries += 1;
    out.dataset.deliveries = String(deliveries);
    out.dataset.state = r.jwt ? "jwt" : "error";
    out.textContent = r.jwt || r.error;
  } });
  setTimeout(() => { if (out.dataset.state === "pending") out.dataset.state = "none"; }, 50);
  window.tryLogin = (opts) => G.login(opts).then(() => "navigating", (e) => e.code || String(e));
  document.getElementById("login").addEventListener("click", () => {
    G.login({ session: ${JSON.stringify(session)} }).catch((e) => { out.dataset.state = "thrown"; out.textContent = e.code; });
  });
</script>`;

export async function startRp({ port, distDir, iifeName, mjsName }) {
  const files = {
    [iifeName]: readFileSync(join(distDir, iifeName)),
    [mjsName]: readFileSync(join(distDir, mjsName)),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://rp");
    const send = (status, type, body) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const session = randomBytes(12).toString("base64url");
    if (url.pathname === "/" || url.pathname === "/app/deep/page") {
      return send(200, "text/html; charset=utf-8", page({ session, loader: `<script src="/sdk/${iifeName}"></script>` }));
    }
    if (url.pathname === "/esm") {
      const loader = `<script type="module">import Guestack from "/sdk/${mjsName}"; window.__G = Guestack;</script>`;
      return send(200, "text/html; charset=utf-8", page({ session, loader }));
    }
    if (url.pathname === "/frame") return send(200, "text/html; charset=utf-8", `<!doctype html><iframe src="/" id="f"></iframe>`);
    if (url.pathname.startsWith("/sdk/") && files[basename(url.pathname)]) {
      return send(200, "text/javascript; charset=utf-8", files[basename(url.pathname)]);
    }
    send(404, "text/plain", "not found");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}
