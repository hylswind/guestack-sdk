#!/usr/bin/env bash
# Lint gates for the SDK's product files: no console output, no CommonJS or Node-only APIs, only
# relative ".js" imports (the build concatenates them), and built files are never committed.
set -euo pipefail
cd "$(dirname "$0")/.."

PRODUCT_FILES=(guestack.js config.js)
for optional in proof.js sigstore-lite.js; do [[ -f "$optional" ]] && PRODUCT_FILES+=("$optional"); done
status=0
fail() { printf 'lint: %s\n' "$*" >&2; status=1; }

for f in "${PRODUCT_FILES[@]}"; do
  if grep -nE 'console\.' "$f" >&2; then fail "$f: console.* is forbidden"; fi
  if grep -nE '\brequire[[:space:]]*\(' "$f" >&2; then fail "$f: require() is forbidden"; fi
  if grep -nE '\bBuffer\b|\bprocess\.|["'"'"']node:' "$f" >&2; then fail "$f: Node-only APIs are forbidden"; fi
  if grep -nE '\bimport[[:space:]]*\(' "$f" >&2; then fail "$f: dynamic import is forbidden"; fi
  while IFS= read -r spec; do
    [[ -z "$spec" ]] && continue
    case "$spec" in
      ./*.js) ;;
      *) fail "$f: import specifier '$spec' must be ./<name>.js" ;;
    esac
  done < <(grep -oE "^import .* from ['\"][^'\"]+['\"]" "$f" | sed -E "s/.*['\"]([^'\"]+)['\"]$/\1/" || true)
done

if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [[ -n "$(git ls-files dist)" ]]; then
  fail "dist/ is tracked by git; built files are never committed"
fi

[[ $status -eq 0 ]] || exit 1
echo "lint: ok (${#PRODUCT_FILES[@]} product files)"
