#!/usr/bin/env bash
set -euo pipefail

# verify.sh — run every gate before committing.
# Stops at the first failure.

FAIL=0

fail() {
  printf 'README.md: %s — %s\n' "$1" "$2"
  FAIL=1
}

# ── Gate 1: typecheck ────────────────────────────────────────────────
echo "Gate 1/4: typecheck"
pnpm typecheck

# ── Gate 2: test ─────────────────────────────────────────────────────
echo "Gate 2/4: test"
pnpm test

# ── Gate 3: scrub-check ──────────────────────────────────────────────
echo "Gate 3/4: scrub-check"
bash scripts/scrub-check.sh

# ── Gate 4: README-quickstart lint ────────────────────────────────────
echo "Gate 4/4: README command lint"

README=README.md

# Extract pnpm and bash commands from README.md.
# grep -oE returns one match per line: "pnpm <name>" or "bash <path>"
# Process substitution avoids a subshell so FAIL propagates.
while IFS= read -r line; do
  cmd="${line%% *}"
  arg="${line#* }"
  case "$cmd" in
    pnpm)
      # pnpm install is exempt — it's a built-in, not a repo script
      if [ "$arg" = "install" ]; then
        continue
      fi
      # Check that <arg> exists as a key under "scripts" in package.json
      if ! grep -qE "^[[:space:]]+\"${arg}\":" package.json; then
        fail "${cmd} ${arg}" "no such script in package.json"
      fi
      ;;
    bash)
      # Check that the file exists on disk
      if [ ! -f "$arg" ]; then
        fail "${cmd} ${arg}" "file not found"
      fi
      ;;
  esac
done < <(grep -oE '(pnpm|bash) [a-zA-Z0-9_./:-]+' "$README")

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "FAIL: README command lint failed" >&2
  exit 1
fi

echo ""
echo "PASS: all 4 gates passed"
