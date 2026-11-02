import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { showStatus, startInBackground, stopBackground } from './background.js';
import {
  claudeSupportsEffort,
  EFFORT_LEVELS,
  getClaudeVersion,
  INSTALL_COMMAND,
  isEffortLevel,
} from './claude.js';
import { quickChecks, runDoctor } from './doctor.js';
import { Plan2ApiError } from './errors.js';
import { createKey, deleteKey, getKeysPath, listKeys } from './keys.js';
import { DEFAULTS, isLoopbackHost, startServer } from './server.js';

const HELP = `plan2api - turn your own logged-in Claude Code into a local API

Unofficial. Not affiliated with Anthropic.

Usage:
  plan2api <command> [options]

Commands:
  create <name>   Generate a new API key and print it once
  list            List key names and creation dates (never the keys)
  delete <name>   Delete a key
  start           Start the local API server
  stop            Stop the server that was started with --background
  status          Show whether a background server is running (exit code 0 = running)
  doctor          Check that everything plan2api needs is working

Options for start:
  -b, --background       Run the server in the background (survives closing the terminal);
                         its output goes to ~/.plan2api/plan2api.log
  --host <host>          Address to listen on (default ${DEFAULTS.host})
  --port <port>          Port to listen on (default ${DEFAULTS.port})
  --concurrency <n>      Claude runs at the same time (default ${DEFAULTS.concurrency})
  --timeout <seconds>    Give up on a Claude run after this long (default ${DEFAULTS.timeoutSeconds})
  --rate-limit <n>       Requests per minute for each key, 0 = unlimited (default ${DEFAULTS.rateLimit})
  --effort <level>       Effort level for every Claude run: ${EFFORT_LEVELS.join(', ')}
                         (default: not set, Claude Code decides; may have little or no effect
                         on some models, for example haiku)

Options for doctor:
  --no-call              Skip the test call to Claude (does not check login)
  --port <port>          Port to check (default ${DEFAULTS.port})

Options:
  -h, --help      Show this help
  -v, --version   Show the version
`;

class UsageError extends Error {}

function readVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

function expectArgs(args, usage, count) {
  const extraFlag = args.find((arg) => arg.startsWith('-'));
  if (extraFlag) throw new UsageError(`Unknown option '${extraFlag}'`);
  if (args.length < count) throw new UsageError(`Missing argument. Usage: plan2api ${usage}`);
  if (args.length > count) {
    throw new UsageError(`Too many arguments. Usage: plan2api ${usage}`);
  }
}

function parseFlags(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: false, strict: true }).values;
  } catch (err) {
    if (typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS')) {
      throw new UsageError(err.message.split(/\.\s/)[0].replace(/\.$/, ''));
    }
    throw err;
  }
}

function parseInteger(name, raw, min, max) {
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= min && value <= max)) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseHost(raw) {
  if (raw.length === 0 || raw.length > 255 || /\s/.test(raw)) {
    throw new UsageError('--host must be a host name or IP address, for example 127.0.0.1.');
  }
  return raw;
}

function parseEffort(raw) {
  if (!isEffortLevel(raw)) {
    const shown = JSON.stringify(raw.length > 40 ? `${raw.slice(0, 40)}...` : raw);
    throw new UsageError(`--effort must be one of: ${EFFORT_LEVELS.join(', ')} (got ${shown}).`);
  }
  return raw;
}

/** `--effort` needs a Claude Code that knows the option; otherwise every request would fail. */
async function requireEffortSupport(deps) {
  if (await (deps.supportsEffort ?? claudeSupportsEffort)()) return;
  const version = await (deps.getClaudeVersion ?? getClaudeVersion)().catch(() => null);
  throw new Plan2ApiError(
    `Cannot use --effort: ${version ? `Claude Code ${version}` : 'this version of Claude Code'} ` +
      'does not list --effort in "claude --help".\n' +
      `Update Claude Code with "claude update" (or: ${INSTALL_COMMAND}), ` +
      'or start plan2api without --effort.',
  );
}

function runCreate(args, io) {
  expectArgs(args, 'create <name>', 1);
  const { name, key } = createKey(args[0]);
  io.stdout.write(
    [
      `Created key ${JSON.stringify(name)}:`,
      '',
      `  ${key}`,
      '',
      'Copy it now. This key cannot be shown again - only its SHA-256 hash is stored,',
      `in ${getKeysPath()}`,
      '',
    ].join('\n'),
  );
}

function runList(args, io) {
  expectArgs(args, 'list', 0);
  const keys = listKeys();
  if (keys.length === 0) {
    io.stdout.write('No keys yet. Create one with: plan2api create <name>\n');
    return;
  }
  const width = Math.max('NAME'.length, ...keys.map((k) => k.name.length));
  const lines = [`${'NAME'.padEnd(width)}  CREATED`];
  for (const { name, createdAt } of keys) {
    lines.push(`${name.padEnd(width)}  ${createdAt.slice(0, 10)}`);
  }
  io.stdout.write(`${lines.join('\n')}\n`);
}

function runDelete(args, io) {
  expectArgs(args, 'delete <name>', 1);
  deleteKey(args[0]);
  io.stdout.write(`Deleted key ${JSON.stringify(args[0])}.\n`);
}

/** Resolves when the server stops, either by itself or after Ctrl+C / SIGTERM. */
function waitForStop(handle, io) {
  return new Promise((resolve) => {
    const signals = ['SIGINT', 'SIGTERM'];
    const cleanup = () => {
      for (const signal of signals) process.off(signal, onSignal);
    };
    const onSignal = (signal) => {
      cleanup(); // a second Ctrl+C then ends the process immediately
      io.stdout.write(`\nReceived ${signal}, stopping Claude runs and shutting down...\n`);
      handle.shutdown().then(() => resolve(0));
    };
    for (const signal of signals) process.on(signal, onSignal);
    handle.closed.then(() => {
      cleanup();
      resolve(0);
    });
  });
}

async function runStart(args, io, deps) {
  const flags = parseFlags(args, {
    background: { type: 'boolean', short: 'b' },
    host: { type: 'string' },
    port: { type: 'string' },
    concurrency: { type: 'string' },
    timeout: { type: 'string' },
    'rate-limit': { type: 'string' },
    effort: { type: 'string' },
  });
  const options = {
    host: flags.host === undefined ? DEFAULTS.host : parseHost(flags.host),
    port: flags.port === undefined ? DEFAULTS.port : parseInteger('port', flags.port, 1, 65535),
    concurrency:
      flags.concurrency === undefined
        ? DEFAULTS.concurrency
        : parseInteger('concurrency', flags.concurrency, 1, 64),
    timeoutSeconds:
      flags.timeout === undefined
        ? DEFAULTS.timeoutSeconds
        : parseInteger('timeout', flags.timeout, 1, 3600),
    rateLimit:
      flags['rate-limit'] === undefined
        ? DEFAULTS.rateLimit
        : parseInteger('rate-limit', flags['rate-limit'], 0, 1_000_000),
    // Only present when --effort was given, so without it nothing changes anywhere downstream.
    ...(flags.effort === undefined ? {} : { effort: parseEffort(flags.effort) }),
  };

  const failures = await (deps.quickChecks ?? quickChecks)();
  if (failures.length > 0) {
    const reasons = failures.map((failure) => failure.message).join('; ');
    throw new Plan2ApiError(
      `Cannot start: ${reasons}.\nRun "plan2api doctor" for details and how to fix it.`,
    );
  }
  if (options.effort !== undefined) await requireEffortSupport(deps);

  if (!isLoopbackHost(options.host)) {
    io.stderr.write(
      `Warning: listening on ${options.host}, which is reachable from other machines. API keys are\n` +
        'sent in clear text over plain HTTP, so put HTTPS in front of plan2api (for example Caddy or\n' +
        'a Cloudflare Tunnel) and see "Use your own domain" in docs/usage.md.\n',
    );
  }

  if (flags.background) {
    return (deps.startInBackground ?? startInBackground)(options, io);
  }

  const handle = await (deps.startServer ?? startServer)({
    ...options,
    log: (line) => io.stdout.write(`${line}\n`),
    logError: (line) => io.stderr.write(`${line}\n`),
  });

  let keyCount = 0;
  try {
    keyCount = listKeys().length;
  } catch {
    // The doctor reports a broken key file; the server answers 500 until it is fixed.
  }
  io.stdout.write(
    [
      `plan2api is listening on ${handle.url}`,
      `Concurrency ${options.concurrency}, timeout ${options.timeoutSeconds}s, ` +
        (options.rateLimit === 0
          ? 'no rate limit'
          : `rate limit ${options.rateLimit} requests/minute per key`),
      ...(options.effort === undefined ? [] : [`Effort: ${options.effort} (every Claude run)`]),
      ...(keyCount === 0 ? ['No API keys yet. Create one with: plan2api create <name>'] : []),
      'Press Ctrl+C to stop.',
      '',
    ].join('\n'),
  );

  return waitForStop(handle, io);
}

function runStop(args, io, deps) {
  expectArgs(args, 'stop', 0);
  return (deps.stopBackground ?? stopBackground)(io);
}

function runStatus(args, io, deps) {
  expectArgs(args, 'status', 0);
  return (deps.showStatus ?? showStatus)(io);
}

async function runDoctorCommand(args, io, deps) {
  const flags = parseFlags(args, {
    'no-call': { type: 'boolean' },
    port: { type: 'string' },
  });
  const port =
    flags.port === undefined ? DEFAULTS.port : parseInteger('port', flags.port, 1, 65535);
  return (deps.runDoctor ?? runDoctor)({ call: !flags['no-call'], port }, io);
}

const COMMANDS = {
  create: runCreate,
  list: runList,
  delete: runDelete,
  start: runStart,
  stop: runStop,
  status: runStatus,
  doctor: runDoctorCommand,
};

/**
 * Runs the CLI and resolves to the process exit code.
 * 0 = success, 1 = runtime error, 2 = usage error.
 * `deps` lets tests replace the pieces that would start servers or call Claude.
 */
export async function main(
  argv,
  io = { stdout: process.stdout, stderr: process.stderr },
  deps = {},
) {
  const [command, ...args] = argv;

  try {
    if (command === undefined || command === '-h' || command === '--help') {
      io.stdout.write(HELP);
      return 0;
    }
    if (command === '-v' || command === '--version') {
      io.stdout.write(`${readVersion()}\n`);
      return 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) {
      throw new UsageError(`Unknown command: ${command}`);
    }
    return (await COMMANDS[command](args, io, deps)) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`plan2api: ${err.message}\nRun "plan2api --help" for usage.\n`);
      return 2;
    }
    if (err instanceof Plan2ApiError) {
      io.stderr.write(`plan2api: ${err.message}\n`);
      return 1;
    }
    io.stderr.write(`plan2api: unexpected error: ${err.message}\n`);
    return 1;
  }
}
