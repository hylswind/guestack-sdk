# guestack-sdk

Browser SDK that relying parties integrate to obtain a per-site pseudonymous guest ID from a Guestack instance, plus the verification docs for RP backends.

See `docs/INTEGRATION.md` for how to add Guestack to a site.

Development:

```
npm ci
npm run build:phase1   # development build (no service-integrity check), dist/guestack-phase1.*
npm test               # needs a guestack-launcher checkout next to this repo (or GUESTACK_STACK_DIR)
```
