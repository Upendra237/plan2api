#!/usr/bin/env sh
# Calls a local plan2api server with curl. Author: Upendra237
#
#   plan2api create my-app          # once: copy the p2a_... key it prints
#   plan2api start                  # in another terminal
#   export PLAN2API_KEY=p2a_...
#   sh examples/curl.sh
#
# Optional: PLAN2API_URL (default http://127.0.0.1:8787)
set -eu

: "${PLAN2API_KEY:?Set PLAN2API_KEY to a key made with: plan2api create <name>}"
URL="${PLAN2API_URL:-http://127.0.0.1:8787}"

curl --silent --show-error "$URL/v1/messages" \
  -H "x-api-key: $PLAN2API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "sonnet",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello in one short sentence."}]
  }'
echo
