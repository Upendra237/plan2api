# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `docs/docker-sandboxes.md`: a guide to running plan2api in a Docker Sandboxes cloud sandbox and
  reaching it over HTTPS from other machines, with its security and clean-up steps.

## [0.1.0] - 2026-11-02

First public release.

### Added

- `plan2api create <name>` generates a random `p2a_` API key, stores only its SHA-256 hash with the
  name and created date in `~/.plan2api/keys.json`, and prints the key once.
- `plan2api list` shows key names and created dates, never the keys.
- `plan2api delete <name>` removes a key.
- `plan2api --help` and `plan2api --version`.
- Duplicate and invalid key names are rejected with clear error messages.
- Restricted file permissions (`0700` directory, `0600` file) on Linux and macOS.
- `PLAN2API_HOME` environment variable to override the data directory.
- Requires Node.js 20 or newer (`"engines": {"node": ">=20"}`), with zero runtime dependencies.
- Tests, ESLint and Prettier configuration, and CI on Node 20, 22 and 24 for Linux, macOS and
  Windows. Lint and the Prettier check run once, on Node 24.
- `plan2api start [--host] [--port] [--concurrency] [--timeout] [--rate-limit]` runs a local HTTP
  server. `GET /health` needs no key; `POST /v1/messages` accepts Anthropic Messages API requests
  (text only, string or text-block `system` and `content`, multi-turn conversations flattened into
  one prompt) and replies in Anthropic's message format, with `usage` taken from Claude Code.
- Anthropic-style errors (`{"type":"error","error":{"type","message"}}`) with the proper status
  codes: 400 (bad JSON, `stream: true`, `tools`, non-text content, bad model name), 401, 404, 405,
  413 (body over 1 MB), 429, 500, 504 (and 503 while shutting down). A `500` never contains stack
  traces or file paths: it carries Claude's own error text (for example "Please run /login") or a
  generic message, and the details go to the server log.
- API key authentication on every request except `/health`, via `x-api-key` or
  `Authorization: Bearer`. Keys are hashed with SHA-256 and compared in constant time, and the key
  file is re-read on every request, so `create` and `delete` apply without a restart.
- Limits: `--concurrency` Claude runs at once with a small queue (429 when full), and an in-memory
  per-key `--rate-limit` (requests per minute, with `Retry-After`).
- Graceful shutdown on Ctrl+C/SIGTERM that kills running Claude processes. A warning to put HTTPS in
  front is printed when `--host` is not a loopback address.
- No CORS headers, and logs contain only method, path, status, duration and key name: never prompts
  or keys.
- Request bodies may start with a UTF-8 byte order mark (as written by Windows PowerShell 5.1).
- `plan2api doctor [--no-call] [--port]` checks Node.js, Claude Code (version, or the install
  command), login (a tiny text-only test call), the data directory and key count, and the port,
  printing ✓/✗ with a fix for each failure and exiting 0 or 1. `plan2api start` runs the quick
  checks first.
- Claude runner (`src/claude.js`): runs `claude -p` with no shell, the prompt on stdin, only
  constant arguments (plus a validated `--model`), all tools disabled, JSON output, no session
  persistence, and an empty temporary working directory, with a timeout that kills the process. On
  Windows the npm `claude.cmd` shim is read to find the real `claude.exe` instead of using a shell.
  `PLAN2API_CLAUDE_PATH` overrides where Claude Code is found.
- A short built-in system prompt is used when a request has none, so Claude says it has no tools
  instead of inventing tool output.
- `plan2api start --background` (`-b`) runs the normal server as a detached child, with output in
  `~/.plan2api/plan2api.log` and a `~/.plan2api/server.pid` file (pid, host, port, start time). It
  checks that the port is free and that no background server is already recorded, waits until
  `/health` answers, prints the pid, URL and log path, and exits 0; if the child fails to start it
  prints the last log lines and exits 1. The child has no console window on Windows and its own
  session on Linux/macOS, so it survives closing the terminal. The log is cut down to its last part
  when it is over 5 MB at startup.
- `plan2api stop` ends the background server and its `claude` children, and removes the pid file.
  It only acts on a process that answers `/health` on the recorded host and port and reports its own
  pid, so a reused pid is never killed; a stale pid file is cleaned up. Linux/macOS: `SIGTERM`
  (graceful), then a kill of the process group after 10 s. Windows: the whole process tree is ended.
- `plan2api status` prints running or stopped, the pid, URL, uptime and log path, and exits 0 only
  while a background server is running.
- `plan2api doctor` shows whether a background server is running, and does not report a background
  plan2api server on the checked port as a port conflict.
- `plan2api start --effort <low|medium|high|xhigh|max>` sets an optional, server-wide effort level.
  It is passed to every `claude -p` run as a constant `--effort=<level>` argument taken from that
  fixed list (anything else is rejected with exit code 2), also works with `--background` (the
  detached server gets the same flag), and is shown in the start-up banner and in `plan2api status`.
  Without the flag nothing changes: no effort argument is passed. At start-up plan2api checks that
  the output of `claude --help` lists `--effort`, and otherwise stops with a message to update
  Claude Code. A request cannot change the level, and on some models (for example haiku) the level
  may have little or no effect.
- Documentation for running in the background, with a systemd unit for Ubuntu, a Windows Task
  Scheduler recipe and a note on pm2.
- Documentation (quick start, API, supported and unsupported features, using your own domain with
  Caddy or Cloudflare Tunnel, security notes) and working examples for curl, Python, Node.js and
  PHP.
- `GET /health` answers `{"status":"ok","pid":1234}`; the process id lets `plan2api stop` confirm
  that a process is a plan2api server before ending it.
- The `model` in `POST /v1/messages` responses is the real model ID that answered (for example
  `claude-sonnet-4-6` when the request sent `sonnet`), not the alias the client sent. It is read from
  the assistant message in Claude Code's output (the init message and `modelUsage` are fallbacks;
  with several answering models, the one with the most output tokens wins). A small helper model
  that Claude Code runs alongside yours is never reported, even when it produced more output tokens
  than the model that answered. The requested value is used only if Claude Code reports no model.

### Fixed

- On Linux and macOS, `plan2api doctor` stopped with an error when the data directory path went
  through a regular file (the system reports `ENOTDIR` there, Windows reports `ENOENT`). `ENOTDIR`
  is now treated like a missing file everywhere (pid file, key file, log file, `claude` lookup), and
  the doctor reports the problem as a failed check. A pid file that cannot be read (for example
  because of its permissions) is now a failed check too, and the rest of the report is still printed.

[Unreleased]: https://github.com/Upendra237/plan2api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Upendra237/plan2api/releases/tag/v0.1.0
