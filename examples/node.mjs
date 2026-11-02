// Calls a local plan2api server with Node's built-in fetch (Node 20+, no dependencies).
// Author: Upendra237
//
//   export PLAN2API_KEY=p2a_...      # from: plan2api create my-app
//   node examples/node.mjs
//
// Optional: PLAN2API_URL (default http://127.0.0.1:8787)
const url = process.env.PLAN2API_URL ?? 'http://127.0.0.1:8787';
const key = process.env.PLAN2API_KEY;

if (!key) {
  console.error('Set PLAN2API_KEY to a key made with: plan2api create <name>');
  process.exit(1);
}

let response;
try {
  response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      model: 'sonnet',
      max_tokens: 256,
      system: 'You are a concise assistant.',
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
    }),
  });
} catch {
  console.error('Could not reach plan2api. Is `plan2api start` running?');
  process.exit(1);
}

const data = await response.json();
if (!response.ok) {
  console.error(`plan2api returned an error (${response.status}): ${data.error?.message}`);
  process.exit(1);
}

console.log(data.content[0].text);
console.log(`(${data.usage.input_tokens} input / ${data.usage.output_tokens} output tokens)`);
