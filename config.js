// Instance configuration, filled in by hand after a launch from the attested launch record and
// the monitor commit that carries its expectations. The release build refuses to run while any
// REPLACE-ME value is left.

// The page's deployment-specific URL (launch record: page_project.preview_url).
export const PAGE_URL = "https://REPLACE-ME.pages.dev";

// Public base URL of the proof bucket (root of proofs/ and monitor/). Not a trust input.
export const PROOF_BASE = "https://REPLACE-ME.example";

// The attested monitor workflow whose proofs the SDK accepts.
export const MONITOR = Object.freeze({
  repo: "REPLACE-ME/guestack-monitor",
  workflow: ".github/workflows/monitor.yml",
  commit: "REPLACE-ME",
});
