import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  capLog,
  fetchHealth,
  formatDuration,
  formatUrl,
  getLogPath,
  getPidPath,
  inspectServer,
  isProcessAlive,
  readLogTail,
  readPidRecord,
  removePidRecord,
  showStatus,
  startInBackground,
  stopBackground,
  terminateServer,
  writePidRecord,
} from '../src/background.js';
import { main } from '../src/cli.js';
import { Plan2ApiError } from '../src/errors.js';
import { createKey, getConfigDir } from '../src/keys.js';
import { probePort } from '../src/server.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));

let sandbox;
let previousHome;
let previousClaudePath;
const processes = [];
const servers = [];

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan2api-bg-test-'));
  previousHome = process.env.PLAN2API_HOME;
  previousClaudePath = process.env.PLAN2API_CLAUDE_PATH;
  process.env.PLAN2API_HOME = join(sandbox, 'home');
});

afterEach(async () => {
  for (const child of processes.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.(); // only http servers have it; plain net servers do not
    await new Promise((resolve) => server.close(resolve));
  }
  if (previousHome === undefined) delete process.env.PLAN2API_HOME;
  else process.env.PLAN2API_HOME = previousHome;
  if (previousClaudePath === undefined) delete process.env.PLAN2API_CLAUDE_PATH;
  else process.env.PLAN2API_CLAUDE_PATH = previousClaudePath;
  rmSync(sandbox, { recursive: true, force: true });
});

/** A throwaway process that just stays alive, standing in for "some process with this pid". */
function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  processes.push(child);
  return child;
}

async function deadPid() {
  const child = liveProcess();
  child.kill('SIGKILL');
  await once(child, 'exit');
  return child.pid;
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** An HTTP server that answers GET /health like plan2api does, claiming to be `reportedPid`. */
async function healthServer(reportedPid, body = (pid) => ({ status: 'ok', pid })) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body(reportedPid)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return server.address().port;
}

const record = (overrides = {}) => ({
  pid: 4242,
  host: '127.0.0.1',
  port: 8788,
  startedAt: new Date().toISOString(),
  ...overrides,
});
const anHourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

function capture() {
  const out = { text: '' };
  return {
    out,
    io: {
      stdout: { write: (text) => (out.text += text) },
      stderr: { write: (text) => (out.text += text) },
    },
  };
}

const rejectsWith = (promise, pattern) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof Plan2ApiError, `expected a Plan2ApiError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });

describe('pid file', () => {
  it('writes and reads back pid, host, port and start time', () => {
    const written = record({ pid: 777, host: '0.0.0.0', port: 9001 });
    writePidRecord(written);
    assert.deepEqual(readPidRecord(), { exists: true, record: written });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(getPidPath(), 'utf8'))).sort(), [
      'host',
      'pid',
      'port',
      'startedAt',
    ]);
  });

  it('remembers the effort level, and stores nothing about it when there is none', () => {
    const withEffort = record({ effort: 'xhigh' });
    writePidRecord(withEffort);
    assert.deepEqual(readPidRecord(), { exists: true, record: withEffort });
    assert.equal(JSON.parse(readFileSync(getPidPath(), 'utf8')).effort, 'xhigh');

    writePidRecord(record());
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(getPidPath(), 'utf8')), 'effort'), false);
    assert.equal(Object.hasOwn(readPidRecord().record, 'effort'), false);
  });

  it('ignores an effort value that is not on the allowed list, so nothing odd is ever printed', () => {
    writePidRecord(record()); // creates the directory
    for (const effort of ['extreme', 'LOW', '', 5, null, {}, 'low\u001b[31m']) {
      writeFileSync(getPidPath(), JSON.stringify(record({ effort })));
      const { exists, record: read } = readPidRecord();
      assert.equal(exists, true);
      assert.equal(read.pid, 4242, 'the rest of the record is still good');
      assert.equal(Object.hasOwn(read, 'effort'), false, JSON.stringify(effort));
    }
  });

  it('is replaced atomically: overwriting it leaves no temp file behind', () => {
    writePidRecord(record());
    const second = record({ port: 9001 });
    writePidRecord(second);
    assert.deepEqual(readdirSync(getConfigDir()), ['server.pid']);
    assert.deepEqual(readPidRecord().record, second);
  });

  it('lives at server.pid inside the data directory', () => {
    assert.equal(getPidPath(), join(getConfigDir(), 'server.pid'));
    assert.equal(getLogPath(), join(getConfigDir(), 'plan2api.log'));
  });

  it(
    'is readable only by its owner',
    { skip: process.platform === 'win32' && 'POSIX modes do not apply on Windows' },
    () => {
      writePidRecord(record());
      assert.equal(statSync(getPidPath()).mode & 0o777, 0o600);
    },
  );

  it('reports a missing file', () => {
    assert.deepEqual(readPidRecord(), { exists: false, record: null });
  });

  it('treats anything it cannot understand as present but invalid', () => {
    const bad = [
      '{ not json',
      'null',
      '[]',
      '{}',
      JSON.stringify(record({ pid: 'abc' })),
      JSON.stringify(record({ pid: 1.5 })),
      JSON.stringify(record({ pid: 1 })),
      JSON.stringify(record({ pid: 0 })),
      JSON.stringify(record({ port: 0 })),
      JSON.stringify(record({ port: 70000 })),
      JSON.stringify(record({ port: '8788' })),
      JSON.stringify(record({ host: '' })),
      JSON.stringify(record({ startedAt: 'yesterday' })),
    ];
    writePidRecord(record()); // creates the directory
    for (const text of bad) {
      writeFileSync(getPidPath(), text);
      assert.deepEqual(readPidRecord(), { exists: true, record: null }, text);
    }
  });

  it('can be removed, even when it is not there', () => {
    writePidRecord(record());
    removePidRecord();
    assert.equal(existsSync(getPidPath()), false);
    removePidRecord();
  });
});

describe('formatDuration / formatUrl', () => {
  it('formats uptimes', () => {
    assert.equal(formatDuration(-5), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(134_000), '2m 14s');
    assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), '3h 5m');
    assert.equal(formatDuration(2 * 86_400_000 + 4 * 3_600_000), '2d 4h');
  });

  it('formats URLs, bracketing IPv6', () => {
    assert.equal(formatUrl('127.0.0.1', 8788), 'http://127.0.0.1:8788');
    assert.equal(formatUrl('::1', 8788), 'http://[::1]:8788');
  });
});

describe('log file', () => {
  const numbered = (count) =>
    Array.from(
      { length: count },
      (_, i) => `${String(i).padStart(7, '0')} ${'x'.repeat(50)}\n`,
    ).join('');

  it('is left alone when it is small or missing', () => {
    const file = join(sandbox, 'a.log');
    assert.equal(capLog(file), false);
    writeFileSync(file, numbered(10));
    assert.equal(capLog(file), false);
    assert.equal(readFileSync(file, 'utf8'), numbered(10));
  });

  it('keeps only the last part (whole lines) once it is over 5 MB', () => {
    const file = join(sandbox, 'big.log');
    const lines = 110_000; // about 6.3 MB
    writeFileSync(file, numbered(lines));
    assert.ok(statSync(file).size > 5 * 1024 * 1024);

    assert.equal(capLog(file), true);
    const text = readFileSync(file, 'utf8');
    assert.ok(statSync(file).size <= 1024 * 1024 + 100, `kept ${statSync(file).size} bytes`);
    const kept = text.split('\n').filter(Boolean);
    assert.equal(kept[0], '[earlier log lines were trimmed]');
    for (const line of kept.slice(1)) assert.match(line, /^\d{7} x{50}$/, 'no partial lines');
    assert.match(kept.at(-1), new RegExp(`^${String(lines - 1).padStart(7, '0')} `));
  });

  it('honours custom limits', () => {
    const file = join(sandbox, 'small.log');
    writeFileSync(file, numbered(100));
    assert.equal(capLog(file, { maxBytes: 1000, keepBytes: 500 }), true);
    assert.ok(statSync(file).size <= 500 + 40);
  });

  it('reads the last lines written after an offset', () => {
    const file = join(sandbox, 'tail.log');
    writeFileSync(file, 'old 1\nold 2\n');
    const offset = statSync(file).size;
    appendFileSync(
      file,
      `${Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')}\n\u001b[31mred\u001b[0m\n`,
    );
    const tail = readLogTail(file, offset, 5);
    assert.equal(tail.length, 5);
    assert.equal(tail[3], 'new 29');
    assert.ok(!tail.join('').includes('\u001b'), 'control characters are removed');
    assert.deepEqual(readLogTail(join(sandbox, 'missing.log')), []);
  });
});

describe('fetchHealth', () => {
  it('returns ok and the pid from a plan2api-style /health', async () => {
    const port = await healthServer(31337);
    assert.deepEqual(await fetchHealth('127.0.0.1', port), { ok: true, pid: 31337 });
  });

  it('returns ok: false for a closed port, a non-JSON answer, or the wrong shape', async () => {
    assert.equal((await fetchHealth('127.0.0.1', await freePort())).ok, false);

    const plain = http.createServer((req, res) => res.end('hello'));
    await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
    servers.push(plain);
    assert.equal((await fetchHealth('127.0.0.1', plain.address().port)).ok, false);

    const other = await healthServer(1, () => ({ status: 'down' }));
    assert.equal((await fetchHealth('127.0.0.1', other)).ok, false);
  });

  it('gives up on a server that never answers', async () => {
    const silent = http.createServer(() => {});
    await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
    servers.push(silent);
    const began = Date.now();
    assert.equal((await fetchHealth('127.0.0.1', silent.address().port, 200)).ok, false);
    assert.ok(Date.now() - began < 2000);
  });

  it('connects to loopback when the server listens on a wildcard address', async () => {
    const port = await healthServer(5);
    assert.equal((await fetchHealth('0.0.0.0', port)).pid, 5);
  });
});

describe('inspectServer', () => {
  it('stopped: there is no pid file', async () => {
    assert.deepEqual(await inspectServer(), { state: 'stopped' });
  });

  it('stale: the pid file cannot be read', async () => {
    writePidRecord(record());
    writeFileSync(getPidPath(), 'garbage');
    const info = await inspectServer();
    assert.equal(info.state, 'stale');
    assert.match(info.reason, /not a valid pid file/);
  });

  it('stale: the process is gone', async () => {
    const pid = await deadPid();
    writePidRecord(record({ pid, port: await freePort() }));
    const info = await inspectServer();
    assert.equal(info.state, 'stale');
    assert.match(info.reason, new RegExp(`process ${pid} is not running`));
  });

  it('running: the process answers /health on the recorded port and reports its own pid', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await healthServer(child.pid) }));
    const info = await inspectServer();
    assert.equal(info.state, 'running');
    assert.equal(info.record.pid, child.pid);
  });

  it('unverified: the process is alive but nothing answers as plan2api (a reused pid)', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort(), startedAt: anHourAgo() }));
    const info = await inspectServer();
    assert.equal(info.state, 'unverified');
    assert.match(info.reason, /does not answer as a plan2api server/);
  });

  it('unverified: the port answers, but as a different process', async () => {
    const child = liveProcess();
    writePidRecord(
      record({ pid: child.pid, port: await healthServer(child.pid + 1), startedAt: anHourAgo() }),
    );
    assert.equal((await inspectServer()).state, 'unverified');
  });

  it('starting: alive and not answering yet, but started moments ago', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort() }));
    assert.equal((await inspectServer()).state, 'starting');
  });

  it('can be driven with fakes', async () => {
    writePidRecord(record({ pid: 4242 }));
    const info = await inspectServer({
      isAlive: () => true,
      fetchHealth: async () => ({ ok: true, pid: 4242 }),
    });
    assert.equal(info.state, 'running');
  });
});

describe('terminateServer (with fakes)', () => {
  const fakes = (overrides = {}) => {
    const calls = [];
    let alive = true;
    return {
      calls,
      deps: {
        platform: 'linux',
        sleep: async () => {},
        isAlive: () => alive,
        kill: (pid, signal) => {
          calls.push([pid, signal]);
          if (signal === 'SIGTERM') alive = false;
        },
        ...overrides,
      },
    };
  };

  it('on Linux/macOS asks politely with SIGTERM, then sweeps the process group', async () => {
    const { calls, deps } = fakes();
    await terminateServer(555, deps);
    assert.deepEqual(calls, [
      [555, 'SIGTERM'],
      [-555, 'SIGKILL'],
    ]);
  });

  it('on Linux/macOS kills the whole group if SIGTERM is ignored', async () => {
    const calls = [];
    let alive = true;
    const deps = {
      platform: 'linux',
      gracefulMs: 0,
      sleep: async () => {},
      isAlive: () => alive,
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (signal === 'SIGKILL') alive = false;
      },
    };
    await terminateServer(555, deps);
    assert.deepEqual(calls, [
      [555, 'SIGTERM'],
      [-555, 'SIGKILL'],
      [-555, 'SIGKILL'],
    ]);
  });

  it('fails loudly when the process cannot be ended', async () => {
    const deps = {
      platform: 'linux',
      gracefulMs: 0,
      forceMs: 0,
      sleep: async () => {},
      isAlive: () => true,
      kill: () => {},
    };
    await rejectsWith(terminateServer(555, deps), /Could not stop process 555/);
  });

  it('on Windows ends the whole process tree with taskkill', async () => {
    const killed = [];
    let alive = true;
    await terminateServer(555, {
      platform: 'win32',
      sleep: async () => {},
      isAlive: () => alive,
      kill: () => assert.fail('no signals on Windows'),
      taskkill: async (pid) => {
        killed.push(pid);
        alive = false;
      },
    });
    assert.deepEqual(killed, [555]);
  });
});

describe('stopBackground', () => {
  const spies = () => {
    const calls = [];
    return {
      calls,
      deps: {
        kill: (...args) => calls.push(['kill', ...args]),
        taskkill: async (...args) => calls.push(['taskkill', ...args]),
      },
    };
  };

  it('says so when nothing is running', async () => {
    const { io, out } = capture();
    assert.equal(await stopBackground(io), 0);
    assert.match(out.text, /not running/);
  });

  it('cleans up a stale pid file without killing anything', async () => {
    const pid = await deadPid();
    writePidRecord(record({ pid, port: await freePort() }));
    const { io, out } = capture();
    const { calls, deps } = spies();
    assert.equal(await stopBackground(io, deps), 0);
    assert.match(out.text, /Removed a stale pid file \(process \d+ is not running\)/);
    assert.equal(existsSync(getPidPath()), false);
    assert.deepEqual(calls, []);
  });

  it('stops a server that proves it is ours, and removes the pid file', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await healthServer(child.pid) }));
    const { io, out } = capture();

    assert.equal(await stopBackground(io), 0);
    assert.match(out.text, new RegExp(`Stopped the background server \\(pid ${child.pid}\\)`));
    assert.equal(isProcessAlive(child.pid), false, 'the process is really gone');
    assert.equal(existsSync(getPidPath()), false);
  });

  it('does NOT kill a live process that does not answer as our server (reused pid)', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort(), startedAt: anHourAgo() }));
    const { io } = capture();
    const { calls, deps } = spies();

    await rejectsWith(
      stopBackground(io, deps),
      /Not stopping process \d+.*may belong to another program/s,
    );
    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(child.exitCode, null);
    assert.deepEqual(calls, [], 'no kill was even attempted');
    assert.equal(existsSync(getPidPath()), true, 'the pid file is left for the user to inspect');
  });

  it('does NOT kill when something else answers on the recorded port as another pid', async () => {
    const child = liveProcess();
    const impostor = await healthServer(child.pid + 1); // e.g. a different plan2api server
    writePidRecord(record({ pid: child.pid, port: impostor, startedAt: anHourAgo() }));
    const { calls, deps } = spies();
    await rejectsWith(stopBackground(capture().io, deps), /Not stopping process/);
    assert.equal(isProcessAlive(child.pid), true);
    assert.deepEqual(calls, []);
  });

  it('does NOT kill when the recorded port is answered by a non-plan2api server', async () => {
    const child = liveProcess();
    const port = await healthServer(child.pid, () => ({ hello: 'world' }));
    writePidRecord(record({ pid: child.pid, port, startedAt: anHourAgo() }));
    const { calls, deps } = spies();
    await rejectsWith(stopBackground(capture().io, deps), /Not stopping process/);
    assert.deepEqual(calls, []);
  });

  it('refuses to stop a server that is still starting', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort() }));
    const { calls, deps } = spies();
    await rejectsWith(stopBackground(capture().io, deps), /still starting/);
    assert.deepEqual(calls, []);
  });

  it('never stops its own process, even if the pid file says to', async () => {
    writePidRecord(record({ pid: process.pid, port: await healthServer(process.pid) }));
    const { calls, deps } = spies();
    await rejectsWith(stopBackground(capture().io, deps), /Not stopping process/);
    assert.deepEqual(calls, []);
  });
});

describe('showStatus', () => {
  const at = (startedAt, extra = 0) => ({ now: () => Date.parse(startedAt) + extra });

  it('running: prints pid, URL, uptime and log path, exit code 0', async () => {
    const startedAt = '2026-11-02T10:00:00.000Z';
    writePidRecord(record({ pid: 4242, port: 8788, startedAt }));
    const { io, out } = capture();
    const code = await showStatus(io, {
      ...at(startedAt, 125_000),
      isAlive: () => true,
      fetchHealth: async () => ({ ok: true, pid: 4242 }),
    });
    assert.equal(code, 0);
    assert.match(out.text, /plan2api is running in the background/);
    assert.match(out.text, /PID:\s+4242/);
    assert.match(out.text, /URL:\s+http:\/\/127\.0\.0\.1:8788/);
    assert.match(out.text, /Uptime:\s+2m 5s/);
    assert.ok(out.text.includes(getLogPath()));
  });

  it('running: shows the effort level the server was started with', async () => {
    const startedAt = '2026-11-02T10:00:00.000Z';
    writePidRecord(record({ pid: 4242, port: 8788, startedAt, effort: 'low' }));
    const { io, out } = capture();
    const code = await showStatus(io, {
      ...at(startedAt, 5_000),
      isAlive: () => true,
      fetchHealth: async () => ({ ok: true, pid: 4242 }),
    });
    assert.equal(code, 0);
    assert.match(out.text, /^ {2}Effort: {2}low$/m);
  });

  it('running: says the effort is the default when none was set', async () => {
    const startedAt = '2026-11-02T10:00:00.000Z';
    writePidRecord(record({ pid: 4242, port: 8788, startedAt }));
    const { io, out } = capture();
    await showStatus(io, {
      ...at(startedAt, 5_000),
      isAlive: () => true,
      fetchHealth: async () => ({ ok: true, pid: 4242 }),
    });
    assert.match(out.text, /^ {2}Effort: {2}default \(not set\)$/m);
  });

  it('stopped: exit code 1', async () => {
    const { io, out } = capture();
    assert.equal(await showStatus(io), 1);
    assert.equal(out.text, 'plan2api is not running in the background.\n');
  });

  it('stale pid file: exit code 1, and says how to clean it up', async () => {
    writePidRecord(record({ pid: await deadPid(), port: await freePort() }));
    const { io, out } = capture();
    assert.equal(await showStatus(io), 1);
    assert.match(
      out.text,
      /not running in the background \(stale pid file: process \d+ is not running; "plan2api stop" removes it\)/,
    );
    assert.equal(existsSync(getPidPath()), true, 'status only reads');
  });

  it('a reused pid: exit code 1, and the process is left alone', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort(), startedAt: anHourAgo() }));
    const { io, out } = capture();
    assert.equal(await showStatus(io), 1);
    assert.match(out.text, /does not answer as a plan2api server.*left alone/);
  });

  it('starting: exit code 1', async () => {
    const child = liveProcess();
    writePidRecord(record({ pid: child.pid, port: await freePort() }));
    const { io, out } = capture();
    assert.equal(await showStatus(io), 1);
    assert.match(out.text, /still starting/);
  });
});

describe('startInBackground (with a fake child process)', () => {
  const OPTIONS = { host: '127.0.0.1', concurrency: 2, timeoutSeconds: 45, rateLimit: 7 };

  function fakeChild(pid = 4242) {
    const child = new EventEmitter();
    child.pid = pid;
    child.unrefCalled = false;
    child.unref = () => {
      child.unrefCalled = true;
    };
    return child;
  }

  /** Dependencies where `spawn` is a spy and nothing sleeps. */
  function harness({
    child = fakeChild(),
    health = async () => ({ ok: true, pid: child.pid }),
    onSpawn,
  } = {}) {
    const spawned = [];
    const terminated = [];
    let clock = Date.now();
    const deps = {
      spawn: (file, args, options) => {
        spawned.push({ file, args, options });
        onSpawn?.(child);
        return child;
      },
      fetchHealth: health,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      startTimeoutMs: 1000,
      terminate: async (pid) => {
        terminated.push(pid);
      },
    };
    return { child, deps, spawned, terminated };
  }

  it('spawns a detached, hidden child that runs the normal start with the same flags', async () => {
    const port = await freePort();
    const options = { ...OPTIONS, port };
    const { child, deps, spawned } = harness();
    const { io, out } = capture();

    assert.equal(await startInBackground(options, io, deps), 0);

    assert.equal(spawned.length, 1);
    const [{ file, args, options: spawnOptions }] = spawned;
    assert.equal(file, process.execPath);
    assert.match(args[0], /bin[\\/]plan2api\.js$/);
    assert.deepEqual(args.slice(1), [
      'start',
      '--host=127.0.0.1',
      `--port=${port}`,
      '--concurrency=2',
      '--timeout=45',
      '--rate-limit=7',
    ]);
    assert.equal(spawnOptions.detached, true);
    assert.equal(spawnOptions.windowsHide, true);
    assert.notEqual(spawnOptions.shell, true);
    assert.equal(spawnOptions.cwd, getConfigDir());
    assert.equal(spawnOptions.stdio[0], 'ignore');
    assert.ok(Number.isInteger(spawnOptions.stdio[1]), 'stdout goes to the log file');
    assert.equal(spawnOptions.stdio[1], spawnOptions.stdio[2]);

    assert.equal(child.unrefCalled, true, 'the parent does not wait for the child');
    const { record: saved } = readPidRecord();
    assert.equal(saved.pid, 4242);
    assert.equal(saved.host, '127.0.0.1');
    assert.equal(saved.port, port);
    assert.ok(Math.abs(Date.parse(saved.startedAt) - Date.now()) < 5000);
    assert.match(out.text, /plan2api is running in the background/);
    assert.match(out.text, /PID:\s+4242/);
    assert.ok(out.text.includes(`http://127.0.0.1:${port}`));
    assert.ok(out.text.includes(getLogPath()));
  });

  it('hands the child an absolute PLAN2API_HOME, even when the one in use is relative', async () => {
    const previousCwd = process.cwd();
    process.chdir(sandbox);
    try {
      process.env.PLAN2API_HOME = join('rel', 'home');
      const { deps, spawned } = harness();
      await startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps);

      const { env, cwd } = spawned[0].options;
      assert.equal(env.PLAN2API_HOME, resolve('rel', 'home'));
      assert.equal(isAbsolute(env.PLAN2API_HOME), true);
      assert.equal(cwd, env.PLAN2API_HOME, 'the child runs in its data directory');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('without --effort, the child gets no effort flag and the output is exactly what it always was', async () => {
    const port = await freePort();
    const { deps, spawned } = harness();
    const { io, out } = capture();
    assert.equal(await startInBackground({ ...OPTIONS, port }, io, deps), 0);

    assert.equal(
      spawned[0].args.some((arg) => arg.startsWith('--effort')),
      false,
    );
    assert.equal(Object.hasOwn(readPidRecord().record, 'effort'), false);
    assert.equal(
      out.text,
      [
        'plan2api is running in the background.',
        '  PID:  4242',
        `  URL:  http://127.0.0.1:${port}`,
        `  Log:  ${getLogPath()}`,
        'Check on it with: plan2api status    Stop it with: plan2api stop',
        '',
      ].join('\n'),
    );
  });

  it('hands --effort to the child, records it in the pid file and prints it', async () => {
    const port = await freePort();
    const { deps, spawned } = harness();
    const { io, out } = capture();
    assert.equal(await startInBackground({ ...OPTIONS, port, effort: 'low' }, io, deps), 0);

    assert.deepEqual(spawned[0].args.slice(1), [
      'start',
      '--host=127.0.0.1',
      `--port=${port}`,
      '--concurrency=2',
      '--timeout=45',
      '--rate-limit=7',
      '--effort=low',
    ]);
    assert.equal(readPidRecord().record.effort, 'low');
    const lines = out.text.split('\n');
    assert.ok(lines.includes('  Effort:  low'), out.text);
    // The labels line up: every value starts in the same column.
    assert.deepEqual(
      [
        lines.find((l) => l.includes('PID:')).indexOf('4242'),
        lines.find((l) => l.includes('URL:')).indexOf('http://'),
        lines.find((l) => l.includes('Log:')).indexOf(getLogPath()),
        lines.find((l) => l.includes('Effort:')).indexOf('low'),
      ],
      [11, 11, 11, 11],
    );
  });

  it('passes every allowed effort level as one --effort=<level> argument', async () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const { deps, spawned } = harness();
      await startInBackground({ ...OPTIONS, port: await freePort(), effort }, capture().io, deps);
      assert.deepEqual(
        spawned[0].args.filter((arg) => arg.startsWith('--effort')),
        [`--effort=${effort}`],
      );
      removePidRecord();
    }
  });

  it('refuses an effort level that is not on the list, before starting anything', async () => {
    for (const effort of ['extreme', 'LOW', '', 'low --tools=Bash', null, 5]) {
      const { deps, spawned } = harness();
      await rejectsWith(
        startInBackground({ ...OPTIONS, port: await freePort(), effort }, capture().io, deps),
        /Invalid effort level/,
      );
      assert.equal(spawned.length, 0);
      assert.equal(existsSync(getPidPath()), false);
    }
  });

  it('trims an oversized log before starting', async () => {
    const port = await freePort();
    writePidRecord(record()); // creates the data directory
    removePidRecord();
    writeFileSync(getLogPath(), 'y'.repeat(6 * 1024 * 1024));
    const { deps } = harness();
    await startInBackground({ ...OPTIONS, port }, capture().io, deps);
    assert.ok(statSync(getLogPath()).size < 2 * 1024 * 1024);
  });

  it('refuses when a background server is already running', async () => {
    const live = liveProcess();
    writePidRecord(record({ pid: live.pid, port: await healthServer(live.pid) }));
    const before = readFileSync(getPidPath(), 'utf8');
    // The old server answers /health with its own pid, so it is verified as running.
    const { deps, spawned } = harness({ health: async () => ({ ok: true, pid: live.pid }) });

    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /already running \(pid \d+, http:\/\/127\.0\.0\.1:\d+\)[\s\S]*plan2api stop/,
    );
    assert.equal(spawned.length, 0);
    assert.equal(readFileSync(getPidPath(), 'utf8'), before);
  });

  it('refuses while another background start is still in progress', async () => {
    const live = liveProcess();
    writePidRecord(record({ pid: live.pid, port: await freePort() }));
    const { deps, spawned } = harness();
    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /still starting/,
    );
    assert.equal(spawned.length, 0);
  });

  it('refuses when the port is busy', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    servers.push(blocker);
    const { port } = blocker.address();
    const { deps, spawned } = harness();

    await rejectsWith(
      startInBackground({ ...OPTIONS, port }, capture().io, deps),
      new RegExp(`Port ${port} is already in use`),
    );
    assert.equal(spawned.length, 0);
    assert.equal(existsSync(getPidPath()), false, 'nothing is recorded');
  });

  it('replaces a stale pid file', async () => {
    writePidRecord(record({ pid: await deadPid(), port: await freePort() }));
    const { deps, spawned } = harness();
    assert.equal(
      await startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      0,
    );
    assert.equal(spawned.length, 1);
    assert.equal(readPidRecord().record.pid, 4242);
  });

  it('replaces a pid file whose pid now belongs to an unrelated process', async () => {
    const unrelated = liveProcess();
    writePidRecord(record({ pid: unrelated.pid, port: await freePort(), startedAt: anHourAgo() }));
    const { deps, spawned } = harness();
    assert.equal(
      await startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      0,
    );
    assert.equal(spawned.length, 1);
    assert.equal(isProcessAlive(unrelated.pid), true, 'the unrelated process is not touched');
  });

  it('prints the last log lines and exits non-zero when the child dies at start-up', async () => {
    const { deps, terminated } = harness({
      health: async () => ({ ok: false }), // the server never comes up: the child dies first
      onSpawn: (child) =>
        queueMicrotask(() => {
          appendFileSync(
            getLogPath(),
            'plan2api: Cannot start: Claude Code was not found.\nRun "plan2api doctor"\n',
          );
          child.emit('exit', 1, null);
        }),
    });
    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /did not start \(it exited with code 1\)[\s\S]*Last lines of .*plan2api\.log:\n {2}plan2api: Cannot start: Claude Code was not found\.\n {2}Run "plan2api doctor"/,
    );
    assert.equal(existsSync(getPidPath()), false, 'no pid file is left behind');
    assert.deepEqual(terminated, [], 'an already-exited child is not killed again');
  });

  it('only shows log lines from this start, not older ones', async () => {
    writePidRecord(record());
    removePidRecord();
    writeFileSync(getLogPath(), 'OLD LINE from an earlier run\n');
    const { deps } = harness({
      health: async () => ({ ok: false }),
      onSpawn: (child) =>
        queueMicrotask(() => {
          appendFileSync(getLogPath(), 'NEW LINE\n');
          child.emit('exit', 1, null);
        }),
    });
    await assert.rejects(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      (err) => err.message.includes('NEW LINE') && !err.message.includes('OLD LINE'),
    );
  });

  it('kills the child and cleans up when it never answers', async () => {
    const { deps, terminated } = harness({ health: async () => ({ ok: false }) });
    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /did not start \(it did not answer on http:\/\/127\.0\.0\.1:\d+ in time\)/,
    );
    assert.deepEqual(terminated, [4242]);
    assert.equal(existsSync(getPidPath()), false);
  });

  it('does not accept a different process answering on the port as success', async () => {
    const { deps, terminated } = harness({ health: async () => ({ ok: true, pid: 99999 }) });
    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /did not answer/,
    );
    assert.deepEqual(terminated, [4242]);
  });

  it('reports a child that could not be started at all', async () => {
    const child = fakeChild();
    child.pid = undefined;
    const { deps, terminated } = harness({
      child,
      onSpawn: (c) => queueMicrotask(() => c.emit('error', new Error('spawn ENOENT'))),
    });
    await rejectsWith(
      startInBackground({ ...OPTIONS, port: await freePort() }, capture().io, deps),
      /the process could not be started: spawn ENOENT/,
    );
    assert.deepEqual(terminated, []);
    assert.equal(existsSync(getPidPath()), false);
  });
});

describe('background mode end to end (a real detached server; "claude" is just node)', () => {
  it('start --background, status, a second start, stop, status', { timeout: 90_000 }, async () => {
    // `claude --version` is the only thing start-up asks of Claude Code; node answers it too.
    process.env.PLAN2API_CLAUDE_PATH = process.execPath;
    const port = await freePort();
    const run = async (...argv) => {
      const { io, out } = capture();
      const code = await main(argv, io);
      return { code, text: out.text };
    };

    let pid;
    try {
      const started = await run('start', '-b', '--port', String(port));
      assert.equal(started.code, 0, started.text);
      assert.match(started.text, /plan2api is running in the background/);
      ({ pid } = readPidRecord().record);
      assert.equal(isProcessAlive(pid), true);
      assert.notEqual(pid, process.pid);
      assert.deepEqual(await fetchHealth('127.0.0.1', port), { ok: true, pid });

      const status = await run('status');
      assert.equal(status.code, 0, status.text);
      assert.match(status.text, new RegExp(`PID:\\s+${pid}`));
      assert.match(status.text, new RegExp(`http://127\\.0\\.0\\.1:${port}`));

      const again = await run('start', '--background', '--port', String(port));
      assert.equal(again.code, 1);
      assert.match(again.text, /already running/);

      const log = readFileSync(getLogPath(), 'utf8');
      assert.match(log, new RegExp(`plan2api is listening on http://127\\.0\\.0\\.1:${port}`));

      const stopped = await run('stop');
      assert.equal(stopped.code, 0, stopped.text);
      assert.match(stopped.text, new RegExp(`Stopped the background server \\(pid ${pid}\\)`));
      assert.equal(isProcessAlive(pid), false, 'the server process is gone');
      assert.equal(existsSync(getPidPath()), false);
      assert.equal((await probePort(port, '127.0.0.1')).free, true, 'the port is free again');

      const after = await run('status');
      assert.equal(after.code, 1);
      assert.match(after.text, /not running/);
    } finally {
      if (pid !== undefined && isProcessAlive(pid)) await terminateServer(pid).catch(() => {});
    }
  });
});

describe('--effort end to end (a real detached server and a fake "claude" that reports its arguments)', () => {
  /** A `claude` command that runs fixtures/fake-claude.js with this Node, without needing a shell. */
  function installFakeClaude() {
    const dir = join(sandbox, 'bin');
    mkdirSync(dir);
    if (process.platform === 'win32') {
      // The shape npm writes for a global install: plan2api reads it to find what it starts.
      copyFileSync(FAKE, join(dir, 'fake-claude.mjs'));
      const shim = join(dir, 'claude.cmd');
      writeFileSync(shim, '@echo off\r\n"%dp0%\\fake-claude.mjs" %*\r\n');
      return shim;
    }
    const quote = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
    const script = join(dir, 'claude');
    writeFileSync(script, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`, {
      mode: 0o755,
    });
    return script;
  }

  const runCli = async (...argv) => {
    const { io, out } = capture();
    const code = await main(argv, io);
    return { code, text: out.text };
  };

  /** POST /v1/messages (with http, not fetch, which refuses a few ports the OS may hand out). */
  function ask(port, apiKey) {
    const body = JSON.stringify({
      model: 'haiku',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/messages',
          method: 'POST',
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-api-key': apiKey,
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /** The arguments the fake claude was started with for one request (it echoes them back). */
  const claudeArgsFrom = (answer) => JSON.parse(JSON.parse(answer.text).content[0].text).args;
  const effortArgs = (args) => args.filter((arg) => arg.startsWith('--effort'));

  it(
    'start --background --effort low: the detached server hands --effort=low to claude',
    { timeout: 90_000 },
    async () => {
      process.env.PLAN2API_CLAUDE_PATH = installFakeClaude();
      const { key } = createKey('e2e');
      const port = await freePort();
      const pids = [];
      try {
        const started = await runCli('start', '-b', '--port', String(port), '--effort', 'low');
        assert.equal(started.code, 0, started.text);
        assert.match(started.text, /^ {2}Effort: {2}low$/m);
        pids.push(readPidRecord().record.pid);
        assert.equal(readPidRecord().record.effort, 'low');
        assert.match(readFileSync(getLogPath(), 'utf8'), /^Effort: low \(every Claude run\)$/m);

        const status = await runCli('status');
        assert.equal(status.code, 0, status.text);
        assert.match(status.text, /^ {2}Effort: {2}low$/m);

        const answer = await ask(port, key);
        assert.equal(answer.status, 200, answer.text);
        const args = claudeArgsFrom(answer);
        assert.deepEqual(effortArgs(args), ['--effort=low']);
        assert.equal(args.at(-1), '--model=haiku');

        assert.equal((await runCli('stop')).code, 0);
        assert.equal(isProcessAlive(pids[0]), false);

        // The same Claude Code, started without --effort: no effort argument anywhere.
        const plain = await runCli('start', '-b', '--port', String(port));
        assert.equal(plain.code, 0, plain.text);
        pids.push(readPidRecord().record.pid);
        assert.equal(Object.hasOwn(readPidRecord().record, 'effort'), false);
        assert.doesNotMatch(plain.text, /Effort/);
        assert.match((await runCli('status')).text, /^ {2}Effort: {2}default \(not set\)$/m);
        const plainAnswer = await ask(port, key);
        assert.equal(plainAnswer.status, 200, plainAnswer.text);
        assert.deepEqual(effortArgs(claudeArgsFrom(plainAnswer)), []);
        assert.equal((await runCli('stop')).code, 0);
      } finally {
        for (const pid of pids) {
          if (isProcessAlive(pid)) await terminateServer(pid).catch(() => {});
        }
      }
    },
  );

  it(
    'start --effort with a Claude Code that does not list it: fails at start-up, starts nothing',
    { timeout: 60_000 },
    async () => {
      process.env.PLAN2API_CLAUDE_PATH = installFakeClaude();
      process.env.FAKE_CLAUDE_MODE = 'no-effort-help';
      try {
        const port = await freePort();
        for (const flags of [[], ['-b']]) {
          const { code, text } = await runCli(
            'start',
            ...flags,
            '--port',
            String(port),
            '--effort',
            'low',
          );
          assert.equal(code, 1, text);
          assert.match(text, /Cannot use --effort: Claude Code 9\.9\.9 does not list --effort/);
          assert.match(text, /Update Claude Code/);
          assert.equal(existsSync(getPidPath()), false, 'no background server was recorded');
          assert.equal((await probePort(port, '127.0.0.1')).free, true, 'nothing is listening');
        }
      } finally {
        delete process.env.FAKE_CLAUDE_MODE;
      }
    },
  );
});
