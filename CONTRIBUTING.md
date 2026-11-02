# Contributing to plan2api

Thanks for your interest in improving plan2api! This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to uphold it.

## Reporting bugs and requesting features

- Search [existing issues](https://github.com/Upendra237/plan2api/issues) first.
- Use the bug report or feature request template.
- **Never paste real API keys, tokens or the contents of `~/.plan2api/keys.json` into an issue.**
- For security problems, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 20 or newer. Linting uses ESLint 10, which needs Node.js 20.19+, 22.13+ or 24.

```sh
git clone https://github.com/Upendra237/plan2api.git
cd plan2api
npm install
```

Useful scripts:

| Script           | Purpose                                         |
| ---------------- | ----------------------------------------------- |
| `npm test`       | Run the tests (Node's built-in `node:test`)     |
| `npm run lint`   | Lint with ESLint                                |
| `npm run format` | Format the code with Prettier                   |
| `npm start`      | Run `plan2api start` from the working directory |

To try the CLI from your checkout without touching your real keys, point it at a throwaway
directory:

```sh
PLAN2API_HOME=/tmp/plan2api-dev node bin/plan2api.js create demo
```

(On Windows PowerShell: `$env:PLAN2API_HOME = "$env:TEMP\plan2api-dev"`.)

## Project guidelines

- **Zero runtime dependencies.** Use Node's standard library. ESLint and Prettier are the only
  devDependencies. Please open an issue before proposing anything that changes this.
- **Support Node 20, 22 and 24.** CI runs the tests on all three, on Linux, macOS and Windows.
  Lint and the Prettier check run once, on Node 24.
- **Never store or log secrets.** API keys are only ever stored as SHA-256 hashes and are shown once.
- **Keep `bin/plan2api.js` as a thin entry point.** Logic lives in `src/`.
- **Never call the real Claude in tests.** Inject a fake `runClaude`, or use the stand-in process in
  `fixtures/fake-claude.js`. (Fixtures live outside `test/` because `node --test` runs every file
  inside it.)
- **Keep the `claude` process locked down.** No shell, the prompt only on stdin, every argument a
  constant except a validated `--model` and an `--effort` taken from a fixed list, and all tools
  disabled. See `src/claude.js`.
- Add or update tests in `test/` for any behavior change. Tests must not touch the real
  `~/.plan2api`; use `PLAN2API_HOME` with a temporary directory.
- Run `npm run format`, `npm run lint` and `npm test` before opening a pull request.

## Commits

- One logical change per commit, with a short subject line in the imperative mood ("Fix port
  check", not "Fixed port check"), about 70 characters at most.
- Explain _why_ in the body when it is not obvious. Mention the issue it fixes ("Fixes #123").
- Every commit should leave `npm test` passing. Do not commit secrets, keys or personal data.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make a focused change with tests.
3. Run `npm run format`, `npm run lint` and `npm test`; CI runs the same checks plus
   `npx prettier --check .` and will fail the pull request if any of them fails.
4. Update `README.md`, `docs/` and `CHANGELOG.md` (under **Unreleased**) when behavior changes.
5. Open a pull request against `main` and fill in the template. Describe what changed and why,
   and how you tested it (which operating system and Node.js version).

Small, focused pull requests are easier to review and merge. Expect some back-and-forth: review
comments are about the change, not about you.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
