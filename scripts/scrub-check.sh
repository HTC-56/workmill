#!/usr/bin/env bash
set -euo pipefail

# Public-repo gate: scan tracked files for anything that must not ship.
#
# EXCLUSIONS — these two paths match our own patterns and would fail forever:
#   - scripts/scrub-check.sh  (the key-material pattern matches this script itself)
#   - pnpm-lock.yaml          (integrity hashes look like key material)

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

git ls-files | grep -v -E '^scripts/scrub-check\.sh$|^pnpm-lock\.yaml$' > "$TMPFILE"

TOTAL=$(wc -l < "$TMPFILE")

found=0

emit() {
  # Print "file:line: <rule>" — no sed (file paths contain /)
  printf '%s:%s: %s\n' "$1" "$2" "$3"
}

# 1. Private hostnames: .local or .lan preceded by alphanumeric/hyphen
#    (backtick-quoted doc mentions like `.local` won't match)
while IFS= read -r f; do
  hits=$(grep -nE '[a-zA-Z0-9_-]\.(local|lan)' -- "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while IFS= read -r line; do
      lineno="${line%%:*}"
      emit "$f" "$lineno" "private hostname (.local / .lan)"
    done <<< "$hits"
    found=1
  fi
done < "$TMPFILE"

# 2. IPv4 literals: four dot-separated numbers standing alone, excluding
#    127.0.0.1, 0.0.0.0, and the 192.0.2.x documentation range.
while IFS= read -r f; do
  hits=$(grep -noE '(^|[^0-9])([0-9]{1,3}\.){3}[0-9]{1,3}([^0-9]|$)' -- "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    filtered=$(printf '%s\n' "$hits" | grep -vE '127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.' || true)
    if [ -n "$filtered" ]; then
      while IFS= read -r entry; do
        lineno="${entry%%:*}"
        emit "$f" "$lineno" "non-doc IPv4 literal"
      done <<< "$filtered"
      found=1
    fi
  fi
done < "$TMPFILE"

# 3. Absolute home paths — exclude backtick-quoted placeholders like /home/<name>/
while IFS= read -r f; do
  hits=$(grep -nE '(^|[^`])/(home|Users)/[a-zA-Z0-9_-]+/' -- "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while IFS= read -r line; do
      lineno="${line%%:*}"
      emit "$f" "$lineno" "absolute home path"
    done <<< "$hits"
    found=1
  fi
done < "$TMPFILE"

# 4. Key material
while IFS= read -r f; do
  hits=$(grep -n -E -e '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{16,}' -- "$f" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    while IFS= read -r line; do
      lineno="${line%%:*}"
      emit "$f" "$lineno" "key material (private key / token)"
    done <<< "$hits"
    found=1
  fi
done < "$TMPFILE"

if [ "$found" -ne 0 ]; then
  echo ""
  echo "FAIL: private data found in tracked files" >&2
  exit 1
fi

printf '\033[32mPASS: scanned %d files — clean\033[0m\n' "$TOTAL"
