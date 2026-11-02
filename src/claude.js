import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Plan2ApiError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;
export const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';

/**
 * The effort levels `claude --effort` accepts. This list is the only source of the value that
 * reaches the command line: a caller's string is looked up here, never passed on itself.
 */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const MAX_MODEL_LENGTH = 128;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 2_000;

// The system prompt lives next to (not inside) the empty working directory, so the
// argument stays a constant and the working directory stays empty.
const SYSTEM_PROMPT_FILE = '../system-prompt.txt';

/**
 * Used when the request has no `system` field. Claude Code's own default prompt is written
 * for an agent with tools; with every tool disabled it makes the model pretend to run
 * commands and invent their output. This one keeps it a plain assistant (and is much shorter).
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant replying through a plain text API. You have no tools: you ' +
  'cannot run commands, read or list files, browse the web, or access the computer you are ' +
  'running on. If asked to do any of those things, say plainly that you cannot, and never ' +
  'invent results or write tool-call markup. Answer everything else normally.';

/**
 * Everything passed to `claude` except an optional model. The prompt never goes on the
 * command line: it is written to stdin.
 *   -p                        non-interactive: read the prompt from stdin, print the answer
 *   --output-format stream-json (+ --verbose, which it requires)
 *                             one JSON event per line: the init message, the assistant message
 *                             (which names the model that really answered) and the result
 *                             with the text and token usage
 *   --tools ""                disable ALL built-in tools (no shell, no file access)
 *   --safe-mode               ignore hooks, CLAUDE.md, plugins, MCP servers, custom commands
 *   --disable-slash-commands  no skills
 *   --strict-mcp-config       only MCP servers from --mcp-config (we pass none)
 *   --no-session-persistence  do not save the conversation to disk
 */
const BASE_ARGS = Object.freeze([
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--tools',
  '',
  '--safe-mode',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--no-session-persistence',
]);

/** A failure running Claude Code. `code` says what went wrong. */
export class ClaudeError extends Plan2ApiError {
  /**
   * @param {'not_found'|'timeout'|'aborted'|'invalid_model'|'invalid_request'|'failed'} code
   * @param {string} message
   * @param {{ upstreamStatus?: number, reported?: boolean }} [details] `reported` marks a message
   *   that is Claude's own answer to the request, which is safe to show to an API caller. Other
   *   messages can name programs and files on this machine, so the server keeps them in its log.
   */
  constructor(code, message, { upstreamStatus, reported = false } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.reported = reported;
  }
}

/** True when `model` is safe to hand to `claude --model=`. */
export function isValidModel(model) {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= MAX_MODEL_LENGTH &&
    MODEL_PATTERN.test(model) &&
    // A name starting with "-" could be mistaken for an option.
    !model.startsWith('-')
  );
}

/** True when `effort` is exactly one of EFFORT_LEVELS. */
export function isEffortLevel(effort) {
  return typeof effort === 'string' && EFFORT_LEVELS.includes(effort);
}

/**
 * The full, fixed argument list for `claude`. `effort` is optional and, when given, must be one
 * of EFFORT_LEVELS; without it no effort argument is passed and Claude Code uses its own default.
 */
export function buildClaudeArgs({ model, effort } = {}) {
  const args = [...BASE_ARGS, '--system-prompt-file', SYSTEM_PROMPT_FILE];
  if (effort !== undefined) {
    if (!isEffortLevel(effort)) {
      throw new ClaudeError(
        'invalid_request',
        `The effort level must be one of: ${EFFORT_LEVELS.join(', ')}.`,
      );
    }
    args.push(`--effort=${EFFORT_LEVELS.find((level) => level === effort)}`);
  }
  if (model !== undefined) {
    if (!isValidModel(model)) {
      throw new ClaudeError(
        'invalid_model',
        'The model name may only contain letters, digits, ".", "_" and "-", and cannot start with "-".',
      );
    }
    args.push(`--model=${model}`);
  }
  return args;
}

function notFound() {
  return new ClaudeError(
    'not_found',
    `Claude Code was not found on your PATH. Install it with: ${INSTALL_COMMAND}`,
  );
}

/**
 * Works out how to launch Claude Code without a shell.
 *
 * On Windows an npm install gives `claude.cmd`, which Node cannot start without a shell
 * (and starting it through one would put arguments through cmd.exe parsing). Instead the
 * shim is read as text to find the real program it launches: a native `claude.exe`, or a
 * JavaScript file that we run with this Node binary.
 *
 * `PLAN2API_CLAUDE_PATH` overrides the lookup.
 */
export function resolveClaude({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  readText = (file) => readFileSync(file, 'utf8'),
  nodePath = process.execPath,
} = {}) {
  const override = env.PLAN2API_CLAUDE_PATH;
  if (platform !== 'win32') return { file: override || 'claude', prefixArgs: [] };

  const win = path.win32;
  const fromShim = (shim) => {
    const text = readText(shim);
    // npm's cmd-shim writes the target as "%dp0%\relative\path"; the launched program is last.
    const targets = [...text.matchAll(/"%~?dp0%?[\\/]*([^"\r\n]+)"/gi)];
    const relative = targets.length > 0 ? targets[targets.length - 1][1] : null;
    const target = relative && win.join(win.dirname(shim), relative);
    const extension = target ? win.extname(target).toLowerCase() : '';

    if (target && exists(target)) {
      if (extension === '.exe') return { file: target, prefixArgs: [] };
      if (['.js', '.cjs', '.mjs'].includes(extension)) {
        return { file: nodePath, prefixArgs: [target] };
      }
    }
    throw new ClaudeError(
      'not_found',
      `Found ${shim} but could not tell which program it starts. ` +
        'Set PLAN2API_CLAUDE_PATH to the full path of claude.exe.',
    );
  };
  const fromFile = (file) => (win.extname(file).toLowerCase() === '.cmd' ? fromShim(file) : null);

  if (override) {
    if (!exists(override)) throw notFound();
    return fromFile(override) ?? { file: override, prefixArgs: [] };
  }

  const dirs = (env.Path ?? env.PATH ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  for (const dir of dirs) {
    const exe = win.join(dir, 'claude.exe');
    if (exists(exe)) return { file: exe, prefixArgs: [] };
    const shim = win.join(dir, 'claude.cmd');
    if (exists(shim)) return fromShim(shim);
  }
  throw notFound();
}

function singleLine(text, max = 500) {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Starts `file args...` (never through a shell), feeds it `input`, and collects its output. */
function execute({ file, args, input, cwd, timeoutMs, signal, spawn }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let tooMuchOutput = false;
    const stdout = [];
    const stderr = [];
    let graceTimer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timeoutError = () =>
      new ClaudeError(
        'timeout',
        `Claude Code did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      );
    const abortedError = () => new ClaudeError('aborted', 'The request was cancelled.');

    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new ClaudeError('failed', `Could not start Claude Code: ${err.message}`));
      return;
    }

    const kill = () => {
      child.kill('SIGKILL');
      // 'close' normally follows immediately; do not hang forever if it does not.
      graceTimer = setTimeout(
        () => finish(reject, timedOut ? timeoutError() : abortedError()),
        KILL_GRACE_MS,
      );
    };
    function onAbort() {
      aborted = true;
      kill();
    }

    // Only read by `finish`, which cannot run before this line: every path to it is asynchronous.
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      finish(
        reject,
        err.code === 'ENOENT'
          ? notFound()
          : new ClaudeError('failed', `Could not start Claude Code: ${err.message}`),
      );
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        tooMuchOutput = true;
        kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    child.on('close', (code) => {
      if (timedOut) finish(reject, timeoutError());
      else if (aborted) finish(reject, abortedError());
      else if (tooMuchOutput) {
        finish(reject, new ClaudeError('failed', 'Claude Code produced too much output.'));
      } else {
        finish(resolve, {
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      }
    });

    // The child may exit before reading its input; that surfaces as EPIPE and is not fatal here.
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'utf8'));
  });
}

function toNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function mapUsage(usage) {
  const u = usage ?? {};
  return {
    // Anthropic reports cached tokens separately; here they are folded into the input total.
    input_tokens:
      toNumber(u.input_tokens) +
      toNumber(u.cache_creation_input_tokens) +
      toNumber(u.cache_read_input_tokens),
    output_tokens: toNumber(u.output_tokens),
  };
}

/**
 * Parses Claude Code's output into a list of events. Normally that is one JSON value per
 * line; a single object or an array of events (the plain `json` format) is accepted too.
 */
function parseEvents(stdout) {
  const events = [];
  const add = (value) => events.push(...(Array.isArray(value) ? value : [value]));
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      add(JSON.parse(line));
    } catch {
      // Not a JSON line: ignore it.
    }
  }
  if (events.length === 0 && stdout.trim()) {
    try {
      add(JSON.parse(stdout));
    } catch {
      // Handled by the caller: no result event means unreadable output.
    }
  }
  return events.filter((event) => event !== null && typeof event === 'object');
}

const MAX_MODEL_ID_LENGTH = 200;

/** Claude Code uses "<synthetic>" as the model of messages it writes itself (local errors). */
function isReportedModel(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_ID_LENGTH &&
    value !== '<synthetic>' &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

/** Of `ids`, the model that produced the most output tokens (the first one on a tie). */
function busiest(ids, modelUsage) {
  const usage = isRecord(modelUsage) ? modelUsage : {};
  let best;
  let bestOutput = -1;
  for (const id of ids) {
    const output = toNumber(usage[id]?.outputTokens);
    if (output > bestOutput) {
      best = id;
      bestOutput = output;
    }
  }
  return best;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Finds the model that REALLY answered, as an ID such as "claude-sonnet-4-6", or undefined.
 *
 * `modelUsage` alone cannot be trusted: Claude Code also runs small helper models (a haiku
 * call of about a dozen output tokens), so for a short answer the helper can have more output
 * tokens than the model that wrote it. The assistant message names the model that wrote it, so:
 *   1. models that wrote an assistant message (the most output tokens wins if there are several);
 *   2. the model in the init message;
 *   3. otherwise the model in `modelUsage` with the most output tokens.
 */
export function findAnsweringModel(events, modelUsage) {
  const authors = [
    ...new Set(
      events
        .filter((event) => event.type === 'assistant')
        .map((event) => event.message?.model)
        .filter(isReportedModel),
    ),
  ];
  if (authors.length > 0) return busiest(authors, modelUsage);

  const init = events.find((event) => event.type === 'system' && event.subtype === 'init')?.model;
  if (isReportedModel(init)) return init;

  const listed = isRecord(modelUsage) ? Object.keys(modelUsage).filter(isReportedModel) : [];
  return busiest(listed, modelUsage);
}

function parseResult({ stdout, stderr, code }) {
  const events = parseEvents(stdout);
  const result = events.findLast((event) => event.type === 'result');

  if (result) {
    if (result.is_error) {
      throw new ClaudeError(
        'failed',
        `Claude Code reported an error: ${singleLine(result.result) || 'unknown error'}`,
        {
          upstreamStatus: Number.isInteger(result.api_error_status)
            ? result.api_error_status
            : undefined,
          reported: true,
        },
      );
    }
    if (typeof result.result !== 'string') {
      throw new ClaudeError('failed', 'Claude Code returned no text.');
    }
    return {
      text: result.result,
      usage: mapUsage(result.usage),
      model: findAnsweringModel(events, result.modelUsage),
    };
  }
  if (code !== 0) {
    throw new ClaudeError(
      'failed',
      `Claude Code exited with code ${code}${stderr ? `: ${singleLine(stderr)}` : '.'}`,
    );
  }
  throw new ClaudeError('failed', 'Claude Code returned output that could not be understood.');
}

function removeDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A leftover empty temp directory is harmless.
  }
}

/**
 * Asks Claude Code for a text-only answer.
 *
 * Claude runs with every tool disabled, in a fresh empty directory that is deleted afterwards.
 * The prompt travels over stdin; the only caller-controlled command-line values are a validated
 * model name and an effort level from EFFORT_LEVELS. Resolves to
 * `{ text, usage: { input_tokens, output_tokens }, model }`, where `model` is the ID of the model
 * that really answered (undefined if Claude Code did not say).
 *
 * `deps` lets tests replace `spawn` and `resolveClaude`.
 */
export async function runClaude(
  { prompt, system, model, effort, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {},
  deps = {},
) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new ClaudeError('invalid_request', 'A non-empty prompt is required.');
  }
  const systemPrompt =
    typeof system === 'string' && system.trim().length > 0 ? system : DEFAULT_SYSTEM_PROMPT;
  const args = buildClaudeArgs({ model, effort });
  if (signal?.aborted) throw new ClaudeError('aborted', 'The request was cancelled.');
  const { file, prefixArgs } = (deps.resolveClaude ?? resolveClaude)();

  const root = mkdtempSync(path.join(tmpdir(), 'plan2api-'));
  const work = path.join(root, 'work');
  try {
    mkdirSync(work);
    writeFileSync(path.join(root, 'system-prompt.txt'), systemPrompt, { mode: 0o600 });
    const output = await execute({
      file,
      args: [...prefixArgs, ...args],
      input: prompt,
      cwd: work,
      timeoutMs,
      signal,
      spawn: deps.spawn ?? nodeSpawn,
    });
    return parseResult(output);
  } finally {
    removeDir(root);
  }
}

/** Returns the installed Claude Code version (for example "2.1.185"). */
export async function getClaudeVersion(deps = {}) {
  const { file, prefixArgs } = (deps.resolveClaude ?? resolveClaude)();
  const { code, stdout, stderr } = await execute({
    file,
    args: [...prefixArgs, '--version'],
    cwd: tmpdir(),
    timeoutMs: VERSION_TIMEOUT_MS,
    spawn: deps.spawn ?? nodeSpawn,
  });
  const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
  if (code !== 0 || !version) {
    throw new ClaudeError(
      'failed',
      `"claude --version" failed${stderr ? `: ${singleLine(stderr)}` : '.'}`,
    );
  }
  return version;
}

/**
 * True when the text of `claude --help` lists `--effort` as an option: a line that starts with it
 * (after any indentation and an optional short flag such as "-e, "). A description that merely
 * mentions the option, or a different option like `--effortless`, does not count.
 */
export function helpListsEffort(helpText) {
  return /^[ \t]*(?:-[A-Za-z],?[ \t]+)?--effort(?![\w-])/m.test(String(helpText));
}

/**
 * Whether the installed Claude Code lists `--effort` in `claude --help`. Older versions do not
 * know the option and would fail every request that passes it, so `plan2api start --effort` asks
 * once at start-up. Throws a ClaudeError if the help text cannot be read at all.
 */
export async function claudeSupportsEffort(deps = {}) {
  const { file, prefixArgs } = (deps.resolveClaude ?? resolveClaude)();
  const { code, stdout, stderr } = await execute({
    file,
    args: [...prefixArgs, '--help'],
    cwd: tmpdir(),
    timeoutMs: VERSION_TIMEOUT_MS,
    spawn: deps.spawn ?? nodeSpawn,
  });
  if (code !== 0 || !stdout.trim()) {
    throw new ClaudeError(
      'failed',
      `"claude --help" failed${stderr ? `: ${singleLine(stderr)}` : '.'}`,
    );
  }
  return helpListsEffort(stdout);
}
