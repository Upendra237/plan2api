# plan2api

[![CI](https://github.com/Upendra237/plan2api/actions/workflows/ci.yml/badge.svg)](https://github.com/Upendra237/plan2api/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/plan2api.svg)](https://www.npmjs.com/package/plan2api)
[![License: MIT](https://img.shields.io/github/license/Upendra237/plan2api)](https://github.com/Upendra237/plan2api/blob/main/LICENSE)

Turn the Claude plan you already have into a private, Anthropic-compatible text API that works with
the official SDKs.

> **Disclaimer.** plan2api is an **unofficial** project and is **not affiliated with, endorsed by,
> or sponsored by Anthropic**. "Claude" and "Claude Code" are trademarks of Anthropic. plan2api is
> meant for **personal, local use with your own Claude login**, and that use is **subject to
> Anthropic's terms and policies**. You are responsible for making sure your use complies with them.

plan2api runs a small HTTP server on your machine that speaks the shape of Anthropic's Messages API
(`POST /v1/messages`). Each request is answered by your own, already logged-in
[Claude Code](https://code.claude.com/docs/en/overview) in a **text-only mode with every tool
disabled**. Callers authenticate with API keys that you create and can delete at any time.

## Status

First public release (`0.1.0`). Key management, the local server, background mode and the doctor
command work. Streaming, tools and non-text content are not supported; see
[Known limitations](#known-limitations).

## Install

```sh
npm install -g plan2api
```

Or run it without installing:

```sh
npx plan2api --help
```

Requires Node.js 20 or newer, and Claude Code installed and logged in. plan2api has zero runtime
dependencies.

## Quick start

```sh
plan2api doctor            # check Node, Claude Code, your login and the port
plan2api create my-app     # prints your API key once: copy it
plan2api start             # listens on http://127.0.0.1:8787
```

With `npx`, put `npx` in front of each command (`npx plan2api doctor`, `npx plan2api create my-app`,
`npx plan2api start`). For `--background` or starting at boot, install it globally with
`npm install -g plan2api`, so the path the background server runs from stays fixed.

Then, from another terminal (macOS, Linux, or Git Bash on Windows):

```sh
export PLAN2API_KEY=p2a_...        # the key that "plan2api create" printed
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PLAN2API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"sonnet","max_tokens":256,"messages":[{"role":"user","content":"Say hello."}]}'
```

Or in Windows PowerShell:

```powershell
$env:PLAN2API_KEY = "p2a_..."      # the key that "plan2api create" printed
(Invoke-RestMethod http://127.0.0.1:8787/v1/messages -Method Post `
  -Headers @{ 'x-api-key' = $env:PLAN2API_KEY } -ContentType 'application/json' `
  -Body '{"model":"sonnet","max_tokens":256,"messages":[{"role":"user","content":"Say hello."}]}'
).content[0].text
```

Examples for curl, Python (the Anthropic SDK with `base_url="http://127.0.0.1:8787"`), Node.js and
PHP are in [docs/usage.md](docs/usage.md) and [`examples/`](examples).

## Commands

| Command                  | What it does                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `plan2api create <name>` | Generate a new API key (`p2a_...`) and print it **once**                               |
| `plan2api list`          | Show key names and created dates. Never shows the keys                                 |
| `plan2api delete <name>` | Delete a key. It stops working immediately                                             |
| `plan2api start`         | Start the local API server (add `--background` to keep it running without a terminal)  |
| `plan2api stop`          | Stop the server that was started with `--background`                                   |
| `plan2api status`        | Show whether a background server is running. Exit code `0` = running, `1` = not        |
| `plan2api doctor`        | Check that Node, Claude Code, your login, the data directory and the port are all fine |
| `plan2api --help`        | Show usage                                                                             |
| `plan2api --version`     | Show the installed version                                                             |

### `plan2api start` flags

| Flag                  | Default     | Meaning                                                                    |
| --------------------- | ----------- | -------------------------------------------------------------------------- |
| `-b`, `--background`  | off         | Run in the background; output goes to `~/.plan2api/plan2api.log`           |
| `--host <host>`       | `127.0.0.1` | Address to listen on. A non-loopback address prints an HTTPS warning       |
| `--port <port>`       | `8787`      | Port to listen on                                                          |
| `--concurrency <n>`   | `1`         | Claude runs at the same time. More wait in a small queue (then 429)        |
| `--timeout <seconds>` | `120`       | Kill a Claude run that takes longer than this (the request gets 504)       |
| `--rate-limit <n>`    | `30`        | Requests per minute for each key. `0` turns the limit off                  |
| `--effort <level>`    | not set     | Effort level for every Claude run: `low`, `medium`, `high`, `xhigh`, `max` |

`start` first runs the doctor's quick checks and stops with a clear message if Claude Code is
missing.

`--effort` is optional and applies to the whole server (a request cannot change it). Without it,
Claude Code uses its own default. A lower level can use fewer output tokens, but on some models, for
example haiku, it may have little or no effect. It needs a Claude Code that lists `--effort` in
`claude --help`; `start` checks this and tells you to update Claude Code if it is missing. See
[docs/usage.md](docs/usage.md#effort-level---effort).

### Run in the background

```console
$ plan2api start --background
plan2api is running in the background.
  PID:  18552
  URL:  http://127.0.0.1:8787
  Log:  /home/you/.plan2api/plan2api.log
Check on it with: plan2api status    Stop it with: plan2api stop
```

The server keeps running after you close the terminal. `plan2api status` shows its pid, URL and
uptime (and exits `0` only while it runs). `plan2api stop` ends it and any Claude process it started,
and only ever ends a process that proves it is the recorded plan2api server, so a reused pid is never
killed. The server's pid and start time are in `~/.plan2api/server.pid`, and its log
(`~/.plan2api/plan2api.log`) is cut down to its last part whenever it is over 5 MB at start-up.

The user who runs the server must have logged in to Claude Code once. To start plan2api at boot, use
systemd (Ubuntu), Task Scheduler (Windows) or pm2 with the plain foreground `start`; the examples
are in [docs/usage.md](docs/usage.md#run-in-the-background).

### `plan2api doctor`

Prints a `✓` or `✗` for each check, with a fix for every failure, and exits `0` or `1`. Use
`--no-call` to skip the tiny test call that checks you are logged in, and `--port <port>` to check
a different port. It also shows whether a background server is running.

```console
$ plan2api doctor
plan2api doctor

✓ Node.js 24.13.1 (20 or newer is required)
✓ Claude Code 2.1.185
✓ Logged in (text-only test call succeeded in 3.1s)
✓ Data directory /home/you/.plan2api is writable; 1 key
- No background server is running (start one with: plan2api start --background)
✓ Port 8787 is free

All checks passed. Start the server with: plan2api start
```

### Keys

```console
$ plan2api create laptop
Created key "laptop":

  p2a_...

Copy it now. This key cannot be shown again - only its SHA-256 hash is stored,
in /home/you/.plan2api/keys.json

$ plan2api list
NAME    CREATED
laptop  2026-11-02
```

Key names are 1-64 characters: letters, digits, `.`, `_` or `-`, starting with a letter or digit.
Names must be unique.

## Security

- **Call it from your server, never from a browser or app.** Anyone who can read the key can use
  your Claude login. plan2api sends no CORS headers on purpose.
- Keys are stored in `~/.plan2api/keys.json` as a **SHA-256 hash** with the name and created date.
  The key itself is shown once and never written to disk. If you lose it, delete it and create a
  new one. On Linux and macOS the directory is `0700` and the file `0600`; on Windows POSIX modes do
  not apply, so the file relies on your user profile's permissions.
- Claude runs with **all tools disabled** in an empty temporary directory, so it cannot read files
  or run commands. Prompts and keys are never logged.
- The server listens on `127.0.0.1` by default. To use your own domain, put Caddy or a Cloudflare
  Tunnel (HTTPS) in front; see [docs/usage.md](docs/usage.md#use-your-own-domain).

Set `PLAN2API_HOME` to keep plan2api's data somewhere other than `~/.plan2api`, and
`PLAN2API_CLAUDE_PATH` if Claude Code is not on your `PATH`.

## Known limitations

- **Text only.** No streaming (`stream: true` is rejected with `400`), no tools or tool use, and no
  images, documents or other non-text content. Optional fields such as `temperature`, `top_p` and
  `thinking` are accepted but ignored.
- **Every request is independent.** A multi-turn `messages` list is flattened into one prompt; there
  are no sessions.
- **Not fast, not for many users.** Each request starts a Claude Code process, so even a one-word
  answer takes a few seconds. By default one request runs at a time (`--concurrency`); up to 8 more
  wait, then the server answers `429`. Your Claude plan's own limits still apply.
- **Platforms.** Developed and tested by hand on Windows only (Windows 11, Claude Code 2.1.185).
  Linux and macOS are covered by the automated tests that CI runs on Ubuntu, macOS and Windows
  (Node 20, 22 and 24), not by manual testing: background mode, `stop` and the systemd recipe have
  not been tried by hand outside Windows.
- **`plan2api stop` on Windows** ends the background server and everything it started at once, so a
  request that is in flight is cut off.
- **It depends on Claude Code's command line** (`claude -p` and its options), which Anthropic can
  change in a new version. `plan2api doctor` is the first thing to run when something stops working.

## Documentation

[docs/usage.md](docs/usage.md) covers the API, examples in four languages, what is and is not
supported, using your own domain, and security notes.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Upendra237
