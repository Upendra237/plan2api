import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ClaudeError,
  getClaudeVersion as defaultGetClaudeVersion,
  INSTALL_COMMAND,
  runClaude as defaultRunClaude,
} from './claude.js';
import { formatDuration, formatUrl, inspectServer as defaultInspectServer } from './background.js';
import { getConfigDir, getKeysPath, KeyError, listKeys } from './keys.js';
import { DEFAULTS, probePort } from './server.js';

const MIN_NODE_MAJOR = 20;

const LOGIN_TEST_PROMPT = 'Reply with the single word: ok';
const LOGIN_TEST_TIMEOUT_MS = 60_000;

const pass = (message) => ({ status: 'pass', message });
const fail = (message, fix) => ({ status: 'fail', message, fix });
const skip = (message) => ({ status: 'skip', message });

export function checkNode(nodeVersion = process.versions.node) {
  const major = Number(String(nodeVersion).split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return pass(`Node.js ${nodeVersion} (${MIN_NODE_MAJOR} or newer is required)`);
  }
  return fail(
    `Node.js ${nodeVersion} is too old (${MIN_NODE_MAJOR} or newer is required)`,
    `Install a current Node.js LTS from https://nodejs.org and run plan2api again.`,
  );
}

async function checkClaude(getClaudeVersion = defaultGetClaudeVersion) {
  try {
    return { ...pass(`Claude Code ${await getClaudeVersion()}`), installed: true };
  } catch (err) {
    if (err instanceof ClaudeError && err.code === 'not_found') {
      return fail('Claude Code was not found', `Install it with: ${INSTALL_COMMAND}`);
    }
    return fail(
      `Claude Code could not be started (${err.message})`,
      `Reinstall it with: ${INSTALL_COMMAND}`,
    );
  }
}

async function checkLogin({ call, installed, runClaude }) {
  if (!call) return skip('Login not checked (--no-call)');
  if (!installed) return skip('Login not checked (Claude Code is not available)');

  const started = performance.now();
  try {
    const { text } = await runClaude({
      prompt: LOGIN_TEST_PROMPT,
      timeoutMs: LOGIN_TEST_TIMEOUT_MS,
    });
    if (text.trim().length === 0)
      throw new ClaudeError('failed', 'Claude returned an empty answer.');
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    return pass(`Logged in (text-only test call succeeded in ${seconds}s)`);
  } catch (err) {
    const timedOut = err instanceof ClaudeError && err.code === 'timeout';
    return fail(
      `Test call to Claude Code failed: ${err.message}`,
      timedOut
        ? 'Run "claude" in a terminal and make sure it answers, then try again.'
        : 'Run "claude" in a terminal and log in (type /login). If the error mentions an ' +
            `unknown option, update Claude Code with: ${INSTALL_COMMAND}`,
    );
  }
}

function checkDataDir() {
  const dir = getConfigDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = path.join(dir, `.doctor-${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
  } catch (err) {
    return fail(
      `Data directory ${dir} is not writable (${err.code ?? err.message})`,
      `Fix the permissions on ${dir}, or set PLAN2API_HOME to a directory you can write to.`,
    );
  }
  try {
    const count = listKeys().length;
    const hint = count === 0 ? ' - create one with: plan2api create <name>' : '';
    return pass(
      `Data directory ${dir} is writable; ${count} ${count === 1 ? 'key' : 'keys'}${hint}`,
    );
  } catch (err) {
    if (!(err instanceof KeyError)) throw err;
    return fail(err.message, `Fix or delete ${getKeysPath()}.`);
  }
}

/** Reports whether a server started with `plan2api start --background` is running. */
function checkBackground(info, now = Date.now()) {
  if (info.state === 'running') {
    const { pid, host, port, startedAt } = info.record;
    const uptime = formatDuration(now - Date.parse(startedAt));
    return pass(
      `Background server is running (pid ${pid}, ${formatUrl(host, port)}, up ${uptime})`,
    );
  }
  if (info.state === 'starting') {
    return skip(`Background server is still starting (pid ${info.record.pid})`);
  }
  if (info.state === 'stale' || info.state === 'unverified') {
    return skip(`No background server is running (pid file is out of date: ${info.reason})`);
  }
  return skip('No background server is running (start one with: plan2api start --background)');
}

export async function checkPort(port, host = DEFAULTS.host, background = { state: 'stopped' }) {
  // Our own background server being on the port is fine, not a problem.
  if (background.state === 'running' && background.record.port === port) {
    return pass(
      `Port ${port} is in use by the background plan2api server (pid ${background.record.pid})`,
    );
  }
  const probe = await probePort(port, host);
  if (probe.free) return pass(`Port ${port} is free`);
  return fail(
    probe.code === 'EADDRINUSE'
      ? `Port ${port} is already in use`
      : `Port ${port} cannot be used (${probe.code ?? 'unknown error'})`,
    `Stop the program using it, or start plan2api on another port: plan2api start --port <number>`,
  );
}

/**
 * The checks `plan2api start` needs before it can work: Node and Claude Code.
 * Returns the failures (an empty array when all is well).
 */
export async function quickChecks({
  nodeVersion = process.versions.node,
  getClaudeVersion = defaultGetClaudeVersion,
} = {}) {
  const failures = [];
  const node = checkNode(nodeVersion);
  if (node.status === 'fail') failures.push(node);
  const claude = await checkClaude(getClaudeVersion);
  if (claude.status === 'fail') failures.push(claude);
  return failures;
}

const MARKS = { pass: '✓', fail: '✗', skip: '-' };

/**
 * Runs every check and prints a ✓/✗ line for each (with a fix for each failure).
 * Resolves to the exit code: 0 when nothing failed, otherwise 1.
 */
export async function runDoctor(
  { call = true, port = DEFAULTS.port } = {},
  io = { stdout: process.stdout },
  deps = {},
) {
  const results = [];
  results.push(checkNode(deps.nodeVersion));
  const claude = await checkClaude(deps.getClaudeVersion);
  results.push(claude);
  results.push(
    await checkLogin({
      call,
      installed: claude.installed === true,
      runClaude: deps.runClaude ?? defaultRunClaude,
    }),
  );
  results.push(checkDataDir());
  const background = await (deps.inspectServer ?? defaultInspectServer)();
  results.push(checkBackground(background, deps.now?.()));
  results.push(await checkPort(port, DEFAULTS.host, background));

  const lines = ['plan2api doctor', ''];
  for (const { status, message, fix } of results) {
    lines.push(`${MARKS[status]} ${message}`);
    if (status === 'fail') lines.push(`    Fix: ${fix}`);
  }
  const failed = results.filter((result) => result.status === 'fail').length;
  lines.push(
    '',
    failed === 0
      ? background.state === 'running'
        ? 'All checks passed.'
        : 'All checks passed. Start the server with: plan2api start'
      : `${failed} ${failed === 1 ? 'check' : 'checks'} failed. Fix the problems above and run plan2api doctor again.`,
    '',
  );
  io.stdout.write(lines.join('\n'));
  return failed === 0 ? 0 : 1;
}
