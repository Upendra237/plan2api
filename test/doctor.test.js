import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { failFs, restoreFs } from '../fixtures/fs-fault.js';
import { ClaudeError } from '../src/claude.js';
import { checkNode, checkPort, quickChecks, runDoctor } from '../src/doctor.js';
import { createKey, getKeysPath } from '../src/keys.js';

let sandbox;
let previousHome;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan2api-doctor-test-'));
  previousHome = process.env.PLAN2API_HOME;
  process.env.PLAN2API_HOME = join(sandbox, 'home');
});

afterEach(() => {
  restoreFs();
  if (previousHome === undefined) delete process.env.PLAN2API_HOME;
  else process.env.PLAN2API_HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

/** A port that nothing is listening on right now. */
async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function doctor(options = {}, deps = {}) {
  let output = '';
  const calls = [];
  const code = await runDoctor(
    { port: await freePort(), ...options },
    { stdout: { write: (text) => (output += text) } },
    {
      getClaudeVersion: async () => '9.9.9',
      runClaude: async (callOptions) => {
        calls.push(callOptions);
        return { text: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
      },
      ...deps,
    },
  );
  return { code, output, calls };
}

const notFound = () => {
  throw new ClaudeError('not_found', 'Claude Code was not found on your PATH.');
};

describe('runDoctor', () => {
  it('prints a tick for every passing check and exits 0', async () => {
    createKey('one');
    createKey('two');
    const { code, output, calls } = await doctor();
    assert.equal(code, 0, output);
    assert.match(output, /^plan2api doctor\n/);
    assert.match(output, /✓ Node\.js \d+\.\d+\.\d+/);
    assert.match(output, /✓ Claude Code 9\.9\.9/);
    assert.match(output, /✓ Logged in/);
    assert.match(output, /✓ Data directory .*is writable; 2 keys/);
    assert.match(output, /✓ Port \d+ is free/);
    assert.match(output, /All checks passed/);
    assert.ok(!output.includes('✗'));
    assert.equal(calls.length, 1, 'one tiny test call');
    assert.equal(typeof calls[0].prompt, 'string');
  });

  it('says how many keys there are, and how to make one when there are none', async () => {
    const { output } = await doctor();
    assert.match(output, /0 keys - create one with: plan2api create <name>/);
    createKey('solo');
    assert.match((await doctor()).output, /1 key(?!s)/);
  });

  it('fails when Node.js is too old, with a fix', async () => {
    const { code, output } = await doctor({}, { nodeVersion: '18.19.0' });
    assert.equal(code, 1);
    assert.match(output, /✗ Node\.js 18\.19\.0 is too old \(20 or newer is required\)/);
    assert.match(output, /Fix: .*nodejs\.org/);
  });

  it('fails when Claude Code is missing, prints the install command, and skips the login check', async () => {
    const { code, output, calls } = await doctor({}, { getClaudeVersion: notFound });
    assert.equal(code, 1);
    assert.match(output, /✗ Claude Code was not found/);
    assert.match(output, /Fix: Install it with: npm install -g @anthropic-ai\/claude-code/);
    assert.match(output, /- Login not checked \(Claude Code is not available\)/);
    assert.equal(calls.length, 0);
  });

  it('fails when the test call fails (not logged in), with a login hint', async () => {
    const runClaude = async () => {
      throw new ClaudeError(
        'failed',
        'Claude Code reported an error: Invalid API key. Please run /login',
      );
    };
    const { code, output } = await doctor({}, { runClaude });
    assert.equal(code, 1);
    assert.match(output, /✗ Test call to Claude Code failed: .*Please run \/login/);
    assert.match(output, /Fix: Run "claude" in a terminal and log in/);
  });

  it('fails with a different hint when the test call times out', async () => {
    const runClaude = async () => {
      throw new ClaudeError('timeout', 'Claude Code did not answer within 60 seconds.');
    };
    const { output } = await doctor({}, { runClaude });
    assert.match(output, /✗ .*did not answer within 60 seconds/);
    assert.match(output, /Fix: Run "claude" in a terminal and make sure it answers/);
  });

  it('skips the test call with --no-call', async () => {
    const { code, output, calls } = await doctor({ call: false });
    assert.equal(code, 0, output);
    assert.match(output, /- Login not checked \(--no-call\)/);
    assert.equal(calls.length, 0, 'must not call Claude');
  });

  it('fails when the data directory is not writable', async () => {
    writeFileSync(join(sandbox, 'a-file'), 'x');
    process.env.PLAN2API_HOME = join(sandbox, 'a-file', 'inside'); // cannot be created
    const { code, output } = await doctor();
    assert.equal(code, 1);
    assert.match(output, /✗ Data directory .* is not writable/);
    assert.match(output, /Fix: .*PLAN2API_HOME/);
  });

  // A data directory path that goes through a regular file is ENOENT on Windows and ENOTDIR on
  // Linux and macOS. Both are faked here, so every platform runs the Linux case.
  for (const code of ['ENOENT', 'ENOTDIR']) {
    it(`reports a data directory problem as a failed check, not a crash (${code})`, async () => {
      failFs('mkdirSync', /home$/, code);
      failFs('readFileSync', /(server\.pid|keys\.json)$/, code);
      const { code: exitCode, output } = await doctor();
      assert.equal(exitCode, 1);
      assert.match(output, new RegExp(`✗ Data directory .* is not writable \\(${code}\\)`));
      assert.match(output, /Fix: .*PLAN2API_HOME/);
      assert.match(output, /- No background server is running/);
      assert.match(output, /1 check failed/);
    });
  }

  it('reports a pid file it cannot read as a failed check, and still prints the rest', async () => {
    createKey('one');
    failFs('readFileSync', /server\.pid$/, 'EACCES');
    const { code, output } = await doctor();
    assert.equal(code, 1);
    assert.match(output, /✓ Node\.js /);
    assert.match(output, /✓ Data directory .*is writable; 1 key/);
    assert.match(output, /✗ Could not read .*server\.pid: .*EACCES/);
    assert.match(output, /Fix: Fix the permissions on .*server\.pid/);
    assert.match(output, /✓ Port \d+ is free/);
    assert.match(output, /1 check failed/);
  });

  it('does not hide a bug: an error that is not a Plan2ApiError still propagates', async () => {
    await assert.rejects(
      doctor(
        {},
        {
          inspectServer: async () => {
            throw new TypeError('a real bug');
          },
        },
      ),
      TypeError,
    );
  });

  it('fails when the key file is corrupt', async () => {
    createKey('seed');
    writeFileSync(getKeysPath(), '{ nope');
    const { code, output } = await doctor();
    assert.equal(code, 1);
    assert.match(output, /✗ .*not valid JSON/);
    assert.match(output, /Fix: Fix or delete .*keys\.json/);
  });

  it('fails when the port is taken, with a fix', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    try {
      const { code, output } = await doctor({ port });
      assert.equal(code, 1);
      assert.match(output, new RegExp(`\\u2717 Port ${port} is already in use`));
      assert.match(output, /Fix: .*--port/);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('counts every failure and keeps going', async () => {
    const { code, output } = await doctor(
      {},
      { nodeVersion: '16.0.0', getClaudeVersion: notFound },
    );
    assert.equal(code, 1);
    assert.match(output, /2 checks failed/);
    assert.equal(output.match(/Fix:/g).length, 2);
  });
});

describe('background server line', () => {
  const startedAt = '2026-11-02T10:00:00.000Z';
  const uptime = { now: () => Date.parse(startedAt) + 125_000 };
  const running = (port) => ({
    state: 'running',
    record: { pid: 4242, host: '127.0.0.1', port, startedAt },
  });

  it('shows pid, URL and uptime when a background server is running, and does not call it a port clash', async () => {
    const { code, output } = await doctor(
      { port: 8788 },
      { inspectServer: async () => running(8788), ...uptime },
    );
    assert.equal(code, 0, output);
    assert.match(
      output,
      /✓ Background server is running \(pid 4242, http:\/\/127\.0\.0\.1:8788, up 2m 5s\)/,
    );
    assert.match(output, /✓ Port 8788 is in use by the background plan2api server \(pid 4242\)/);
    assert.ok(!output.includes('✗'));
    assert.match(output, /All checks passed\.\n/);
    assert.doesNotMatch(output, /Start the server with/, 'one is already running');
  });

  it('says so when none is running, without failing the doctor', async () => {
    const { code, output } = await doctor();
    assert.equal(code, 0, output);
    assert.match(
      output,
      /- No background server is running \(start one with: plan2api start --background\)/,
    );
  });

  it('mentions an out-of-date pid file without failing the doctor', async () => {
    const stale = { state: 'stale', reason: 'process 4242 is not running' };
    const { code, output } = await doctor({}, { inspectServer: async () => stale });
    assert.equal(code, 0, output);
    assert.match(
      output,
      /- No background server is running \(pid file is out of date: process 4242 is not running\)/,
    );
  });

  it('notes a server that is still starting', async () => {
    const starting = { state: 'starting', record: running(8788).record };
    const { output } = await doctor({}, { inspectServer: async () => starting });
    assert.match(output, /- Background server is still starting \(pid 4242\)/);
  });

  it('still reports a real port conflict when the background server uses another port', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    try {
      const { code, output } = await doctor(
        { port },
        { inspectServer: async () => running(port + 1) },
      );
      assert.equal(code, 1);
      assert.match(output, new RegExp(`✗ Port ${port} is already in use`));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

describe('checkNode / checkPort / quickChecks', () => {
  it('checkNode requires Node 20', () => {
    assert.equal(checkNode('20.0.0').status, 'pass');
    assert.equal(checkNode('24.13.1').status, 'pass');
    assert.equal(checkNode('19.9.9').status, 'fail');
  });

  it('checkPort reports a free port', async () => {
    const result = await checkPort(await freePort());
    assert.equal(result.status, 'pass');
  });

  it('quickChecks returns only the failures', async () => {
    assert.deepEqual(
      await quickChecks({ nodeVersion: '24.0.0', getClaudeVersion: async () => '1.0.0' }),
      [],
    );
    const failures = await quickChecks({ nodeVersion: '18.0.0', getClaudeVersion: notFound });
    assert.equal(failures.length, 2);
    assert.match(failures[0].message, /Node\.js 18\.0\.0/);
    assert.match(failures[1].message, /Claude Code was not found/);
  });
});
