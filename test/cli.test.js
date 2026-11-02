import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { main } from '../src/cli.js';

const BIN = fileURLToPath(new URL('../bin/plan2api.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let sandbox;
let previousHome;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan2api-cli-test-'));
  previousHome = process.env.PLAN2API_HOME;
  process.env.PLAN2API_HOME = join(sandbox, 'home');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PLAN2API_HOME;
  else process.env.PLAN2API_HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

async function run(argv, deps = {}) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  };
  const code = await main(argv, io, deps);
  return { code, stdout, stderr };
}

/** Wraps `run` for the key commands, which take no dependencies. */
const runKeys = (...argv) => run(argv);

/** A stand-in for startServer that records its options and stops when told to. */
function fakeServer({ stopsImmediately = false } = {}) {
  const calls = [];
  const state = { shutdowns: 0 };
  const startServer = async (options) => {
    calls.push(options);
    let release;
    const closed = stopsImmediately
      ? Promise.resolve()
      : new Promise((resolve) => (release = resolve));
    return {
      url: 'http://127.0.0.1:8787',
      closed,
      shutdown: async () => {
        state.shutdowns += 1;
        release?.();
      },
    };
  };
  return { startServer, calls, state };
}

const healthy = async () => [];

describe('help and version', () => {
  it('--version prints the package version', async () => {
    const { code, stdout } = await runKeys('--version');
    assert.equal(code, 0);
    assert.equal(stdout, `${PKG.version}\n`);
  });

  it('--help and no arguments print usage, including start and doctor options', async () => {
    for (const argv of [['--help'], ['-h'], []]) {
      const { code, stdout } = await runKeys(...argv);
      assert.equal(code, 0);
      assert.match(stdout, /Usage:/);
      for (const text of [
        'create',
        'list',
        'delete',
        'start',
        'stop',
        'status',
        'doctor',
        '--background',
        '-b',
        '--host',
        '--port',
        '--concurrency',
        '--timeout',
        '--rate-limit',
        '--no-call',
      ]) {
        assert.ok(stdout.includes(text), `help should mention ${text}`);
      }
    }
  });
});

describe('create', () => {
  it('prints the key once with a warning', async () => {
    const { code, stdout } = await runKeys('create', 'laptop');
    assert.equal(code, 0);
    assert.match(stdout, /p2a_[A-Za-z0-9_-]{43}/);
    assert.match(stdout, /cannot be shown again/);
  });

  it('rejects a duplicate name with exit code 1', async () => {
    await runKeys('create', 'laptop');
    const { code, stderr } = await runKeys('create', 'laptop');
    assert.equal(code, 1);
    assert.match(stderr, /already exists/);
  });

  it('rejects an invalid name with exit code 1', async () => {
    const { code, stderr } = await runKeys('create', 'bad name');
    assert.equal(code, 1);
    assert.match(stderr, /Invalid key name/);
  });

  it('reports a missing name as a usage error', async () => {
    const { code, stderr } = await runKeys('create');
    assert.equal(code, 2);
    assert.match(stderr, /Usage: plan2api create <name>/);
  });
});

describe('list', () => {
  it('says so when there are no keys', async () => {
    const { code, stdout } = await runKeys('list');
    assert.equal(code, 0);
    assert.match(stdout, /No keys yet/);
  });

  it('shows names and dates, never the key', async () => {
    const created = await runKeys('create', 'laptop');
    const key = created.stdout.match(/p2a_[A-Za-z0-9_-]+/)[0];
    await runKeys('create', 'server');

    const { code, stdout } = await runKeys('list');
    assert.equal(code, 0);
    assert.match(stdout, /NAME\s+CREATED/);
    assert.match(stdout, /laptop\s+\d{4}-\d{2}-\d{2}/);
    assert.match(stdout, /server\s+\d{4}-\d{2}-\d{2}/);
    assert.ok(!stdout.includes(key));
    assert.ok(!stdout.includes('p2a_'));
  });
});

describe('delete', () => {
  it('removes a key', async () => {
    await runKeys('create', 'laptop');
    const deleted = await runKeys('delete', 'laptop');
    assert.equal(deleted.code, 0);
    assert.match(deleted.stdout, /Deleted key "laptop"/);
    assert.match((await runKeys('list')).stdout, /No keys yet/);
  });

  it('fails clearly for an unknown name', async () => {
    const { code, stderr } = await runKeys('delete', 'ghost');
    assert.equal(code, 1);
    assert.match(stderr, /No key named "ghost"/);
  });
});

describe('start', () => {
  it('starts the server with the documented defaults and prints where it listens', async () => {
    const server = fakeServer({ stopsImmediately: true });
    const { code, stdout, stderr } = await run(['start'], {
      quickChecks: healthy,
      startServer: server.startServer,
    });
    assert.equal(code, 0);
    assert.equal(server.calls.length, 1);
    assert.deepEqual(
      {
        ...server.calls[0],
        log: typeof server.calls[0].log,
        logError: typeof server.calls[0].logError,
      },
      {
        host: '127.0.0.1',
        port: 8787,
        concurrency: 1,
        timeoutSeconds: 120,
        rateLimit: 30,
        log: 'function',
        logError: 'function',
      },
    );
    assert.match(stdout, /plan2api is listening on http:\/\/127\.0\.0\.1:8787/);
    assert.match(stdout, /Concurrency 1, timeout 120s, rate limit 30 requests\/minute per key/);
    assert.match(stdout, /Press Ctrl\+C to stop/);
    assert.equal(stderr, '', 'no warning on the loopback address');
  });

  it('passes every flag through, in both "--flag value" and "--flag=value" forms', async () => {
    const server = fakeServer({ stopsImmediately: true });
    const { code } = await run(
      [
        'start',
        '--host',
        '127.0.0.2',
        '--port=9000',
        '--concurrency',
        '3',
        '--timeout=45',
        '--rate-limit',
        '0',
      ],
      { quickChecks: healthy, startServer: server.startServer },
    );
    assert.equal(code, 0);
    const { host, port, concurrency, timeoutSeconds, rateLimit } = server.calls[0];
    assert.deepEqual(
      { host, port, concurrency, timeoutSeconds, rateLimit },
      { host: '127.0.0.2', port: 9000, concurrency: 3, timeoutSeconds: 45, rateLimit: 0 },
    );
  });

  it('says when the rate limit is off', async () => {
    const server = fakeServer({ stopsImmediately: true });
    const { stdout } = await run(['start', '--rate-limit', '0'], {
      quickChecks: healthy,
      startServer: server.startServer,
    });
    assert.match(stdout, /no rate limit/);
  });

  describe('--effort', () => {
    /** Dependencies where Claude Code lists --effort (or not), and every question is recorded. */
    function effortDeps({ supported = true, version = '9.9.9' } = {}) {
      const server = fakeServer({ stopsImmediately: true });
      const asked = { supportsEffort: 0, getClaudeVersion: 0 };
      return {
        server,
        asked,
        deps: {
          quickChecks: healthy,
          startServer: server.startServer,
          supportsEffort: async () => {
            asked.supportsEffort += 1;
            return supported;
          },
          getClaudeVersion: async () => {
            asked.getClaudeVersion += 1;
            if (version === null) throw new Error('no version');
            return version;
          },
        },
      };
    }

    it('passes each allowed level to the server, in both "--effort x" and "--effort=x" forms', async () => {
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
        for (const argv of [['--effort', level], [`--effort=${level}`]]) {
          const { server, deps } = effortDeps();
          const { code, stderr } = await run(['start', ...argv], deps);
          assert.equal(code, 0, `${argv.join(' ')}: ${stderr}`);
          assert.equal(server.calls.length, 1);
          assert.equal(server.calls[0].effort, level);
        }
      }
    });

    it('shows the active level in the start-up banner', async () => {
      const { deps } = effortDeps();
      const { stdout } = await run(['start', '--effort', 'low'], deps);
      assert.match(stdout, /^Effort: low \(every Claude run\)$/m);
    });

    it('does nothing different when the flag is not given', async () => {
      const { server, asked, deps } = effortDeps();
      const { code, stdout } = await run(['start'], deps);
      assert.equal(code, 0);
      assert.equal(Object.hasOwn(server.calls[0], 'effort'), false, 'no effort option at all');
      assert.doesNotMatch(stdout, /Effort/);
      assert.deepEqual(asked, { supportsEffort: 0, getClaudeVersion: 0 }, 'Claude is not asked');
    });

    it('checks that Claude Code lists --effort, once, before starting', async () => {
      const { server, asked, deps } = effortDeps();
      await run(['start', '--effort', 'high'], deps);
      assert.equal(asked.supportsEffort, 1);
      assert.equal(server.calls.length, 1);
    });

    it('rejects a value that is not on the list with exit code 2, before checking anything', async () => {
      for (const value of ['extreme', 'LOW', 'Low', ' low', 'low;id', '', '1', '--port']) {
        const { server, asked, deps } = effortDeps();
        let checked = false;
        const { code, stderr } = await run(['start', `--effort=${value}`], {
          ...deps,
          quickChecks: async () => {
            checked = true;
            return [];
          },
        });
        assert.equal(code, 2, `--effort=${value}`);
        assert.match(stderr, /--effort must be one of: low, medium, high, xhigh, max/);
        assert.match(stderr, /plan2api --help/);
        assert.equal(checked, false);
        assert.equal(server.calls.length, 0);
        assert.equal(asked.supportsEffort, 0);
      }
    });

    it('rejects a missing value, a repeated flag with a bad value, and the flag on other commands', async () => {
      for (const argv of [
        ['start', '--effort'],
        ['start', '--effort', '--background'],
        ['start', '--effort', 'low', '--effort', 'nope'],
        ['doctor', '--effort', 'low'],
        ['stop', '--effort', 'low'],
        ['status', '--effort=low'],
      ]) {
        const { server, deps } = effortDeps();
        const { code } = await run(argv, deps);
        assert.equal(code, 2, argv.join(' '));
        assert.equal(server.calls.length, 0);
      }
    });

    it('fails at start-up, telling you to update Claude Code, when --effort is not listed', async () => {
      const { server, asked, deps } = effortDeps({ supported: false, version: '2.0.1' });
      const { code, stderr } = await run(['start', '--effort', 'low'], deps);
      assert.equal(code, 1);
      assert.match(stderr, /Cannot use --effort: Claude Code 2\.0\.1 does not list --effort/);
      assert.match(stderr, /Update Claude Code with "claude update"/);
      assert.match(stderr, /npm install -g @anthropic-ai\/claude-code/);
      assert.match(stderr, /without --effort/);
      assert.equal(server.calls.length, 0, 'the server must not start');
      assert.equal(asked.getClaudeVersion, 1);
    });

    it('still gives the message when the version cannot be read', async () => {
      const { deps } = effortDeps({ supported: false, version: null });
      const { code, stderr } = await run(['start', '--effort', 'low'], deps);
      assert.equal(code, 1);
      assert.match(stderr, /Cannot use --effort: this version of Claude Code does not list/);
    });

    it('fails clearly when "claude --help" cannot be read at all', async () => {
      const { ClaudeError } = await import('../src/claude.js');
      const { server, deps } = effortDeps();
      const { code, stderr } = await run(['start', '--effort', 'low'], {
        ...deps,
        supportsEffort: async () => {
          throw new ClaudeError('failed', '"claude --help" failed: boom');
        },
      });
      assert.equal(code, 1);
      assert.match(stderr, /plan2api: "claude --help" failed: boom/);
      assert.equal(server.calls.length, 0);
    });

    it('lets the other quick checks fail first', async () => {
      const { server, asked, deps } = effortDeps();
      const { code, stderr } = await run(['start', '--effort', 'low'], {
        ...deps,
        quickChecks: async () => [{ message: 'Claude Code was not found' }],
      });
      assert.equal(code, 1);
      assert.match(stderr, /Cannot start: Claude Code was not found/);
      assert.equal(asked.supportsEffort, 0);
      assert.equal(server.calls.length, 0);
    });

    it('is listed in --help, with what it does', async () => {
      const { stdout } = await runKeys('--help');
      assert.match(stdout, /--effort <level>\s+Effort level for every Claude run: low, medium/);
      assert.match(stdout, /haiku/);
    });
  });

  it('warns about HTTPS when the host is not a loopback address', async () => {
    const server = fakeServer({ stopsImmediately: true });
    const { code, stderr } = await run(['start', '--host', '0.0.0.0'], {
      quickChecks: healthy,
      startServer: server.startServer,
    });
    assert.equal(code, 0);
    assert.match(stderr, /Warning: listening on 0\.0\.0\.0/);
    assert.match(stderr, /HTTPS/);
    assert.match(stderr, /Caddy/);
    assert.match(stderr, /Cloudflare Tunnel/);
  });

  it('reminds you to create a key when there are none', async () => {
    const options = {
      quickChecks: healthy,
      startServer: fakeServer({ stopsImmediately: true }).startServer,
    };
    assert.match((await run(['start'], options)).stdout, /No API keys yet/);
    await runKeys('create', 'laptop');
    assert.doesNotMatch((await run(['start'], options)).stdout, /No API keys yet/);
  });

  it('refuses to start when a quick check fails, and points to the doctor', async () => {
    const server = fakeServer();
    const failing = async () => [
      { message: 'Claude Code was not found' },
      { message: 'Node.js 18.0.0 is too old' },
    ];
    const { code, stderr } = await run(['start'], {
      quickChecks: failing,
      startServer: server.startServer,
    });
    assert.equal(code, 1);
    assert.match(stderr, /Cannot start: Claude Code was not found; Node\.js 18\.0\.0 is too old/);
    assert.match(stderr, /plan2api doctor/);
    assert.equal(server.calls.length, 0, 'the server must not start');
  });

  it('reports a server start-up problem (such as a busy port) as an error', async () => {
    const { Plan2ApiError } = await import('../src/errors.js');
    const { code, stderr } = await run(['start'], {
      quickChecks: healthy,
      startServer: async () => {
        throw new Plan2ApiError('Port 8787 is already in use on 127.0.0.1.');
      },
    });
    assert.equal(code, 1);
    assert.match(stderr, /plan2api: Port 8787 is already in use/);
  });

  it('shuts down gracefully on Ctrl+C (SIGINT) and exits 0', async () => {
    const server = fakeServer();
    const listenersBefore = process.listenerCount('SIGINT');
    const finished = run(['start'], { quickChecks: healthy, startServer: server.startServer });
    while (server.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.listenerCount('SIGINT'), listenersBefore + 1);

    process.emit('SIGINT', 'SIGINT');
    const { code, stdout } = await finished;
    assert.equal(code, 0);
    assert.equal(server.state.shutdowns, 1);
    assert.match(stdout, /Received SIGINT/);
    assert.equal(process.listenerCount('SIGINT'), listenersBefore, 'signal handlers are removed');
  });

  it('also stops on SIGTERM, and when the server closes by itself', async () => {
    const server = fakeServer();
    const finished = run(['start'], { quickChecks: healthy, startServer: server.startServer });
    while (server.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.emit('SIGTERM', 'SIGTERM');
    assert.equal((await finished).code, 0);
    assert.equal(server.state.shutdowns, 1);
  });

  it('rejects bad flags with a usage error before checking anything', async () => {
    const bad = [
      ['--port', 'abc'],
      ['--port', '0'],
      ['--port', '70000'],
      ['--port', '1.5'],
      ['--port'],
      ['--concurrency', '0'],
      ['--concurrency', '65'],
      ['--timeout', '0'],
      ['--timeout', '99999'],
      ['--timeout', 'soon'],
      ['--rate-limit', 'many'],
      ['--rate-limit', '-5'],
      ['--host', 'a b'],
      ['--host', ''],
      ['--bogus'],
      ['extra'],
    ];
    for (const flags of bad) {
      let checked = false;
      const { code, stderr } = await run(['start', ...flags], {
        quickChecks: async () => {
          checked = true;
          return [];
        },
        startServer: fakeServer().startServer,
      });
      assert.equal(code, 2, `expected a usage error for: ${flags.join(' ')}`);
      assert.match(stderr, /plan2api --help/);
      assert.equal(checked, false);
    }
  });
});

describe('start --background, stop and status', () => {
  /** Dependencies that record what the CLI asked for. */
  function spies({ background = 0, stop = 0, status = 1 } = {}) {
    const seen = { background: [], stop: 0, status: 0 };
    const foreground = fakeServer({ stopsImmediately: true });
    return {
      seen,
      foreground,
      deps: {
        quickChecks: healthy,
        startServer: foreground.startServer,
        startInBackground: async (options) => {
          seen.background.push(options);
          return background;
        },
        stopBackground: async () => {
          seen.stop += 1;
          return stop;
        },
        showStatus: async () => {
          seen.status += 1;
          return status;
        },
      },
    };
  }

  it('-b and --background start the server in the background, not in this terminal', async () => {
    for (const flag of ['-b', '--background']) {
      const { seen, foreground, deps } = spies();
      const { code } = await run(['start', flag], deps);
      assert.equal(code, 0);
      assert.equal(seen.background.length, 1, flag);
      assert.equal(foreground.calls.length, 0, 'the foreground server must not start');
    }
  });

  it('passes the same flags on to the background server', async () => {
    const { seen, deps } = spies();
    await run(
      [
        'start',
        '-b',
        '--host',
        '127.0.0.2',
        '--port=9000',
        '--concurrency',
        '3',
        '--timeout',
        '45',
        '--rate-limit',
        '0',
      ],
      deps,
    );
    assert.deepEqual(seen.background, [
      { host: '127.0.0.2', port: 9000, concurrency: 3, timeoutSeconds: 45, rateLimit: 0 },
    ]);
  });

  it('uses the documented defaults', async () => {
    const { seen, deps } = spies();
    await run(['start', '-b'], deps);
    assert.deepEqual(seen.background, [
      { host: '127.0.0.1', port: 8787, concurrency: 1, timeoutSeconds: 120, rateLimit: 30 },
    ]);
  });

  it('passes --effort on to the background server (and only when it was given)', async () => {
    const { seen, deps } = spies();
    const supportsEffort = async () => true;
    assert.equal(
      (await run(['start', '-b', '--effort', 'low'], { ...deps, supportsEffort })).code,
      0,
    );
    assert.equal(
      (await run(['start', '--effort=max', '--background'], { ...deps, supportsEffort })).code,
      0,
    );
    assert.deepEqual(
      seen.background.map((options) => options.effort),
      ['low', 'max'],
    );

    await run(['start', '-b'], deps);
    assert.equal(Object.hasOwn(seen.background[2], 'effort'), false);
  });

  it('does not start in the background when Claude Code does not list --effort', async () => {
    const { seen, deps } = spies();
    const { code, stderr } = await run(['start', '-b', '--effort', 'low'], {
      ...deps,
      supportsEffort: async () => false,
      getClaudeVersion: async () => '2.0.1',
    });
    assert.equal(code, 1);
    assert.match(stderr, /Cannot use --effort: Claude Code 2\.0\.1 does not list --effort/);
    assert.equal(seen.background.length, 0);
  });

  it('rejects a bad --effort with a usage error, also with --background', async () => {
    const { seen, deps } = spies();
    const { code } = await run(['start', '-b', '--effort', 'extreme'], deps);
    assert.equal(code, 2);
    assert.equal(seen.background.length, 0);
  });

  it('passes the background starter exit code through', async () => {
    assert.equal((await run(['start', '-b'], spies({ background: 1 }).deps)).code, 1);
  });

  it('runs the quick checks first and does not start anything when one fails', async () => {
    const { seen, deps } = spies();
    const { code, stderr } = await run(['start', '-b'], {
      ...deps,
      quickChecks: async () => [{ message: 'Claude Code was not found' }],
    });
    assert.equal(code, 1);
    assert.match(stderr, /Cannot start: Claude Code was not found/);
    assert.match(stderr, /plan2api doctor/);
    assert.equal(seen.background.length, 0);
  });

  it('warns about HTTPS for a non-loopback host, like a foreground start', async () => {
    const { deps } = spies();
    const { stderr } = await run(['start', '-b', '--host', '0.0.0.0'], deps);
    assert.match(stderr, /Warning: listening on 0\.0\.0\.0/);
    assert.match(stderr, /Caddy/);
  });

  it('reports a failed background start as an error', async () => {
    const { Plan2ApiError } = await import('../src/errors.js');
    const { code, stderr } = await run(['start', '-b'], {
      ...spies().deps,
      startInBackground: async () => {
        throw new Plan2ApiError('The background server did not start (it exited with code 1).');
      },
    });
    assert.equal(code, 1);
    assert.match(stderr, /plan2api: The background server did not start/);
  });

  it('stop and status run their handlers and return their exit codes', async () => {
    const { seen, deps } = spies({ stop: 0, status: 1 });
    assert.equal((await run(['stop'], deps)).code, 0);
    assert.equal((await run(['status'], deps)).code, 1);
    assert.deepEqual([seen.stop, seen.status], [1, 1]);

    const running = spies({ status: 0 });
    assert.equal((await run(['status'], running.deps)).code, 0);
  });

  it('stop and status take no arguments', async () => {
    for (const argv of [
      ['stop', 'now'],
      ['status', '--json'],
      ['stop', '-f'],
    ]) {
      const { seen, deps } = spies();
      const { code, stderr } = await run(argv, deps);
      assert.equal(code, 2, argv.join(' '));
      assert.match(stderr, /plan2api --help/);
      assert.equal(seen.stop + seen.status, 0);
    }
  });

  it('start --background still rejects bad flags with a usage error', async () => {
    for (const flags of [['-b', '--bogus'], ['-b', '--port', 'abc'], ['-b', 'extra'], ['-bx']]) {
      const { seen, deps } = spies();
      const { code } = await run(['start', ...flags], deps);
      assert.equal(code, 2, flags.join(' '));
      assert.equal(seen.background.length, 0);
    }
  });
});

describe('doctor', () => {
  it('runs the doctor with the test call and the default port', async () => {
    const seen = [];
    const { code } = await run(['doctor'], {
      runDoctor: async (options) => {
        seen.push(options);
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(seen, [{ call: true, port: 8787 }]);
  });

  it('passes --no-call and --port through, and returns the doctor exit code', async () => {
    const seen = [];
    const { code } = await run(['doctor', '--no-call', '--port', '9999'], {
      runDoctor: async (options) => {
        seen.push(options);
        return 1;
      },
    });
    assert.equal(code, 1);
    assert.deepEqual(seen, [{ call: false, port: 9999 }]);
  });

  it('rejects bad flags with a usage error', async () => {
    for (const flags of [['--bogus'], ['extra'], ['--port', 'x'], ['--port', '70000']]) {
      const { code, stderr } = await run(['doctor', ...flags], {
        runDoctor: async () => assert.fail('must not run'),
      });
      assert.equal(code, 2, flags.join(' '));
      assert.match(stderr, /plan2api --help/);
    }
  });
});

describe('usage errors', () => {
  it('rejects unknown commands, options and extra arguments with exit code 2', async () => {
    for (const argv of [['frobnicate'], ['list', '--json'], ['create', 'a', 'b'], ['delete']]) {
      const { code, stderr } = await runKeys(...argv);
      assert.equal(code, 2, `expected exit code 2 for: ${argv.join(' ')}`);
      assert.match(stderr, /plan2api --help/);
    }
  });

  it('does not treat inherited object properties as commands', async () => {
    const { code, stderr } = await runKeys('toString');
    assert.equal(code, 2);
    assert.match(stderr, /Unknown command: toString/);
  });
});

describe('bin entry point', () => {
  it('runs end to end as a real process', () => {
    const env = { ...process.env, PLAN2API_HOME: join(sandbox, 'e2e') };
    const exec = (...args) =>
      spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });

    assert.equal(exec('--version').stdout.trim(), PKG.version);
    assert.match(exec('--help').stdout, /doctor/);

    const created = exec('create', 'e2e');
    assert.equal(created.status, 0);
    assert.match(created.stdout, /p2a_/);

    assert.match(exec('list').stdout, /e2e/);
    assert.equal(exec('create', 'e2e').status, 1);
    assert.equal(exec('delete', 'e2e').status, 0);
    assert.equal(exec('nope').status, 2);
  });

  it('validates start and doctor flags before doing anything', () => {
    const env = { ...process.env, PLAN2API_HOME: join(sandbox, 'e2e') };
    const exec = (...args) =>
      spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });
    assert.equal(exec('start', '--port', 'nope').status, 2);
    assert.equal(exec('doctor', '--bogus').status, 2);

    const bad = exec('start', '--effort', 'extreme');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--effort must be one of: low, medium, high, xhigh, max/);
    assert.equal(exec('start', '-b', '--effort', 'Low').status, 2);
  });
});
