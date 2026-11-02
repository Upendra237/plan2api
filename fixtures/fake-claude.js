// Stand-in for the `claude` command, used by the tests. It never talks to Anthropic.
// Behaviour is chosen with FAKE_CLAUDE_MODE; FAKE_PID_FILE (optional) receives its pid.
//
// It prints Claude Code's stream-json format: one JSON event per line (an init message, the
// assistant message(s) that name the model which answered, and a final result with `modelUsage`).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'echo';
const args = process.argv.slice(2);

// Model IDs the fake reports. Real ones look like "claude-sonnet-4-6".
const MAIN = 'claude-fake-1';
const HELPER = 'claude-helper-1';
const FALLBACK = 'claude-fallback-1';

if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

if (args.includes('--version')) {
  console.log(mode === 'bad-version' ? 'not a version' : '9.9.9 (Claude Code)');
  process.exit(0);
}

if (args.includes('--help')) {
  if (mode === 'crash') {
    console.error('boom: something broke');
    process.exit(3);
  }
  // 'no-effort-help' stands for an old Claude Code that does not know --effort. The decoys are
  // text that mentions --effort without listing it as an option.
  const effortLines =
    mode === 'no-effort-help'
      ? [
          '  --effortless                          Not the option you are looking for',
          '  --verbose                             Print more (see --effort in newer versions)',
        ]
      : ['  --effort <level>                      Effort level (low, medium, high, xhigh, max)'];
  console.log(
    [
      'Usage: claude [options] [command] [prompt]',
      '',
      'Options:',
      '  -p, --print                           Print the answer and exit',
      '  --model <model>                       Model for the current session',
      ...effortLines,
      '  -h, --help                            Display help for command',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const emit = (...events) => {
  for (const event of events) console.log(JSON.stringify(event));
};
const init = (model) => ({ type: 'system', subtype: 'init', model });
const assistant = (model) => ({
  type: 'assistant',
  message: { model, role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
});
const usage = (inputTokens, outputTokens) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});
const result = (text, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 5,
    output_tokens: 3,
  },
  ...extra,
});

function respond(stdin) {
  switch (mode) {
    case 'echo': {
      // Normal case: one model, which is the one that answered.
      let system = null;
      try {
        system = readFileSync('../system-prompt.txt', 'utf8');
      } catch {
        // No system prompt file next to the working directory.
      }
      const report = { stdin, args, cwd: process.cwd(), entries: readdirSync('.'), system };
      emit(
        init(MAIN),
        assistant(MAIN),
        result(JSON.stringify(report), { modelUsage: { [MAIN]: usage(10, 3) } }),
      );
      break;
    }
    case 'multi-model':
      // A helper model is listed first AND has more output tokens than the model that answered.
      // There is no init message here, so only the assistant message says who answered.
      emit(
        assistant(MAIN),
        result('hi', { modelUsage: { [HELPER]: usage(500, 12), [MAIN]: usage(140, 4) } }),
      );
      break;
    case 'switched':
      // The init message names the model that was configured, but another one wrote the answer.
      emit(
        init(MAIN),
        assistant(FALLBACK),
        result('hi', { modelUsage: { [HELPER]: usage(500, 12), [FALLBACK]: usage(100, 4) } }),
      );
      break;
    case 'two-authors':
      // Two models wrote assistant messages (for example after a fallback): most output wins.
      emit(
        init(MAIN),
        assistant(MAIN),
        assistant(FALLBACK),
        result('hi', {
          modelUsage: {
            [MAIN]: usage(100, 5),
            [FALLBACK]: usage(100, 30),
            [HELPER]: usage(500, 12),
          },
        }),
      );
      break;
    case 'usage-only':
      // The plain `json` format: one result object, with no init or assistant events.
      emit(result('hi', { modelUsage: { [HELPER]: usage(500, 3), [MAIN]: usage(140, 20) } }));
      break;
    case 'init-only':
      emit(init(MAIN), result('hi'));
      break;
    case 'no-model-info':
      emit(result('hi'));
      break;
    case 'events':
      // Older versions print one array of events.
      console.log(
        JSON.stringify([
          { type: 'system' },
          result('from events', { modelUsage: { [MAIN]: usage(1, 2) } }),
        ]),
      );
      break;
    case 'api-error':
      emit(result('model not found', { is_error: true, api_error_status: 404 }));
      process.exit(1);
      break;
    case 'crash':
      console.error('boom: something broke');
      process.exit(3);
      break;
    case 'garbage':
      console.log('this is not json');
      break;
    default:
      console.error(`unknown FAKE_CLAUDE_MODE ${mode}`);
      process.exit(4);
  }
}

if (mode === 'sleep') {
  // Never answers: used to test the timeout and cancellation (the process must be killed).
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (stdin += chunk));
  process.stdin.on('end', () => respond(stdin));
}
