"""Calls a local plan2api server with Anthropic's Python SDK. Author: Upendra237

    pip install anthropic
    export PLAN2API_KEY=p2a_...      # from: plan2api create my-app
    python examples/python.py

Optional: PLAN2API_URL (default http://127.0.0.1:8787)
"""

import os
import sys

import anthropic

# Claude's answers may contain emoji, which Windows consoles cannot print by default.
sys.stdout.reconfigure(encoding="utf-8")

api_key = os.environ.get("PLAN2API_KEY")
if not api_key:
    sys.exit("Set PLAN2API_KEY to a key made with: plan2api create <name>")

client = anthropic.Anthropic(
    base_url=os.environ.get("PLAN2API_URL", "http://127.0.0.1:8787"),
    api_key=api_key,
    # The SDK retries 5xx errors by default; for a 504 that would start another Claude run.
    max_retries=0,
)

try:
    message = client.messages.create(
        model="sonnet",
        max_tokens=256,
        system="You are a concise assistant.",
        messages=[{"role": "user", "content": "Say hello in one short sentence."}],
    )
except anthropic.APIStatusError as error:
    body = error.body if isinstance(error.body, dict) else {}
    detail = (body.get("error") or {}).get("message", error.message)
    sys.exit(f"plan2api returned an error ({error.status_code}): {detail}")
except anthropic.APIConnectionError:
    sys.exit("Could not reach plan2api. Is `plan2api start` running?")

print(message.content[0].text)
print(f"({message.usage.input_tokens} input / {message.usage.output_tokens} output tokens)")
