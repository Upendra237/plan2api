import { execFile, spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEffortLevel } from './claude.js';
import { isMissingPathError, Plan2ApiError } from './errors.js';
import { getConfigDir } from './keys.js';
import { describeListenError, probePort as defaultProbePort } from './server.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 1024 * 1024;

const CLI_PATH = fileURLToPath(new URL('../bin/plan2api.js', import.meta.url));
const START_TIMEOUT_MS = 20_000;
const STARTING_GRACE_MS = 30_000;
const GRACEFUL_STOP_MS = 10_000;
const FORCE_STOP_MS = 5_000;
const HEALTH_TIMEOUT_MS = 2_000;
const LOG_TAIL_LINES = 15;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const getPidPath = () => path.join(getConfigDir(), 'server.pid');
export const getLogPath = () => path.join(getConfigDir(), 'plan2api.log');

/** `http://host:port`, with brackets around an IPv6 address. */
export function formatUrl(host, port) {
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

/** 45s, 2m 14s, 3h 5m, 2d 4h. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// --- pid file -----------------------------------------------------------------------------

function toRecord(value) {
  if (value === null || typeof value !== 'object') return null;
  const { pid, host, port, startedAt, effort } = value;
  const valid =
    Number.isInteger(pid) &&
    pid > 1 &&
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 255 &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    typeof startedAt === 'string' &&
    Number.isFinite(Date.parse(startedAt));
  // Only an allowlisted effort level is kept, so nothing else from the file is ever printed.
  return valid
    ? { pid, host, port, startedAt, ...(isEffortLevel(effort) ? { effort } : {}) }
    : null;
}

/**
 * Reads the pid file. `exists` says whether there is one; `record` is `{ pid, host, port,
 * startedAt }` (plus `effort` when the server was started with --effort), or null when the file
 * is missing or cannot be understood.
 */
export function readPidRecord() {
  let text;
  try {
    text = readFileSync(getPidPath(), 'utf8');
  } catch (err) {
    if (isMissingPathError(err)) return { exists: false, record: null };
    throw new Plan2ApiError(`Could not read ${getPidPath()}: ${err.message}`);
  }
  try {
    return { exists: true, record: toRecord(JSON.parse(text)) };
  } catch {
    return { exists: true, record: null };
  }
}

export function writePidRecord({ pid, host, port, startedAt, effort }) {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  const record = { pid, host, port, startedAt, ...(effort === undefined ? {} : { effort }) };
  // Written to a temp file and renamed, so `status` or `stop` never read a half-written file.
  const tmp = `${getPidPath()}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, getPidPath());
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort: a failed clean-up must not hide why the write failed.
    }
    throw err;
  }
}

export function removePidRecord() {
  rmSync(getPidPath(), { force: true });
}

// --- log file -----------------------------------------------------------------------------

/** When the log is over `maxBytes`, keeps only its last `keepBytes` (from a whole line). */
export function capLog(file, { maxBytes = MAX_LOG_BYTES, keepBytes = KEEP_LOG_BYTES } = {}) {
  let size;
  try {
    size = statSync(file).size;
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
  if (size <= maxBytes) return false;

  const tail = Buffer.alloc(Math.min(keepBytes, size));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, tail, 0, tail.length, size - tail.length);
  } finally {
    closeSync(fd);
  }
  const firstLineBreak = tail.indexOf(0x0a);
  const kept = firstLineBreak >= 0 ? tail.subarray(firstLineBreak + 1) : tail;
  writeFileSync(file, Buffer.concat([Buffer.from('[earlier log lines were trimmed]\n'), kept]), {
    mode: 0o600,
  });
  return true;
}

/** The last `maxLines` lines written to `file` after byte offset `fromOffset`. */
export function readLogTail(file, fromOffset = 0, maxLines = LOG_TAIL_LINES) {
  try {
    const size = statSync(file).size;
    const start = Math.max(fromOffset, size - 8192);
    if (start >= size) return [];
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    return buffer
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/\p{Cc}/gu, ' ').trimEnd())
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  }
}

function logSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

// --- talking to a running server ----------------------------------------------------------

/** A wildcard bind address cannot be connected to; use the matching loopback address. */
function connectableHost(host) {
  const bare = host.replace(/^\[|\]$/g, '');
  if (bare === '0.0.0.0') return '127.0.0.1';
  if (bare === '::') return '::1';
  return bare;
}

/** Asks `GET /health`. Resolves to `{ ok, pid }`; `ok` is false when nothing sensible answers. */
export function fetchHealth(host, port, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: connectableHost(host),
        port,
        path: '/health',
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024) res.destroy();
        });
        res.on('error', () => resolve({ ok: false }));
        res.on('close', () => {
          try {
            const data = JSON.parse(body);
            resolve({
              ok: res.statusCode === 200 && data.status === 'ok',
              pid: Number.isInteger(data.pid) ? data.pid : undefined,
            });
          } catch {
            resolve({ ok: false });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.on('error', () => resolve({ ok: false }));
    req.end();
  });
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return err.code === 'EPERM';
  }
}

/**
 * Looks at the pid file and the process it names. `state` is one of:
 *   stopped    no pid file
 *   running    the process answers /health on the recorded host and port, and reports its own pid
 *   starting   the process is alive but does not answer yet, and was started moments ago
 *   stale      the pid file is unreadable, or its process is gone
 *   unverified the process is alive but does not answer as our server (the pid may be reused)
 */
export async function inspectServer({
  now = Date.now,
  isAlive = isProcessAlive,
  fetchHealth: probe = fetchHealth,
} = {}) {
  const { exists, record } = readPidRecord();
  if (!exists) return { state: 'stopped' };
  if (!record) return { state: 'stale', reason: `${getPidPath()} is not a valid pid file` };
  if (!isAlive(record.pid)) {
    return { state: 'stale', record, reason: `process ${record.pid} is not running` };
  }

  const health = await probe(record.host, record.port);
  if (health.ok && health.pid === record.pid) return { state: 'running', record };

  const age = now() - Date.parse(record.startedAt);
  if (age >= 0 && age < STARTING_GRACE_MS) return { state: 'starting', record };
  return {
    state: 'unverified',
    record,
    reason: `process ${record.pid} is running but does not answer as a plan2api server on ${formatUrl(record.host, record.port)}`,
  };
}

// --- ending a process ---------------------------------------------------------------------

/** Ends a process and its whole tree (the `claude` children) on Windows. */
function taskkill(pid) {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve) => {
    // The exit code does not matter: the caller checks whether the process is really gone.
    execFile(exe, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

/**
 * Ends the server `pid` and everything it started, so no `claude` process is left behind.
 *  - Linux/macOS: SIGTERM, which makes the server shut down gracefully and kill its own Claude
 *    runs. If it has not exited after 10 s it is killed, together with its process group.
 *  - Windows cannot signal a hidden background process, so the whole process tree is ended.
 */
export async function terminateServer(pid, deps = {}) {
  const platform = deps.platform ?? process.platform;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const kill = deps.kill ?? process.kill.bind(process);

  const waitForExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid)) {
      if (Date.now() > deadline) return false;
      await sleep(50);
    }
    return true;
  };
  const cannotStop = () => new Plan2ApiError(`Could not stop process ${pid}.`);

  if (platform === 'win32') {
    await (deps.taskkill ?? taskkill)(pid);
    if (!(await waitForExit(deps.forceMs ?? FORCE_STOP_MS))) throw cannotStop();
    return;
  }

  try {
    kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') throw cannotStop();
  }
  if (!(await waitForExit(deps.gracefulMs ?? GRACEFUL_STOP_MS))) {
    try {
      kill(-pid, 'SIGKILL');
    } catch {
      kill(pid, 'SIGKILL');
    }
    if (!(await waitForExit(deps.forceMs ?? FORCE_STOP_MS))) throw cannotStop();
  }
  // The server started in its own process group, so this also catches any Claude run it left.
  try {
    kill(-pid, 'SIGKILL');
  } catch {
    // The group is already empty.
  }
}

// --- commands -----------------------------------------------------------------------------

function describeRunning({ pid, host, port }) {
  return `pid ${pid}, ${formatUrl(host, port)}`;
}

/**
 * `plan2api start --background`: starts the normal foreground server as a detached child that
 * logs to ~/.plan2api/plan2api.log, records it in the pid file, and returns once it answers.
 */
export async function startInBackground(options, io, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const probeHealth = deps.fetchHealth ?? fetchHealth;
  const probePort = deps.probePort ?? defaultProbePort;
  const terminate = deps.terminate ?? terminateServer;
  const { host, port, effort } = options;
  if (effort !== undefined && !isEffortLevel(effort)) {
    throw new Plan2ApiError(`Invalid effort level: ${JSON.stringify(effort)}.`);
  }

  const existing = await inspectServer({ ...deps, fetchHealth: probeHealth });
  if (existing.state === 'running') {
    throw new Plan2ApiError(
      `A background server is already running (${describeRunning(existing.record)}).\n` +
        'Stop it first with: plan2api stop',
    );
  }
  if (existing.state === 'starting') {
    throw new Plan2ApiError(
      `A background server is still starting (${describeRunning(existing.record)}).\n` +
        'Check on it with: plan2api status',
    );
  }
  // Stale, or a reused pid: the recorded process is not our server, so the record is junk.
  if (existing.state !== 'stopped') removePidRecord();

  const portProbe = await probePort(port, host);
  if (!portProbe.free) {
    throw new Plan2ApiError(
      describeListenError({ code: portProbe.code, message: String(portProbe.code) }, host, port),
    );
  }

  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = getLogPath();
  capLog(logPath);
  const logStart = logSize(logPath);

  const args = [
    CLI_PATH,
    'start',
    `--host=${host}`,
    `--port=${port}`,
    `--concurrency=${options.concurrency}`,
    `--timeout=${options.timeoutSeconds}`,
    `--rate-limit=${options.rateLimit}`,
    // The child runs the normal foreground start, so it gets the same --effort (and checks it).
    ...(effort === undefined ? [] : [`--effort=${effort}`]),
  ];
  const logFd = openSync(logPath, 'a', 0o600);
  let child;
  try {
    // Detached: its own session on Linux/macOS (survives the terminal closing) and no console on
    // Windows. windowsHide keeps a console window from flashing up.
    child = spawn(process.execPath, args, {
      cwd: dir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      // The child runs with `dir` as its working directory, so it must be given the absolute
      // path: a relative PLAN2API_HOME would otherwise resolve to a different folder for it.
      env: { ...process.env, PLAN2API_HOME: dir },
    });
  } finally {
    closeSync(logFd);
  }

  let exit = null;
  let spawnError = null;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  child.once('error', (err) => {
    spawnError = err;
  });
  if (child.pid === undefined) await sleep(0); // let the 'error' event arrive

  if (child.pid !== undefined) {
    writePidRecord({
      pid: child.pid,
      host,
      port,
      startedAt: new Date(now()).toISOString(),
      effort,
    });
  }

  const deadline = now() + (deps.startTimeoutMs ?? START_TIMEOUT_MS);
  let ready = false;
  while (child.pid !== undefined && !exit && !spawnError && now() < deadline) {
    const health = await probeHealth(host, port, 500);
    if (health.ok && health.pid === child.pid) {
      ready = true;
      break;
    }
    await sleep(150);
  }

  if (ready) {
    child.unref();
    // Labels line up; without --effort the output is exactly what it always was.
    const label = (name) => `  ${`${name}:`.padEnd(effort === undefined ? 6 : 9)}`;
    io.stdout.write(
      [
        'plan2api is running in the background.',
        `${label('PID')}${child.pid}`,
        `${label('URL')}${formatUrl(host, port)}`,
        `${label('Log')}${logPath}`,
        ...(effort === undefined ? [] : [`${label('Effort')}${effort}`]),
        'Check on it with: plan2api status    Stop it with: plan2api stop',
        '',
      ].join('\n'),
    );
    return 0;
  }

  // It did not start: do not leave a half-started server or a pid file behind.
  let reason;
  if (spawnError) reason = `the process could not be started: ${spawnError.message}`;
  else if (exit) reason = `it exited with ${exit.signal ?? `code ${exit.code}`}`;
  else reason = `it did not answer on ${formatUrl(host, port)} in time`;
  if (child.pid !== undefined && !exit) {
    await terminate(child.pid, deps).catch(() => {});
  }
  removePidRecord();

  const tail = readLogTail(logPath, logStart);
  throw new Plan2ApiError(
    `The background server did not start (${reason}).` +
      (tail.length > 0
        ? `\nLast lines of ${logPath}:\n${tail.map((l) => `  ${l}`).join('\n')}`
        : ''),
  );
}

/** `plan2api stop`. Only ever ends a process that proves it is our server. */
export async function stopBackground(io, deps = {}) {
  const info = await inspectServer(deps);

  if (info.state === 'stopped') {
    io.stdout.write('plan2api is not running in the background.\n');
    return 0;
  }
  if (info.state === 'stale') {
    removePidRecord();
    io.stdout.write(`Removed a stale pid file (${info.reason}). No server was running.\n`);
    return 0;
  }
  if (info.state === 'starting') {
    throw new Plan2ApiError(
      `The background server (${describeRunning(info.record)}) is still starting and cannot be ` +
        'verified yet. Try again in a moment.',
    );
  }
  if (info.state === 'unverified' || info.record.pid === process.pid) {
    throw new Plan2ApiError(
      `Not stopping process ${info.record.pid}: it does not answer as a plan2api server on ` +
        `${formatUrl(info.record.host, info.record.port)}, so the pid may belong to another ` +
        `program now.\nIf it really is a stuck plan2api server, end it yourself and delete ` +
        `${getPidPath()}.`,
    );
  }

  const { pid } = info.record;
  await terminateServer(pid, deps);
  removePidRecord();
  io.stdout.write(`Stopped the background server (pid ${pid}).\n`);
  return 0;
}

/** `plan2api status`. Exit code 0 when a background server is running, otherwise 1. */
export async function showStatus(io, deps = {}) {
  const now = deps.now ?? Date.now;
  const info = await inspectServer(deps);

  if (info.state === 'running') {
    const { pid, host, port, startedAt, effort } = info.record;
    io.stdout.write(
      [
        'plan2api is running in the background.',
        `  PID:     ${pid}`,
        `  URL:     ${formatUrl(host, port)}`,
        `  Uptime:  ${formatDuration(now() - Date.parse(startedAt))}`,
        `  Started: ${startedAt}`,
        `  Effort:  ${effort ?? 'default (not set)'}`,
        `  Log:     ${getLogPath()}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  let note = '';
  if (info.state === 'starting') {
    note = ` yet (${describeRunning(info.record)} is still starting)`;
  } else if (info.state === 'stale') {
    note = ` (stale pid file: ${info.reason}; "plan2api stop" removes it)`;
  } else if (info.state === 'unverified') {
    note = ` (${info.reason}; it was left alone)`;
  }
  io.stdout.write(`plan2api is not running in the background${note}.\n`);
  return 1;
}
