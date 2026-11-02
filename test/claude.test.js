import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildClaudeArgs,
  claudeSupportsEffort,
  ClaudeError,
  DEFAULT_SYSTEM_PROMPT,
  EFFORT_LEVELS,
  findAnsweringModel,
  getClaudeVersion,
  helpListsEffort,
  isEffortLevel,
  isValidModel,
  resolveClaude,
  runClaude,
} from '../src/claude.js';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));
const fakeClaude = () => ({ file: process.execPath, prefixArgs: [FAKE] });

/** Runs the fake `claude` in the given mode and returns the helpers for one test. */
function withMode(mode, extraEnv = {}) {
  const previous = {};
  const env = { FAKE_CLAUDE_MODE: mode, ...extraEnv };
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

let restore = () => {};
afterEach(() => restore());

async function assertClaudeError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof ClaudeError, `expected a ClaudeError, got ${err}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe('buildClaudeArgs', () => {
  it('is entirely fixed: tools off, JSON output, no session, no prompt', () => {
    const args = buildClaudeArgs();
    assert.deepEqual(args, [
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
      '--system-prompt-file',
      '../system-prompt.txt',
    ]);
    assert.equal(args[args.indexOf('--tools') + 1], '', '--tools must be followed by ""');
  });

  it('adds only a validated --model=<value>', () => {
    const args = buildClaudeArgs({ model: 'claude-sonnet-4-6' });
    assert.deepEqual(args.slice(-1), ['--model=claude-sonnet-4-6']);
    assert.equal(args.length, buildClaudeArgs().length + 1);
  });

  it('rejects unsafe model names', () => {
    for (const model of ['a b', 'x;y', '$(id)', 'a|b', 'a&b', 'a%b', '`x`', "a'b", 'a"b']) {
      assert.throws(() => buildClaudeArgs({ model }), ClaudeError, model);
    }
  });
});

describe('effort level argument', () => {
  const effortArgs = (args) => args.filter((arg) => arg.startsWith('--effort'));

  it('offers exactly the levels Claude Code documents', () => {
    assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(Object.isFrozen(EFFORT_LEVELS), true);
    for (const level of EFFORT_LEVELS) assert.equal(isEffortLevel(level), true, level);
  });

  it('passes no effort argument at all unless one is asked for', () => {
    assert.deepEqual(effortArgs(buildClaudeArgs()), []);
    assert.deepEqual(effortArgs(buildClaudeArgs({ model: 'sonnet' })), []);
    assert.deepEqual(buildClaudeArgs({ effort: undefined }), buildClaudeArgs());
  });

  it('adds one --effort=<level> argument for each allowed level, and nothing else', () => {
    for (const level of EFFORT_LEVELS) {
      const args = buildClaudeArgs({ effort: level });
      assert.deepEqual(effortArgs(args), [`--effort=${level}`]);
      assert.equal(args.length, buildClaudeArgs().length + 1, level);
      assert.deepEqual(
        args.filter((arg) => !arg.startsWith('--effort')),
        buildClaudeArgs(),
        'every other argument is unchanged',
      );
    }
  });

  it('works together with a model', () => {
    const args = buildClaudeArgs({ model: 'haiku', effort: 'low' });
    assert.deepEqual(effortArgs(args), ['--effort=low']);
    assert.equal(args.at(-1), '--model=haiku');
  });

  it('rejects anything that is not on the list, exactly as written', () => {
    const bad = [
      '',
      ' ',
      'LOW',
      'Low',
      ' low',
      'low ',
      'extreme',
      'lo',
      'low;id',
      'low\n--tools=Bash',
      '--model=x',
      'low --effort=max',
      'constructor',
      '__proto__',
      'toString',
      '0',
      null,
      5,
      true,
      {},
      ['low'],
    ];
    for (const effort of bad) {
      assert.equal(isEffortLevel(effort), false, String(effort));
      assert.throws(
        () => buildClaudeArgs({ effort }),
        (err) => err instanceof ClaudeError && err.code === 'invalid_request',
        String(effort),
      );
    }
  });
});

describe('isValidModel', () => {
  it('accepts letters, digits, dot, underscore and dash', () => {
    for (const model of ['sonnet', 'claude-sonnet-4-6', 'claude-3.5_x', 'A1']) {
      assert.equal(isValidModel(model), true, model);
    }
  });

  it('rejects everything else', () => {
    const tooLong = 'a'.repeat(129);
    const bad = [
      '',
      ' ',
      'a b',
      'a/b',
      'a\\b',
      'a\nb',
      '--dangerously-skip-permissions',
      '-x',
      tooLong,
    ];
    for (const model of [...bad, undefined, null, 5, {}, []]) {
      assert.equal(isValidModel(model), false, String(model));
    }
  });
});

describe('resolveClaude', () => {
  const NPM_SHIM = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ].join('\r\n');
  const JS_SHIM = [
    '@ECHO off',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*',
  ].join('\r\n');

  /** An in-memory file system, so the Windows logic runs on any OS. */
  function fakeFs(files) {
    return {
      platform: 'win32',
      nodePath: 'C:\\node\\node.exe',
      exists: (file) => Object.hasOwn(files, file),
      readText: (file) => files[file],
    };
  }

  it('on Windows, starts a claude.exe found on PATH directly', () => {
    const files = { 'C:\\tools\\claude.exe': true };
    const env = { Path: 'C:\\other;C:\\tools' };
    assert.deepEqual(resolveClaude({ ...fakeFs(files), env }), {
      file: 'C:\\tools\\claude.exe',
      prefixArgs: [],
    });
  });

  it('on Windows, reads the npm claude.cmd shim to find the real claude.exe (no cmd.exe)', () => {
    const exe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const files = { 'C:\\npm\\claude.cmd': NPM_SHIM, [exe]: true };
    const found = resolveClaude({ ...fakeFs(files), env: { Path: 'C:\\npm' } });
    assert.deepEqual(found, { file: exe, prefixArgs: [] });
  });

  it('on Windows, runs a JavaScript shim target with node instead of the shim', () => {
    const script = 'C:\\npm\\node_modules\\pkg\\cli.js';
    const files = { 'C:\\npm\\claude.cmd': JS_SHIM, [script]: true };
    const found = resolveClaude({ ...fakeFs(files), env: { Path: 'C:\\npm' } });
    assert.deepEqual(found, { file: 'C:\\node\\node.exe', prefixArgs: [script] });
  });

  it('prefers claude.exe over claude.cmd and tolerates quoted PATH entries', () => {
    const files = { 'C:\\a b\\claude.cmd': NPM_SHIM, 'C:\\a b\\claude.exe': true };
    const found = resolveClaude({ ...fakeFs(files), env: { Path: '"C:\\a b";' } });
    assert.equal(found.file, 'C:\\a b\\claude.exe');
  });

  it('refuses a shim it cannot understand instead of running it through a shell', () => {
    const files = { 'C:\\npm\\claude.cmd': '@echo off\r\nsome-other-launcher %*' };
    assert.throws(
      () => resolveClaude({ ...fakeFs(files), env: { Path: 'C:\\npm' } }),
      (err) => err.code === 'not_found' && /PLAN2API_CLAUDE_PATH/.test(err.message),
    );
  });

  it('reports a missing Claude Code with the install command', () => {
    assert.throws(
      () => resolveClaude({ ...fakeFs({}), env: { Path: 'C:\\nothing' } }),
      (err) =>
        err.code === 'not_found' && /npm install -g @anthropic-ai\/claude-code/.test(err.message),
    );
  });

  it('honours PLAN2API_CLAUDE_PATH (exe, shim, and missing)', () => {
    const exe = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const files = { 'D:\\mine\\claude.exe': true, 'C:\\npm\\claude.cmd': NPM_SHIM, [exe]: true };
    const base = fakeFs(files);
    assert.equal(
      resolveClaude({ ...base, env: { PLAN2API_CLAUDE_PATH: 'D:\\mine\\claude.exe' } }).file,
      'D:\\mine\\claude.exe',
    );
    assert.equal(
      resolveClaude({ ...base, env: { PLAN2API_CLAUDE_PATH: 'C:\\npm\\claude.cmd' } }).file,
      exe,
    );
    assert.throws(
      () => resolveClaude({ ...base, env: { PLAN2API_CLAUDE_PATH: 'D:\\nope\\claude.exe' } }),
      ClaudeError,
    );
  });

  it('on other systems, uses the claude command on PATH (or the override)', () => {
    assert.deepEqual(resolveClaude({ platform: 'linux', env: {} }), {
      file: 'claude',
      prefixArgs: [],
    });
    const override = { PLAN2API_CLAUDE_PATH: '/opt/claude' };
    assert.equal(resolveClaude({ platform: 'darwin', env: override }).file, '/opt/claude');
  });
});

describe('runClaude (against a fake claude process)', () => {
  const deps = { resolveClaude: fakeClaude };
  const run = async (options, extraDeps = {}) => {
    const { text, usage } = await runClaude(options, { ...deps, ...extraDeps });
    return { report: JSON.parse(text), usage };
  };

  it('sends the prompt on stdin, never on the command line', async () => {
    restore = withMode('echo');
    const nasty = `"; rm -rf / & echo pwned | $(id) \`id\` %PATH% 'x' \\ \n--dangerously-skip-permissions\n`;
    const { report } = await run({ prompt: nasty });
    assert.equal(report.stdin, nasty);
    assert.deepEqual(report.args, buildClaudeArgs());
    assert.ok(!report.args.some((arg) => arg.includes('pwned')));
  });

  it('delivers a large prompt intact', async () => {
    restore = withMode('echo');
    const big = 'x'.repeat(300_000);
    const { report } = await run({ prompt: big });
    assert.equal(report.stdin.length, big.length);
  });

  it('never uses a shell', async () => {
    restore = withMode('echo');
    const seen = [];
    const spy = (file, args, options) => {
      seen.push(options);
      return spawn(file, args, options);
    };
    await run({ prompt: 'hi' }, { spawn: spy });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].shell, false);
    assert.equal(seen[0].windowsHide, true);
  });

  it('runs in an empty temporary directory that is deleted afterwards', async () => {
    restore = withMode('echo');
    const { report } = await run({ prompt: 'hi' });
    assert.match(report.cwd, /plan2api-/);
    assert.deepEqual(report.entries, []);
    assert.equal(existsSync(report.cwd), false);
  });

  it('uses a text-only default system prompt, or the one given', async () => {
    restore = withMode('echo');
    assert.equal((await run({ prompt: 'hi' })).report.system, DEFAULT_SYSTEM_PROMPT);
    assert.equal((await run({ prompt: 'hi', system: '  ' })).report.system, DEFAULT_SYSTEM_PROMPT);
    const custom = 'You are a pirate.\nUse "quotes" and $(subshell) freely.';
    assert.equal((await run({ prompt: 'hi', system: custom })).report.system, custom);
  });

  it('passes a valid model as --model=<value> and rejects a bad one before starting anything', async () => {
    restore = withMode('echo');
    const { report } = await run({ prompt: 'hi', model: 'claude-sonnet-4-6' });
    assert.equal(report.args.at(-1), '--model=claude-sonnet-4-6');

    let started = 0;
    const spy = (...args) => {
      started += 1;
      return spawn(...args);
    };
    await assertClaudeError(
      runClaude({ prompt: 'hi', model: 'x; rm -rf /' }, { ...deps, spawn: spy }),
      'invalid_model',
    );
    assert.equal(started, 0);
  });

  it('passes the effort level to the claude process, and no effort argument when none is set', async () => {
    restore = withMode('echo');
    const none = (await run({ prompt: 'hi' })).report;
    assert.deepEqual(
      none.args.filter((arg) => arg.startsWith('--effort')),
      [],
    );

    for (const effort of EFFORT_LEVELS) {
      const { report } = await run({ prompt: 'hi', model: 'haiku', effort });
      assert.deepEqual(report.args, buildClaudeArgs({ model: 'haiku', effort }));
      assert.equal(report.args.filter((arg) => arg === `--effort=${effort}`).length, 1);
      assert.equal(report.stdin, 'hi', 'the prompt is still only on stdin');
    }
  });

  it('rejects a bad effort level before starting anything', async () => {
    let started = 0;
    const spy = (...args) => {
      started += 1;
      return spawn(...args);
    };
    await assertClaudeError(
      runClaude({ prompt: 'hi', effort: 'low; rm -rf /' }, { ...deps, spawn: spy }),
      'invalid_request',
    );
    assert.equal(started, 0);
  });

  it('maps usage, counting cached tokens as input', async () => {
    restore = withMode('echo');
    const { usage } = await run({ prompt: 'hi' });
    assert.deepEqual(usage, { input_tokens: 17, output_tokens: 3 });
  });

  it('accepts the older array-of-events output', async () => {
    restore = withMode('events');
    const { text } = await runClaude({ prompt: 'hi' }, deps);
    assert.equal(text, 'from events');
  });

  it('rejects an empty prompt', async () => {
    await assertClaudeError(runClaude({ prompt: '' }, deps), 'invalid_request');
  });

  it('kills the process and reports a timeout', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'plan2api-pid-'));
    const pidFile = join(sandbox, 'pid');
    restore = withMode('sleep', { FAKE_PID_FILE: pidFile });
    const started = Date.now();
    await assertClaudeError(runClaude({ prompt: 'hi', timeoutMs: 400 }, deps), 'timeout');
    assert.ok(Date.now() - started < 5000, 'should give up promptly');

    const pid = Number(readFileSync(pidFile, 'utf8'));
    rmSync(sandbox, { recursive: true, force: true });
    let alive = true;
    for (let i = 0; i < 40 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the child process must be dead after a timeout');
  });

  it('stops the process when the caller aborts', async () => {
    restore = withMode('sleep');
    const controller = new AbortController();
    const pending = runClaude({ prompt: 'hi', signal: controller.signal, timeoutMs: 60_000 }, deps);
    setTimeout(() => controller.abort(), 200);
    await assertClaudeError(pending, 'aborted');

    controller.abort();
    await assertClaudeError(
      runClaude({ prompt: 'hi', signal: controller.signal }, deps),
      'aborted',
    );
  });

  it('reports an error from Claude Code with its status', async () => {
    restore = withMode('api-error');
    await assert.rejects(runClaude({ prompt: 'hi' }, deps), (err) => {
      assert.equal(err.code, 'failed');
      assert.equal(err.upstreamStatus, 404);
      assert.match(err.message, /model not found/);
      assert.equal(err.reported, true, "it is Claude's own answer, so it may be shown to a caller");
      return true;
    });
  });

  it('reports a crash and unreadable output', async () => {
    restore = withMode('crash');
    await assert.rejects(runClaude({ prompt: 'hi' }, deps), (err) => {
      assert.match(err.message, /exited with code 3: boom/);
      assert.equal(err.reported, false, 'stderr describes this machine, so it stays in the log');
      return true;
    });
    restore();
    restore = withMode('garbage');
    await assertClaudeError(runClaude({ prompt: 'hi' }, deps), 'failed');
  });

  it('reports a missing executable as not_found', async () => {
    const missing = () => ({ file: 'plan2api-no-such-program', prefixArgs: [] });
    await assertClaudeError(runClaude({ prompt: 'hi' }, { resolveClaude: missing }), 'not_found');
  });
});

describe('the model that answered (against a fake claude process)', () => {
  const deps = { resolveClaude: fakeClaude };
  const modelFor = async (mode, options = {}) => {
    restore();
    restore = withMode(mode);
    return (await runClaude({ prompt: 'hi', ...options }, deps)).model;
  };

  it('normal case: reports the model Claude Code says answered', async () => {
    assert.equal(await modelFor('echo'), 'claude-fake-1');
  });

  it('does not report the alias that was requested', async () => {
    assert.equal(await modelFor('echo', { model: 'sonnet' }), 'claude-fake-1');
  });

  it('several models in modelUsage: a helper with MORE output tokens does not win', async () => {
    // modelUsage lists the helper first and gives it 12 output tokens against 4 for the answerer.
    assert.equal(await modelFor('multi-model'), 'claude-fake-1');
  });

  it('reports the model that wrote the answer even when init named a different one', async () => {
    assert.equal(await modelFor('switched', { model: 'opus' }), 'claude-fallback-1');
  });

  it('several models answered: the one with the most output tokens wins', async () => {
    assert.equal(await modelFor('two-authors'), 'claude-fallback-1');
  });

  it('with only modelUsage (plain json format), uses the model with the most output tokens', async () => {
    assert.equal(await modelFor('usage-only'), 'claude-fake-1');
  });

  it('uses the init message when there is no assistant message or modelUsage', async () => {
    assert.equal(await modelFor('init-only'), 'claude-fake-1');
  });

  it('also reads the older array-of-events output', async () => {
    assert.equal(await modelFor('events'), 'claude-fake-1');
  });

  it('fallback: reports undefined when Claude Code names no model', async () => {
    assert.equal(await modelFor('no-model-info'), undefined);
  });
});

describe('findAnsweringModel', () => {
  const assistant = (model) => ({ type: 'assistant', message: { model } });
  const init = (model) => ({ type: 'system', subtype: 'init', model });
  const usage = (outputTokens) => ({ inputTokens: 1, outputTokens });

  it('prefers the model that wrote the answer over a helper with more output tokens', () => {
    const modelUsage = { 'claude-haiku-4-5': usage(12), 'claude-opus-4-8': usage(4) };
    // No init message here, so only the assistant message can say who answered.
    assert.equal(findAnsweringModel([assistant('claude-opus-4-8')], modelUsage), 'claude-opus-4-8');
  });

  it('prefers the model that wrote the answer over the one named in the init message', () => {
    const events = [init('claude-opus-4-8'), assistant('claude-sonnet-4-6')];
    assert.equal(findAnsweringModel(events, {}), 'claude-sonnet-4-6');
  });

  it('picks, among models that wrote answers, the one with the most output tokens', () => {
    const events = [assistant('a-model'), assistant('b-model'), assistant('a-model')];
    assert.equal(
      findAnsweringModel(events, { 'a-model': usage(5), 'b-model': usage(9), helper: usage(99) }),
      'b-model',
    );
  });

  it('takes the first author on a tie, or when modelUsage says nothing', () => {
    const events = [assistant('first'), assistant('second')];
    assert.equal(findAnsweringModel(events, { first: usage(7), second: usage(7) }), 'first');
    assert.equal(findAnsweringModel(events, undefined), 'first');
  });

  it('ignores the <synthetic> placeholder and unusable values', () => {
    const modelUsage = { 'real-model': usage(3) };
    const noise = [
      '<synthetic>',
      '',
      '   ',
      'has space',
      'tab\there',
      'x'.repeat(201),
      5,
      null,
      {},
      undefined,
    ];
    for (const value of noise) {
      assert.equal(findAnsweringModel([assistant(value)], modelUsage), 'real-model', String(value));
    }
    assert.equal(
      findAnsweringModel([{ type: 'assistant' }, { type: 'assistant', message: null }], modelUsage),
      'real-model',
    );
  });

  it('falls back to the init message, then to modelUsage, then to nothing', () => {
    const modelUsage = { helper: usage(12), main: usage(4) };
    assert.equal(findAnsweringModel([init('from-init')], modelUsage), 'from-init');
    assert.equal(findAnsweringModel([], modelUsage), 'helper');
    assert.equal(findAnsweringModel([init('')], modelUsage), 'helper');
    assert.equal(findAnsweringModel([], {}), undefined);
    assert.equal(findAnsweringModel([], undefined), undefined);
  });

  it('copes with a malformed modelUsage', () => {
    for (const modelUsage of [
      'abc',
      7,
      null,
      [],
      ['x'],
      { a: null },
      { a: { outputTokens: 'many' } },
    ]) {
      const found = findAnsweringModel([], modelUsage);
      assert.ok(found === undefined || found === 'a', JSON.stringify(modelUsage));
    }
    assert.equal(findAnsweringModel([], 'abc'), undefined, 'a string is not a model list');
    assert.equal(findAnsweringModel([], ['x']), undefined, 'an array is not a model list');
  });

  it('keeps IDs that carry a context-size suffix', () => {
    assert.equal(
      findAnsweringModel([assistant('claude-sonnet-4-6[1m]')], {}),
      'claude-sonnet-4-6[1m]',
    );
  });
});

describe('getClaudeVersion', () => {
  it('returns the version number', async () => {
    restore = withMode('echo');
    assert.equal(await getClaudeVersion({ resolveClaude: fakeClaude }), '9.9.9');
  });

  it('fails when the output is not a version', async () => {
    restore = withMode('bad-version');
    await assertClaudeError(getClaudeVersion({ resolveClaude: fakeClaude }), 'failed');
  });

  it('reports a missing executable as not_found', async () => {
    const missing = () => ({ file: 'plan2api-no-such-program', prefixArgs: [] });
    await assertClaudeError(getClaudeVersion({ resolveClaude: missing }), 'not_found');
  });
});

describe('helpListsEffort', () => {
  it('finds --effort listed as an option', () => {
    for (const help of [
      '  --effort <level>                      Effort level for the current session',
      'Options:\n  -e, --effort <level>  Effort\n  --model <m>  Model',
      '--effort=<level>',
      '\t--effort [level]',
    ]) {
      assert.equal(helpListsEffort(help), true, help);
    }
  });

  it('does not count text that only mentions it, or a different option', () => {
    for (const help of [
      '',
      undefined,
      null,
      'Usage: claude [options] (try --effort low)',
      '  --effortless    Something else',
      '  --effort-level  Something else',
      '  --verbose       Print more (see --effort in newer versions)',
      '  --max-effort-tokens <n>  Something else',
    ]) {
      assert.equal(helpListsEffort(help), false, String(help));
    }
  });
});

describe('claudeSupportsEffort (against a fake claude process)', () => {
  const deps = { resolveClaude: fakeClaude };

  it('is true when "claude --help" lists --effort', async () => {
    restore = withMode('echo');
    assert.equal(await claudeSupportsEffort(deps), true);
  });

  it('is false for an old Claude Code that does not list it, even if its help mentions the word', async () => {
    restore = withMode('no-effort-help');
    assert.equal(await claudeSupportsEffort(deps), false);
  });

  it('asks with --help, without a shell', async () => {
    restore = withMode('echo');
    const seen = [];
    const spy = (file, args, options) => {
      seen.push({ args, options });
      return spawn(file, args, options);
    };
    await claudeSupportsEffort({ ...deps, spawn: spy });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, [FAKE, '--help']);
    assert.equal(seen[0].options.shell, false);
  });

  it('fails (rather than guessing) when the help cannot be read', async () => {
    restore = withMode('crash');
    await assertClaudeError(claudeSupportsEffort(deps), 'failed');
  });

  it('reports a missing executable as not_found', async () => {
    const missing = () => ({ file: 'plan2api-no-such-program', prefixArgs: [] });
    await assertClaudeError(claudeSupportsEffort({ resolveClaude: missing }), 'not_found');
  });
});
