# Adding Guestack to a site

Guestack gives each visitor a stable, pseudonymous ID for your site, backed by a verified phone number, without your site ever learning the number. The ID is different on every site, so it cannot be used to link visitors across sites.

This guide covers the browser SDK and what your backend must check. The SDK has no dependencies and adds one global, `Guestack`.

> **Development builds.** `guestack-phase1.*` files are development builds without the service-integrity check. They are not published and must not be used in production.

## 1. Load the SDK

Either as a classic script:

```html
<script src="/static/guestack.iife.js"></script>
<!-- window.Guestack is now available -->
```

or as an ES module:

```html
<script type="module">
  import Guestack from "/static/guestack.mjs";
</script>
```

Serve the file from your own origin and pin it to the reviewed release (see the release notes for checksums).

## 2. Receive the result on every page load

Call `init` once on every page the user can come back to. If the URL fragment carries a Guestack result, the SDK removes it from the address bar and calls your handler asynchronously, exactly once.

```js
Guestack.init({
  handler: ({ jwt, error }) => {
    if (jwt) {
      // Send it to your own backend over your usual authenticated channel.
      fetch("/api/guestack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jwt }) });
    } else {
      // "user_cancelled", "provider_error" or "token_rejected"
      showLoginError(error);
    }
  },
});
```

The SDK never decodes, verifies or stores the JWT. Any other fragment (for example `#section-2`) is left untouched.

## 3. Start a login

Ask your backend for a fresh, single-use `session` value first, then call `login` from a user action such as a click:

```js
button.addEventListener("click", async () => {
  const { session } = await (await fetch("/api/guestack/session", { method: "POST" })).json();
  try {
    await Guestack.login({ session, returnPath: "/account" });
    // The browser is now navigating away.
  } catch (err) {
    // err instanceof Guestack.GuestackError; err.code says why
  }
});
```

- `session` must match `^[A-Za-z0-9._~-]{1,256}$`. It comes back inside the JWT, so your backend can tie the result to the request it issued.
- `returnPath` defaults to the current path. It must start with `/`, must not start with `//`, and must not contain whitespace, `#` or `\`. A query string is fine.
- `login` navigates the whole tab. It refuses to run inside an iframe (`not_top_level`), and the Guestack page itself cannot be framed.

Error codes thrown by `login`: `not_top_level`, `bad_session`, `bad_return_path`. Release builds also check that the service is running the published code before navigating, and add `proof_unavailable`, `proof_failed`, `proof_stale`, `proof_bad_signature` and `attestation_invalid`.

### The referrer requirement

The Guestack page learns which site sent the user from the browser's referrer. The default browser policy (`strict-origin-when-cross-origin`) is fine. If your page sends `Referrer-Policy: no-referrer` (as a header or a `<meta>` tag), the Guestack page cannot tell who you are and shows an error instead of signing the user in. If you need `no-referrer` elsewhere, use at least `origin` on the page that calls `login`.

## 4. Verify the JWT on your backend

Your backend, not the browser, decides whether to trust the JWT. It must:

1. Use the ES256 public key published in the attested launch record of the Guestack instance, pinned in your configuration. Never fetch the key from a URL at runtime.
2. Check the signature, `alg` is `ES256`, and `kid` matches the pinned key.
3. Check `iss` equals the Guestack page URL from the same launch record, `aud` equals your site's origin exactly (for example `https://shop.example`), `iat` is not in the future (60 seconds of skew), and `exp` has not passed. JWTs live for 5 minutes.
4. Check `session` equals a value your backend issued, has not been used, and is less than 10 minutes old. Then mark it used.
5. Use `sub` (43 base64url characters) as the visitor's ID. It is stable for your origin for the life of the Guestack instance.

A zero-dependency reference verifier for Node is published with the release documentation.

Accept JWTs only from your own frontend, never from third parties. `jti` is unique per JWT if you want extra replay protection within its 5-minute lifetime.
