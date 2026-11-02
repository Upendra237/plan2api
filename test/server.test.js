import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClaudeError, runClaude as realRunClaude } from '../src/claude.js';
import { Plan2ApiError } from '../src/errors.js';
import { createKey, deleteKey, getKeysPath, hashKey } from '../src/keys.js';
import { isLoopbackHost, MAX_BODY_BYTES, startServer } from '../src/server.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));
const MODEL = 'claude-sonnet-4-6';
const REPLY = { text: 'Hello from fake', usage: { input_tokens: 12, output_tokens: 5 } };

let sandbox;
let previousHome;
let key;
const started = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan2api-server-test-'));
  previousHome = process.env.PLAN2API_HOME;
  process.env.PLAN2API_HOME = join(sandbox, 'home');
  key = createKey('test').key;
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((handle) => handle.shutdown()));
  if (previousHome === undefined) delete process.env.PLAN2API_HOME;
  else process.env.PLAN2API_HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

async function waitFor(predicate, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// fetch() refuses to connect to a few "bad ports" (6000, 6665-6669, 10080, ...). A port picked by
// the OS can be one of them: some machines hand out low, sequential ports (1024-15000 here). So the
// tests choose their own port from a range that has no blocked ports, and retry if it is taken.
const randomTestPort = () => 20_000 + Math.floor(Math.random() * 40_000);

/** Starts a server on a free port with a fake runClaude that records its calls. */
async function launch({ respond = async () => REPLY, ...options } = {}) {
  const calls = [];
  const logs = [];
  const errors = [];
  for (let attempt = 1; ; attempt += 1) {
    try {
      const handle = await startServer({
        host: '127.0.0.1',
        port: randomTestPort(),
        log: (line) => logs.push(line),
        logError: (line) => errors.push(line),
        runClaude: async (callOptions) => {
          calls.push(callOptions);
          return respond(callOptions);
        },
        ...options,
      });
      started.push(handle);
      return { handle, calls, logs, errors, url: handle.url };
    } catch (err) {
      // The port was taken or reserved: pick another one.
      if (!(err instanceof Plan2ApiError) || attempt >= 50) throw err;
    }
  }
}

const validBody = (overrides = {}) => ({
  model: MODEL,
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
  ...overrides,
});

async function send(server, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: response.status, headers: response.headers, text, json };
}

const post = (server, body, headers = { 'x-api-key': key }) =>
  send(server, '/v1/messages', { method: 'POST', headers, body });

function assertAnthropicError(response, status, type) {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(Object.keys(response.json), ['type', 'error']);
  assert.equal(response.json.type, 'error');
  assert.equal(response.json.error.type, type);
  assert.equal(typeof response.json.error.message, 'string');
  assert.ok(response.json.error.message.length > 0);
}

/** A fake runClaude whose calls stay open until the test releases them. */
function gated() {
  const pending = [];
  let active = 0;
  let maxActive = 0;
  const respond = (callOptions) =>
    new Promise((resolve, reject) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const entry = { callOptions };
      entry.release = (text = 'released') => {
        active -= 1;
        resolve({ text, usage: { input_tokens: 1, output_tokens: 1 } });
      };
      entry.fail = (err) => {
        active -= 1;
        reject(err);
      };
      pending.push(entry);
    });
  return { respond, pending, maxActive: () => maxActive };
}

describe('GET /health', () => {
  it('needs no API key', async () => {
    const server = await launch();
    const response = await send(server, '/health');
    assert.equal(response.status, 200);
    // The pid lets `plan2api stop` prove that a process is this server before it ends it.
    assert.deepEqual(response.json, { status: 'ok', pid: process.pid });
    assert.equal(server.calls.length, 0);
  });
});

describe('authentication', () => {
  it('rejects a missing key with 401 and never calls Claude', async () => {
    const server = await launch();
    const response = await post(server, validBody(), {});
    assertAnthropicError(response, 401, 'authentication_error');
    assert.match(response.json.error.message, /x-api-key/);
    assert.equal(server.calls.length, 0);
  });

  it('rejects a wrong key with 401', async () => {
    const server = await launch();
    for (const headers of [
      { 'x-api-key': 'p2a_not-a-real-key' },
      { 'x-api-key': `${key}x` },
      { authorization: 'Bearer p2a_not-a-real-key' },
      { authorization: `Basic ${key}` },
      { authorization: 'Bearer' },
      { 'x-api-key': '   ' },
    ]) {
      assertAnthropicError(await post(server, validBody(), headers), 401, 'authentication_error');
    }
    assert.equal(server.calls.length, 0);
  });

  it('accepts the key in x-api-key or as a Bearer token', async () => {
    const server = await launch();
    assert.equal((await post(server, validBody(), { 'x-api-key': key })).status, 200);
    assert.equal((await post(server, validBody(), { authorization: `Bearer ${key}` })).status, 200);
    assert.equal((await post(server, validBody(), { authorization: `bearer ${key}` })).status, 200);
    assert.equal(server.calls.length, 3);
  });

  it('requires a key for every path except /health', async () => {
    const server = await launch();
    assertAnthropicError(await send(server, '/anything'), 401, 'authentication_error');
    assertAnthropicError(await send(server, '/v1/messages'), 401, 'authentication_error');
  });

  it('picks up created and deleted keys without a restart', async () => {
    const server = await launch();
    const fresh = createKey('later').key;
    assert.equal((await post(server, validBody(), { 'x-api-key': fresh })).status, 200);

    deleteKey('later');
    assertAnthropicError(
      await post(server, validBody(), { 'x-api-key': fresh }),
      401,
      'authentication_error',
    );
    assert.equal((await post(server, validBody())).status, 200, 'other keys keep working');
  });

  it('reports an unreadable key file as a 500 without leaking details', async () => {
    const server = await launch();
    writeFileSync(getKeysPath(), '{ broken');
    const response = await post(server, validBody());
    assertAnthropicError(response, 500, 'api_error');
    assert.match(response.json.error.message, /plan2api doctor/);
    assert.equal(server.calls.length, 0);
    assert.ok(server.errors.some((line) => line.includes('key store error')));
  });
});

describe('POST /v1/messages: request and response mapping', () => {
  it('returns an Anthropic-style message', async () => {
    const server = await launch({ timeoutSeconds: 120 });
    const response = await post(server, validBody({ max_tokens: 999_999 }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const { id, ...rest } = response.json;
    assert.match(id, /^msg_[0-9a-f]{24}$/);
    assert.deepEqual(rest, {
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: 'Hello from fake' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5 },
    });
  });

  it('gives every response a fresh id', async () => {
    const server = await launch();
    const a = await post(server, validBody());
    const b = await post(server, validBody());
    assert.notEqual(a.json.id, b.json.id);
  });

  it('passes a plain string message, the model and the timeout to Claude', async () => {
    const server = await launch({ timeoutSeconds: 7 });
    await post(server, validBody());
    assert.equal(server.calls.length, 1);
    const [call] = server.calls;
    assert.equal(call.prompt, 'Hi');
    assert.equal(call.system, undefined);
    assert.equal(call.model, MODEL);
    assert.equal(call.timeoutMs, 7000);
    assert.ok(call.signal instanceof AbortSignal);
  });

  it('joins text blocks', async () => {
    const server = await launch();
    const content = [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
    ];
    await post(server, validBody({ messages: [{ role: 'user', content }] }));
    assert.equal(server.calls[0].prompt, 'first\n\nsecond');
  });

  it('passes the system field as a string or as text blocks', async () => {
    const server = await launch();
    await post(server, validBody({ system: 'Be brief.' }));
    await post(
      server,
      validBody({
        system: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
        ],
      }),
    );
    assert.equal(server.calls[0].system, 'Be brief.');
    assert.equal(server.calls[1].system, 'A\n\nB');
  });

  it('flattens a multi-turn conversation into one prompt, in order', async () => {
    const server = await launch();
    await post(
      server,
      validBody({
        messages: [
          { role: 'user', content: 'My name is Ada.' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello Ada!' }] },
          { role: 'user', content: 'What is my name?' },
        ],
      }),
    );
    const { prompt } = server.calls[0];
    const order = ['User: My name is Ada.', 'Assistant: Hello Ada!', 'User: What is my name?'];
    const positions = order.map((part) => prompt.indexOf(part));
    assert.ok(
      positions.every((position) => position >= 0),
      prompt,
    );
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
    );
    assert.ok(prompt.endsWith('Assistant:'));
  });

  it('ignores fields it does not use, and an empty tools list', async () => {
    const server = await launch();
    const response = await post(
      server,
      validBody({
        temperature: 0.2,
        top_p: 1,
        stop_sequences: ['x'],
        metadata: { user_id: 'u' },
        tools: [],
      }),
    );
    assert.equal(response.status, 200);
  });

  it('accepts a UTF-8 byte order mark, as written by PowerShell 5.1', async () => {
    const server = await launch();
    const response = await post(server, `﻿${JSON.stringify(validBody())}`);
    assert.equal(response.status, 200, response.text);
    assert.equal(server.calls[0].prompt, 'Hi');
  });

  it('accepts a body just under the 1 MB limit', async () => {
    const server = await launch();
    const content = 'x'.repeat(MAX_BODY_BYTES - 300);
    const response = await post(server, validBody({ messages: [{ role: 'user', content }] }));
    assert.equal(response.status, 200);
    assert.equal(server.calls[0].prompt.length, content.length);
  });
});

describe('POST /v1/messages: the model in the response', () => {
  it('reports the real model that answered, not the alias the client sent', async () => {
    const server = await launch({
      respond: async () => ({ ...REPLY, model: 'claude-sonnet-4-6' }),
    });
    const response = await post(server, validBody({ model: 'sonnet' }));
    assert.equal(response.status, 200);
    assert.equal(response.json.model, 'claude-sonnet-4-6');
    assert.equal(server.calls[0].model, 'sonnet', 'Claude Code is still asked for the alias');
  });

  it('falls back to the requested model when Claude Code does not say which one answered', async () => {
    const server = await launch();
    const response = await post(server, validBody({ model: 'sonnet' }));
    assert.equal(response.json.model, 'sonnet');
  });

  it('falls back when the reported model is not a usable string', async () => {
    for (const model of [undefined, null, '', 5, {}, ['claude-x']]) {
      const server = await launch({ respond: async () => ({ ...REPLY, model }) });
      const response = await post(server, validBody({ model: 'haiku' }));
      assert.equal(response.json.model, 'haiku', JSON.stringify(model));
    }
  });

  describe('through the real runner and a fake claude process', () => {
    const modelFor = async (mode, requested) => {
      process.env.FAKE_CLAUDE_MODE = mode;
      try {
        const server = await launch({
          runClaude: (callOptions) =>
            realRunClaude(callOptions, {
              resolveClaude: () => ({ file: process.execPath, prefixArgs: [FAKE] }),
            }),
        });
        const response = await post(server, validBody({ model: requested }));
        assert.equal(response.status, 200, response.text);
        return response.json.model;
      } finally {
        delete process.env.FAKE_CLAUDE_MODE;
      }
    };

    it('normal case: the model that answered replaces the alias', async () => {
      assert.equal(await modelFor('echo', 'sonnet'), 'claude-fake-1');
    });

    it('several models in modelUsage: a busier helper model is not reported', async () => {
      assert.equal(await modelFor('multi-model', 'opus'), 'claude-fake-1');
    });

    it('fallback: the requested value is used when nothing is reported', async () => {
      assert.equal(await modelFor('no-model-info', 'haiku'), 'haiku');
    });
  });
});

describe('server-wide effort level', () => {
  it('passes the configured effort to every Claude run', async () => {
    const server = await launch({ effort: 'low' });
    assert.equal((await post(server, validBody())).status, 200);
    assert.equal((await post(server, validBody({ model: 'haiku' }))).status, 200);
    assert.deepEqual(
      server.calls.map((call) => call.effort),
      ['low', 'low'],
    );
  });

  it('passes no effort at all when none is configured', async () => {
    const server = await launch();
    assert.equal((await post(server, validBody())).status, 200);
    assert.equal(Object.hasOwn(server.calls[0], 'effort'), false);
  });

  it('cannot be set by a request: the client never chooses the effort', async () => {
    const server = await launch({ effort: 'medium' });
    const response = await post(
      server,
      validBody({ effort: 'max', thinking: { type: 'enabled' } }),
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(server.calls[0].effort, 'medium');
  });

  it('reaches the claude process as --effort=<level> through the real runner', async () => {
    const argsFor = async (effort) => {
      process.env.FAKE_CLAUDE_MODE = 'echo';
      try {
        const server = await launch({
          ...(effort === undefined ? {} : { effort }),
          runClaude: (callOptions) =>
            realRunClaude(callOptions, {
              resolveClaude: () => ({ file: process.execPath, prefixArgs: [FAKE] }),
            }),
        });
        const response = await post(server, validBody());
        assert.equal(response.status, 200, response.text);
        return JSON.parse(response.json.content[0].text).args;
      } finally {
        delete process.env.FAKE_CLAUDE_MODE;
      }
    };

    assert.ok((await argsFor('xhigh')).includes('--effort=xhigh'));
    const without = await argsFor(undefined);
    assert.deepEqual(
      without.filter((arg) => arg.startsWith('--effort')),
      [],
    );
  });
});

describe('POST /v1/messages: rejected requests', () => {
  const rejected = [
    ['stream: true', validBody({ stream: true }), /Streaming is not supported/],
    [
      'tools',
      validBody({ tools: [{ name: 'x', input_schema: { type: 'object' } }] }),
      /Tools are not supported/,
    ],
    ['tool_choice', validBody({ tool_choice: { type: 'auto' } }), /Tools are not supported/],
    [
      'an image block',
      validBody({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }),
      /Only text content blocks/,
    ],
    [
      'a tool_use block',
      validBody({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }] }),
      /Only text content blocks/,
    ],
    [
      'a tool_result block',
      validBody({
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }],
      }),
      /Only text content blocks/,
    ],
    [
      'a non-text system block',
      validBody({ system: [{ type: 'image' }] }),
      /Only text content blocks/,
    ],
    [
      'a text block without text',
      validBody({ messages: [{ role: 'user', content: [{ type: 'text' }] }] }),
      /"text"/,
    ],
    ['a missing model', validBody({ model: undefined }), /"model" is required/],
    ['a model with shell characters', validBody({ model: 'x; rm -rf /' }), /"model"/],
    [
      'a model starting with a dash',
      validBody({ model: '--dangerously-skip-permissions' }),
      /"model"/,
    ],
    ['no messages', validBody({ messages: undefined }), /"messages"/],
    ['empty messages', validBody({ messages: [] }), /"messages"/],
    ['a bad role', validBody({ messages: [{ role: 'system', content: 'x' }] }), /role/],
    ['numeric content', validBody({ messages: [{ role: 'user', content: 5 }] }), /content/],
    ['only whitespace', validBody({ messages: [{ role: 'user', content: '   ' }] }), /some text/],
    ['max_tokens 0', validBody({ max_tokens: 0 }), /max_tokens/],
    ['max_tokens as text', validBody({ max_tokens: 'lots' }), /max_tokens/],
    ['a JSON array body', [validBody()], /JSON object/],
  ];

  for (const [name, body, message] of rejected) {
    it(`returns 400 for ${name}`, async () => {
      const server = await launch();
      const response = await post(server, body);
      assertAnthropicError(response, 400, 'invalid_request_error');
      assert.match(response.json.error.message, message);
      assert.equal(server.calls.length, 0, 'Claude must not be called');
    });
  }

  it('returns 400 for bad JSON and an empty body', async () => {
    const server = await launch();
    for (const body of ['{ not json', '', 'null']) {
      const response = await send(server, '/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key },
        body,
      });
      assertAnthropicError(response, 400, 'invalid_request_error');
    }
    assert.equal(server.calls.length, 0);
  });

  it('returns 404 for an unknown path and 405 for the wrong method', async () => {
    const server = await launch();
    assertAnthropicError(
      await send(server, '/v1/nope', { headers: { 'x-api-key': key } }),
      404,
      'not_found_error',
    );
    const get = await send(server, '/v1/messages', { headers: { 'x-api-key': key } });
    assertAnthropicError(get, 405, 'invalid_request_error');
    assert.equal(get.headers.get('allow'), 'POST');
    const health = await send(server, '/health', { method: 'POST', body: '{}' });
    assertAnthropicError(health, 405, 'invalid_request_error');
  });
});

describe('request size limit', () => {
  function rawPost(server, { headers = {}, parts }) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${server.url}/v1/messages`,
        {
          method: 'POST',
          headers: { 'x-api-key': key, 'content-type': 'application/json', ...headers },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      for (const part of parts.slice(0, -1)) req.write(part);
      req.end(parts.at(-1));
    });
  }

  it('returns 413 for a body over 1 MB with a Content-Length', async () => {
    const server = await launch();
    const response = await rawPost(server, { parts: [Buffer.alloc(MAX_BODY_BYTES + 1, 'a')] });
    assertAnthropicError(
      { ...response, text: JSON.stringify(response.json) },
      413,
      'request_too_large',
    );
    assert.equal(server.calls.length, 0);
  });

  it('returns 413 for a chunked body over 1 MB', async () => {
    const server = await launch();
    const half = Buffer.alloc(MAX_BODY_BYTES / 2 + 1, 'a');
    const response = await rawPost(server, { parts: [half, half] });
    assertAnthropicError(
      { ...response, text: JSON.stringify(response.json) },
      413,
      'request_too_large',
    );
    assert.equal(server.calls.length, 0);
  });

  it('checks the key before reading the body', async () => {
    const server = await launch();
    const response = await rawPost(server, {
      headers: { 'x-api-key': 'p2a_wrong' },
      parts: [Buffer.alloc(MAX_BODY_BYTES + 1, 'a')],
    });
    assert.equal(response.status, 401);
  });
});

describe('queue and concurrency', () => {
  it('runs one Claude call at a time by default and queues the next', async () => {
    const gate = gated();
    const server = await launch({ respond: gate.respond, maxQueue: 4 });
    const first = post(server, validBody({ messages: [{ role: 'user', content: 'one' }] }));
    await waitFor(() => gate.pending.length === 1, 'the first call to start');
    const second = post(server, validBody({ messages: [{ role: 'user', content: 'two' }] }));
    await waitFor(() => server.handle.stats().queued === 1, 'the second request to queue');
    assert.equal(gate.pending.length, 1, 'the second call must wait');

    gate.pending[0].release('answer one');
    assert.equal((await first).json.content[0].text, 'answer one');
    await waitFor(() => gate.pending.length === 2, 'the second call to start');
    gate.pending[1].release('answer two');
    assert.equal((await second).json.content[0].text, 'answer two');
    assert.equal(gate.maxActive(), 1);
  });

  it('returns 429 when the queue is full', async () => {
    const gate = gated();
    const server = await launch({ respond: gate.respond, maxQueue: 1 });
    const running = post(server, validBody());
    await waitFor(() => gate.pending.length === 1, 'the first call to start');
    const queued = post(server, validBody());
    await waitFor(() => server.handle.stats().queued === 1, 'the second request to queue');

    const refused = await post(server, validBody());
    assertAnthropicError(refused, 429, 'rate_limit_error');
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal(gate.pending.length, 1, 'the refused request never reached Claude');

    gate.pending[0].release();
    await running;
    await waitFor(() => gate.pending.length === 2, 'the queued call to start');
    gate.pending[1].release();
    assert.equal((await queued).status, 200);
  });

  it('honours --concurrency', async () => {
    const gate = gated();
    const server = await launch({ respond: gate.respond, concurrency: 2, maxQueue: 4 });
    const all = [post(server, validBody()), post(server, validBody()), post(server, validBody())];
    await waitFor(() => gate.pending.length === 2, 'two calls to run at once');
    await waitFor(() => server.handle.stats().queued === 1, 'the third request to queue');

    gate.pending[0].release();
    await waitFor(() => gate.pending.length === 3, 'the third call to start');
    gate.pending[1].release();
    gate.pending[2].release();
    const statuses = (await Promise.all(all)).map((response) => response.status);
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal(gate.maxActive(), 2);
  });

  it('drops a queued request when its client disconnects', async () => {
    const gate = gated();
    const server = await launch({ respond: gate.respond, maxQueue: 4 });
    const running = post(server, validBody());
    await waitFor(() => gate.pending.length === 1, 'the first call to start');

    const controller = new AbortController();
    const waiting = fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
      signal: controller.signal,
    }).catch(() => 'aborted');
    await waitFor(() => server.handle.stats().queued === 1, 'the second request to queue');
    controller.abort();
    assert.equal(await waiting, 'aborted');
    await waitFor(() => server.handle.stats().queued === 0, 'the queue to empty');

    gate.pending[0].release();
    await running;
    assert.equal(gate.pending.length, 1, 'the abandoned request never reached Claude');
  });

  it('kills the Claude run when the client disconnects', async () => {
    let seenSignal;
    const server = await launch({
      respond: ({ signal }) =>
        new Promise((resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => reject(new ClaudeError('aborted', 'cancelled')));
        }),
    });
    const controller = new AbortController();
    const request = fetch(`${server.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
      signal: controller.signal,
    }).catch(() => 'aborted');
    await waitFor(() => server.handle.stats().running === 1, 'the call to start');
    controller.abort();
    assert.equal(await request, 'aborted');
    await waitFor(() => server.handle.stats().running === 0, 'the abandoned call to stop');
    assert.equal(seenSignal.aborted, true);
  });
});

describe('rate limit', () => {
  it('returns 429 with Retry-After once a key goes over, then recovers', async () => {
    let clock = 1_000_000;
    const server = await launch({ rateLimit: 2, now: () => clock });
    assert.equal((await post(server, validBody())).status, 200);
    assert.equal((await post(server, validBody())).status, 200);

    const limited = await post(server, validBody());
    assertAnthropicError(limited, 429, 'rate_limit_error');
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.match(limited.json.error.message, /2 requests per minute/);
    assert.equal(server.calls.length, 2);

    clock += 61_000;
    assert.equal((await post(server, validBody())).status, 200);
  });

  it('limits each key separately', async () => {
    const server = await launch({ rateLimit: 1, now: () => 5 });
    const other = createKey('other').key;
    assert.equal((await post(server, validBody())).status, 200);
    assert.equal((await post(server, validBody())).status, 429);
    assert.equal((await post(server, validBody(), { 'x-api-key': other })).status, 200);
  });

  it('can be switched off with 0', async () => {
    const server = await launch({ rateLimit: 0 });
    for (let i = 0; i < 5; i += 1) assert.equal((await post(server, validBody())).status, 200);
  });

  it('does not count requests with a wrong key against the real key', async () => {
    const server = await launch({ rateLimit: 1, now: () => 5 });
    assert.equal((await post(server, validBody(), { 'x-api-key': 'p2a_wrong' })).status, 401);
    assert.equal((await post(server, validBody(), { 'x-api-key': 'p2a_wrong' })).status, 401);
    assert.equal((await post(server, validBody())).status, 200);
  });
});

describe('errors from Claude', () => {
  it('returns 504 when Claude times out', async () => {
    const server = await launch({
      respond: async () => {
        throw new ClaudeError('timeout', 'Claude Code did not answer within 120 seconds.');
      },
    });
    const response = await post(server, validBody());
    assertAnthropicError(response, 504, 'timeout_error');
    assert.match(response.json.error.message, /120 seconds/);
  });

  it('times out for real: the runner kills a hung process and the server answers 504', async () => {
    process.env.FAKE_CLAUDE_MODE = 'sleep';
    try {
      const server = await launch({
        timeoutSeconds: 1,
        runClaude: (callOptions) =>
          realRunClaude(callOptions, {
            resolveClaude: () => ({ file: process.execPath, prefixArgs: [FAKE] }),
          }),
      });
      const began = Date.now();
      const response = await post(server, validBody());
      assertAnthropicError(response, 504, 'timeout_error');
      assert.ok(Date.now() - began < 6000);
      assert.equal(server.handle.stats().running, 0);
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
  });

  it('returns 500 for other failures and 404/429 when Claude reports them', async () => {
    const failures = [
      [new ClaudeError('failed', 'Claude Code exited with code 1.'), 500, 'api_error'],
      [new ClaudeError('not_found', 'Claude Code was not found.'), 500, 'api_error'],
      [new ClaudeError('failed', 'no such model', { upstreamStatus: 404 }), 404, 'not_found_error'],
      [new ClaudeError('failed', 'slow down', { upstreamStatus: 429 }), 429, 'rate_limit_error'],
      [new Error('something unexpected with /secret/path'), 500, 'api_error'],
    ];
    for (const [error, status, type] of failures) {
      const server = await launch({
        respond: async () => {
          throw error;
        },
      });
      const response = await post(server, validBody());
      assertAnthropicError(response, status, type);
      if (!(error instanceof ClaudeError)) {
        assert.ok(!response.text.includes('/secret/path'), 'internal details must not leak');
      }
    }
  });

  it('keeps messages that name this machine out of the response, but logs them', async () => {
    const local = [
      new ClaudeError('not_found', 'Found C:\\Users\\me\\npm\\claude.cmd but could not tell more.'),
      new ClaudeError('failed', 'Could not start Claude Code: spawn /home/me/bin/claude EACCES'),
      new ClaudeError('failed', 'Claude Code exited with code 3: crashed at /srv/app/cli.js:10'),
    ];
    for (const error of local) {
      const server = await launch({
        respond: async () => {
          throw error;
        },
      });
      const response = await post(server, validBody());
      assertAnthropicError(response, 500, 'api_error');
      assert.match(response.json.error.message, /could not answer this request.*server log/);
      assert.ok(!/\/home\/me|\/srv\/app|C:\\Users|claude\.cmd|spawn/.test(response.text));
      assert.ok(
        server.errors.some((line) => line.includes(error.message)),
        'the full message is in the server log',
      );
    }
  });

  it("passes on Claude's own error text, which the caller can act on", async () => {
    const server = await launch({
      respond: async () => {
        throw new ClaudeError(
          'failed',
          'Claude Code reported an error: Invalid API key. Please run /login',
          { reported: true },
        );
      },
    });
    const response = await post(server, validBody());
    assertAnthropicError(response, 500, 'api_error');
    assert.match(response.json.error.message, /Please run \/login/);
  });
});

describe('privacy and browser safety', () => {
  it('logs method, path, status, duration and key name, never prompts or keys', async () => {
    const server = await launch();
    await post(
      server,
      validBody({
        system: 'SECRET-SYSTEM-TEXT',
        messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }],
      }),
    );
    await send(server, '/v1/messages?token=QUERY-SECRET', {
      method: 'POST',
      headers: { 'x-api-key': 'p2a_the-wrong-key' },
      body: validBody(),
    });
    await waitFor(() => server.logs.length === 2, 'two log lines');

    const [ok, denied] = server.logs;
    assert.match(ok, /^\S+ POST \/v1\/messages 200 \d+ms key=test$/);
    assert.match(denied, /^\S+ POST \/v1\/messages 401 \d+ms key=-$/);
    const everything = `${server.logs.join('\n')}\n${server.errors.join('\n')}`;
    for (const secret of [
      'TOP-SECRET',
      'SECRET-SYSTEM',
      'QUERY-SECRET',
      key,
      hashKey(key),
      'p2a_the-wrong-key',
    ]) {
      assert.ok(!everything.includes(secret), `log must not contain ${secret}`);
    }
  });

  it('does not log prompts when Claude fails', async () => {
    const server = await launch({
      respond: async () => {
        throw new ClaudeError('failed', 'Claude Code exited with code 1.');
      },
    });
    await post(server, validBody({ messages: [{ role: 'user', content: 'TOP-SECRET-PROMPT' }] }));
    await waitFor(() => server.logs.length === 1, 'a log line');
    assert.ok(server.errors.length > 0);
    assert.ok(!`${server.logs}${server.errors}`.includes('TOP-SECRET'));
  });

  it('sends no CORS headers, even for a browser preflight', async () => {
    const server = await launch();
    const responses = [
      await send(server, '/health', { headers: { origin: 'https://evil.example' } }),
      await send(server, '/v1/messages', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-api-key',
        },
      }),
      await post(server, validBody(), { 'x-api-key': key, origin: 'https://evil.example' }),
    ];
    for (const response of responses) {
      for (const name of response.headers.keys()) {
        assert.ok(!name.startsWith('access-control-'), `unexpected ${name}`);
      }
    }
    assert.notEqual(responses[1].status, 200);
  });
});

describe('shutdown', () => {
  it('aborts running Claude calls, answers 503, and stops listening', async () => {
    let seenSignal;
    const server = await launch({
      respond: ({ signal }) =>
        new Promise((resolve, reject) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => reject(new ClaudeError('aborted', 'cancelled')));
        }),
    });
    const inFlight = post(server, validBody());
    await waitFor(() => server.handle.stats().running === 1, 'the call to start');

    await server.handle.shutdown();
    assertAnthropicError(await inFlight, 503, 'api_error');
    assert.equal(seenSignal.aborted, true);
    await server.handle.closed;
    await assert.rejects(send(server, '/health'));
  });

  it('answers queued requests with 503', async () => {
    const gate = gated();
    const server = await launch({ respond: gate.respond, maxQueue: 2 });
    const running = post(server, validBody());
    await waitFor(() => gate.pending.length === 1, 'the first call to start');
    const queued = post(server, validBody());
    await waitFor(() => server.handle.stats().queued === 1, 'the second request to queue');

    const stopping = server.handle.shutdown();
    gate.pending[0].fail(new ClaudeError('aborted', 'cancelled'));
    assertAnthropicError(await queued, 503, 'api_error');
    assertAnthropicError(await running, 503, 'api_error');
    await stopping;
  });
});

describe('startServer', () => {
  it('explains when the port is already taken', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    try {
      await assert.rejects(startServer({ host: '127.0.0.1', port }), (err) => {
        assert.ok(err instanceof Plan2ApiError);
        assert.match(err.message, new RegExp(`Port ${port} is already in use`));
        assert.match(err.message, /--port/);
        return true;
      });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('listens on the loopback address by default', async () => {
    const handle = await startServer({ port: 0, runClaude: async () => REPLY });
    started.push(handle);
    assert.equal(handle.host, '127.0.0.1');
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('isLoopbackHost', () => {
  it('knows which hosts are only reachable locally', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.1',
      'example.com',
      '127.0.0.1.evil.com',
    ]) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});
