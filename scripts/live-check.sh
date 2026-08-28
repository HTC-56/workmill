#!/usr/bin/env bash
set -euo pipefail

# Real-gateway proof: three curl-only checks against a live model gateway.
#
# Proves the same contract that CI validates against the in-process stub:
#   1. GET /models  returns 200 with "data" in the body.
#   2. POST /chat/completions  returns 200 with "choices" and "content".
#   3. The same response body carries "usage" and "total_tokens".
#
# Not run by CI or verify.sh — neither has a model server.
# A human runs it before a demo deployment.

GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://localhost:8080/v1}"
GATEWAY_MODEL="${GATEWAY_MODEL:-default}"
GATEWAY_API_KEY="${GATEWAY_API_KEY:-}"

pass() { printf '\033[32mPASS: %s\033[0m\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# ---- 1. GET /models ------------------------------------------------------- #

echo "Check 1: GET ${GATEWAY_BASE_URL}/models"

HTTP_CODE=$(curl -s -o /tmp/live-check-models.json -w '%{http_code}' \
  "${GATEWAY_BASE_URL}/models" \
  $([ -n "$GATEWAY_API_KEY" ] && printf -- '-H "Authorization: Bearer %s"' "$GATEWAY_API_KEY") || true)

if [ "$HTTP_CODE" != "200" ]; then
  fail "GET /models returned HTTP ${HTTP_CODE} (expected 200)"
fi

if ! grep -q '"data"' /tmp/live-check-models.json; then
  fail "GET /models body does not contain \"data\""
fi

pass "GET /models returned HTTP 200 with \"data\""

# ---- 2. POST /chat/completions -------------------------------------------- #

echo "Check 2: POST ${GATEWAY_BASE_URL}/chat/completions"

RESPONSE_BODY=$(curl -s -w '\n%{http_code}' -X POST \
  "${GATEWAY_BASE_URL}/chat/completions" \
  -H 'Content-Type: application/json' \
  $([ -n "$GATEWAY_API_KEY" ] && printf -- '-H "Authorization: Bearer %s"' "$GATEWAY_API_KEY") \
  -d "{
    \"model\": \"${GATEWAY_MODEL}\",
    \"messages\": [{ \"role\": \"user\", \"content\": \"Respond with a JSON object containing the key \\\"word\\\" and the value \\\"hello\\\".\" }],
    \"stream\": false
  }" || true)

HTTP_CODE="${RESPONSE_BODY##*$'\n'}"
BODY_ONLY="${RESPONSE_BODY%$'\n'*}"

if [ "$HTTP_CODE" != "200" ]; then
  fail "POST /chat/completions returned HTTP ${HTTP_CODE} (expected 200)"
fi

if ! printf '%s' "$BODY_ONLY" | grep -q '"choices"'; then
  fail "POST /chat/completions body does not contain \"choices\""
fi

if ! printf '%s' "$BODY_ONLY" | grep -q '"content"'; then
  fail "POST /chat/completions body does not contain \"content\""
fi

pass "POST /chat/completions returned HTTP 200 with \"choices\" and \"content\""

# ---- 3. Usage capture ----------------------------------------------------- #

echo "Check 3: usage capture in response body"

if ! printf '%s' "$BODY_ONLY" | grep -q '"usage"'; then
  fail "POST /chat/completions body does not contain \"usage\""
fi

if ! printf '%s' "$BODY_ONLY" | grep -q '"total_tokens"'; then
  fail "POST /chat/completions body does not contain \"total_tokens\""
fi

pass "Response body contains \"usage\" and \"total_tokens\""

# ---- Done ----------------------------------------------------------------- #

rm -f /tmp/live-check-models.json 2>/dev/null || true

pass "all 3 checks passed"
