# Usage

Turn the Claude plan you already have into a private, Anthropic-compatible text API that works with
the official SDKs.

plan2api does this with a small local server that speaks the shape of Anthropic's Messages API and
answers each request through your own logged-in
[Claude Code](https://code.claude.com/docs/en/overview). Your own scripts and apps can then call
Claude through it, with API keys you create and can revoke at any time.

> **Unofficial.** plan2api is not affiliated with, endorsed by, or sponsored by Anthropic. It is
> meant for **personal use on your own machine with your own Claude login**, and your use is subject
> to [Anthropic's terms and usage policies](https://www.anthropic.com/legal). See
> [Terms and personal use](#terms-and-personal-use).

## Quick start

You need Node.js 20 or newer, and [Claude Code](https://code.claude.com/docs/en/overview)
installed and logged in (run `claude` once and sign in).

```sh
npm install -g plan2api            # or use: npx plan2api <command>

plan2api doctor                    # checks Node, Claude Code, your login, and the port
plan2api create my-app             # prints a key like p2a_... ONCE: copy it now
plan2api start                     # listens on http://127.0.0.1:8787
```

In another terminal:

```sh
export PLAN2API_KEY=p2a_...        # the key you just created
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PLAN2API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"sonnet","max_tokens":256,"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

In Windows PowerShell, use `Invoke-RestMethod` instead of `curl`:

```powershell
$env:PLAN2API_KEY = "p2a_..."      # the key you just created
(Invoke-RestMethod http://127.0.0.1:8787/v1/messages -Method Post `
  -Headers @{ 'x-api-key' = $env:PLAN2API_KEY } -ContentType 'application/json' `
  -Body '{"model":"sonnet","max_tokens":256,"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
).content[0].text
```

## Commands

```text
plan2api create <name>   Generate a new API key and print it once
plan2api list            List key names and creation dates (never the keys)
plan2api delete <name>   Delete a key (takes effect immediately, no restart needed)
plan2api start           Start the local API server (add --background to run it in the background)
plan2api stop            Stop the server that was started with --background
plan2api status          Show whether a background server is running (exit code 0 = running)
plan2api doctor          Check that everything plan2api needs is working
plan2api --help          Show help
plan2api --version       Show the version
```

### `plan2api start`

| Flag                  | Default     | Meaning                                                                    |
| --------------------- | ----------- | -------------------------------------------------------------------------- |
| `-b`, `--background`  | off         | Run in the background; see [Run in the background](#run-in-the-background) |
| `--host <host>`       | `127.0.0.1` | Address to listen on. Anything but loopback prints an HTTPS warning        |
| `--port <port>`       | `8787`      | Port to listen on                                                          |
| `--concurrency <n>`   | `1`         | How many Claude runs may happen at the same time (1-64)                    |
| `--timeout <seconds>` | `120`       | Kill a Claude run that takes longer than this (answers `504`)              |
| `--rate-limit <n>`    | `30`        | Requests per minute for each key (`0` turns the limit off)                 |
| `--effort <level>`    | not set     | Effort level for every Claude run: `low`, `medium`, `high`, `xhigh`, `max` |

Before listening, `start` runs the doctor's quick checks (Node.js version, Claude Code present). If
one fails it tells you so and points to `plan2api doctor`. Press **Ctrl+C** to stop: running Claude
processes are killed and waiting requests get a `503`.

Requests beyond `--concurrency` wait in a queue of up to 8. When the queue is full the server answers
`429`.

### Effort level (`--effort`)

`--effort <level>` hands Claude Code's own `--effort` option to every Claude run. The levels are
`low`, `medium`, `high`, `xhigh` and `max`; any other value is rejected with exit code `2`. As a rule,
a lower level makes Claude think less, which can mean fewer output tokens and quicker answers but
weaker answers to hard questions, and a higher level does the opposite. What a level really does is
decided by Claude Code and the model, not by plan2api.

```sh
plan2api start --effort low
plan2api start --background --effort low    # the background server gets the same level
```

- **Server-wide and opt-in.** The level is chosen once, when the server starts, and applies to every
  request from every key. A request cannot change it: `thinking` and other optional fields in the
  request body are ignored. Without `--effort`, plan2api passes **no** effort argument at all and
  Claude Code uses its own default, exactly as before.
- **It may have little or no effect on some models.** For example, haiku models may answer with about
  the same number of output tokens at every level. Compare `usage.output_tokens` in the replies with
  and without `--effort` for the models you use before relying on it.
- **It needs a Claude Code that knows the option.** At start-up plan2api checks that `claude --help`
  lists `--effort`. If it does not, `start` stops with a message telling you to update Claude Code
  (`claude update`), instead of letting every request fail.
- The level is shown in the start-up banner and in `plan2api status`.

### `plan2api doctor`

Prints a `✓` or `✗` for each check, with a fix for every failure, and exits `0` (all good) or `1`.

| Check          | What it does                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Node.js        | Is it version 20 or newer?                                                                            |
| Claude Code    | Is `claude` installed? Prints its version, or the install command                                     |
| Logged in      | Makes one tiny text-only call. Skip it with `--no-call`                                               |
| Data directory | Can plan2api write to `~/.plan2api`? How many keys exist?                                             |
| Background     | Is a server started with `--background` running? (information only)                                   |
| Port           | Is the default port (or the one given with `--port`) free? A background plan2api server on it is fine |

Exit codes for every command: `0` success, `1` runtime error, `2` usage error.

## The API

### `GET /health`

No key needed. Returns `{"status":"ok","pid":1234}`. The `pid` is the server's own process id;
`plan2api stop` uses it to make sure the process it is about to end really is a plan2api server.

### `POST /v1/messages`

Send your key in the `x-api-key` header or as `Authorization: Bearer <key>`.

```json
{
  "model": "sonnet",
  "max_tokens": 1024,
  "system": "You are a concise assistant.",
  "messages": [{ "role": "user", "content": "What is the capital of France?" }]
}
```

The reply has the same shape as Anthropic's:

```json
{
  "id": "msg_0123456789abcdef01234567",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-6",
  "content": [{ "type": "text", "text": "Paris." }],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 120, "output_tokens": 5 }
}
```

`model` is the **real model ID that answered**, as reported by Claude Code (above, the request sent
the alias `sonnet` and `claude-sonnet-4-6` answered). It is not the alias you sent, so you can
compare the two to notice a request that was served by a different model than the one you asked for.
Only if Claude Code reports no model does plan2api echo the value you sent.

Errors use Anthropic's error shape, with the matching status code:

```json
{ "type": "error", "error": { "type": "invalid_request_error", "message": "..." } }
```

| Status | `error.type`            | When                                                                 |
| ------ | ----------------------- | -------------------------------------------------------------------- |
| 400    | `invalid_request_error` | Bad JSON, `stream: true`, `tools`, non-text blocks, a bad model name |
| 401    | `authentication_error`  | Missing, wrong, or deleted API key                                   |
| 404    | `not_found_error`       | Unknown path, or Claude Code does not know the model                 |
| 405    | `invalid_request_error` | Wrong method: `POST` for `/v1/messages`, `GET` for `/health`         |
| 413    | `request_too_large`     | Request body over 1 MB                                               |
| 429    | `rate_limit_error`      | Over `--rate-limit`, or the queue is full (see `retry-after`)        |
| 500    | `api_error`             | Claude Code failed, is not logged in, or the key file is unreadable  |
| 504    | `timeout_error`         | Claude took longer than `--timeout`                                  |

(`503` is sent only while the server is shutting down.)

## Examples

Working versions of these live in [`examples/`](../examples). They read `PLAN2API_KEY` (and
optionally `PLAN2API_URL`, default `http://127.0.0.1:8787`) from the environment.

### curl

```sh
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: $PLAN2API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "sonnet",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Say hello in one short sentence."}]
  }'
```

### Python (Anthropic SDK)

```python
import os
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:8787",
    api_key=os.environ["PLAN2API_KEY"],
    max_retries=0,  # the SDK retries 5xx errors; for a 504 that would start another Claude run
)

message = client.messages.create(
    model="sonnet",
    max_tokens=1024,
    system="You are a concise assistant.",
    messages=[{"role": "user", "content": "What is the capital of France?"}],
)
print(message.content[0].text)
```

### Node.js

Node 20+ has `fetch` built in, so no dependencies are needed:

```js
const response = await fetch('http://127.0.0.1:8787/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.PLAN2API_KEY },
  body: JSON.stringify({
    model: 'sonnet',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  }),
});
const data = await response.json();
if (!response.ok) throw new Error(`${response.status}: ${data.error.message}`);
console.log(data.content[0].text);
```

The official `@anthropic-ai/sdk` works too: `new Anthropic({ baseURL: 'http://127.0.0.1:8787', apiKey, maxRetries: 0 })`.

### PHP

```php
<?php
$ch = curl_init('http://127.0.0.1:8787/v1/messages');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 150,
    CURLOPT_HTTPHEADER => [
        'content-type: application/json',
        'x-api-key: ' . getenv('PLAN2API_KEY'),
    ],
    CURLOPT_POSTFIELDS => json_encode([
        'model' => 'sonnet',
        'max_tokens' => 1024,
        'messages' => [['role' => 'user', 'content' => 'What is the capital of France?']],
    ]),
]);
$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$data = json_decode($body, true);
if ($status !== 200) {
    fwrite(STDERR, "Error $status: {$data['error']['message']}\n");
    exit(1);
}
echo $data['content'][0]['text'], "\n";
```

## What is supported

**Supported**

- Text prompts: `messages` with string content or arrays of `text` blocks, and multi-turn
  conversations (flattened into one prompt, so each request is independent: there are no sessions).
- `system` as a string or an array of text blocks. When you send none, plan2api uses a short built-in
  prompt that tells Claude it has no tools.
- `model`: passed to Claude Code's `--model`, so aliases such as `sonnet`, `opus` and `haiku` work, as
  do full model names. Only letters, digits, `.`, `_` and `-` are accepted. The reply's `model` is
  the ID of the model that really answered, taken from the assistant message in Claude Code's
  output (not from what the model says about itself). Claude Code sometimes also runs a small helper
  model alongside yours; it is never reported as the answering model.
- `usage`: taken from Claude Code. `input_tokens` includes cached tokens.

**Accepted but ignored:** `max_tokens` (validated, not enforced), `temperature`, `top_p`, `top_k`,
`stop_sequences`, `metadata`, `thinking`, and other optional fields. In particular a request cannot
choose the effort level: it is set for the whole server with
[`--effort`](#effort-level---effort).

**Not supported** (rejected with `400`): `stream: true`, `tools` and `tool_choice`, images, documents,
`tool_use`/`tool_result` and every other non-text content block.

Claude runs in a text-only mode: **all tools are disabled**, it works in an empty temporary
directory that is deleted afterwards, no session is saved, and your hooks, `CLAUDE.md`, plugins and
MCP servers are not loaded. It cannot read files or run commands.

## Run in the background

`plan2api start` runs in your terminal and stops when you close it. To keep the server running
without a terminal, add `--background` (or `-b`):

```console
$ plan2api start --background --port 8787
plan2api is running in the background.
  PID:  18552
  URL:  http://127.0.0.1:8787
  Log:  /home/you/.plan2api/plan2api.log
Check on it with: plan2api status    Stop it with: plan2api stop

$ plan2api status
plan2api is running in the background.
  PID:     18552
  URL:     http://127.0.0.1:8787
  Uptime:  2m 14s
  Started: 2026-11-02T06:02:47.668Z
  Effort:  default (not set)
  Log:     /home/you/.plan2api/plan2api.log

$ plan2api stop
Stopped the background server (pid 18552).
```

`start --background` takes the same flags as `start` and runs the normal server as a detached
child. It checks that the port is free and that no background server is already recorded, waits until
`/health` answers, prints the pid, URL and log path, and exits `0`. If the server does not come up it
prints the last lines of the log and exits `1`. The server keeps running after you close the
terminal: on Linux and macOS it runs in its own session, and on Windows it has no console window.

- **Files** (in `~/.plan2api`, or `PLAN2API_HOME`): `server.pid` holds the pid, host, port and start
  time; `plan2api.log` holds everything the server prints (method, path, status, duration and key name
  for each request, never prompts or keys). When the log is over 5 MB at startup it is cut down to
  its last part.
- **`plan2api status`** prints running or stopped, the pid, URL, uptime, the [effort
  level](#effort-level---effort) and the log path. Its exit code is `0` when a background server is
  running and `1` otherwise, so scripts can test it. `plan2api doctor` shows the same information.
- **`plan2api stop`** only ends a process that proves it is the recorded server: the process must
  answer `/health` on the recorded host and port and report its own pid. A pid that has been reused by
  another program is never touched: `stop` explains why it refused and leaves the pid file for you to
  look at. A stale pid file (the process is gone) is simply removed. Stopping when nothing runs is not
  an error.
- **No leftover `claude` processes.** On Linux and macOS `stop` sends `SIGTERM`, so the server shuts
  down gracefully: waiting requests get `503` and running Claude processes are killed (after 10
  seconds it is killed outright together with its process group). Windows cannot signal a hidden
  background process, so there `stop` ends the server and all of its child processes at once. A
  request that was in flight is cut off, and its small temporary folder (`plan2api-…` in your temp
  directory) may stay behind; it is safe to delete.
- `start --background` refuses to start when the port is busy, or when a background server is
  already running (use `plan2api stop` first). Only one background server per data directory.

### The user must have logged in to Claude Code once

plan2api uses the Claude login of the **operating-system user that runs it**. Whoever runs the
server, whether you in a terminal, a service account, or a scheduled task, must have started
`claude` once as that same user and signed in. API keys are stored per user as well
(`~/.plan2api/keys.json` of that user), so create them as that user too.

### Start it again after a reboot

`--background` does not survive a reboot. To start plan2api at boot or at log-in, let the operating
system keep it running. These tools want a normal foreground process, so give them plain
`plan2api start`, **not** `--background`. Other `start` flags, such as `--effort low`, work the same
way there.

#### Linux (systemd, Ubuntu)

Create a dedicated user without root rights, log it in to Claude Code once, and create a key as it:

```sh
sudo useradd --system --create-home --shell /usr/sbin/nologin plan2api
sudo -u plan2api -H claude              # sign in once, then exit
sudo -u plan2api -H plan2api create my-app
```

Find the two paths the unit needs:

```sh
command -v node                          # for example /usr/bin/node
readlink -f "$(command -v plan2api)"     # for example /usr/lib/node_modules/plan2api/bin/plan2api.js
```

Save this as `/etc/systemd/system/plan2api.service`, using your own paths:

```ini
[Unit]
Description=plan2api (local API for Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=plan2api
Group=plan2api
ExecStart=/usr/bin/node /usr/lib/node_modules/plan2api/bin/plan2api.js start --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=5
# systemd's PATH is short. If `claude` is not in /usr/local/bin or /usr/bin, tell plan2api where it is:
#Environment=PLAN2API_CLAUDE_PATH=/home/plan2api/.local/bin/claude
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Then enable it, check it, and read its logs (systemd collects the server's output in the journal;
there is no `plan2api.log` in this mode):

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now plan2api     # start now and at every boot
sudo systemctl status plan2api
journalctl -u plan2api -f                # follow the log live
journalctl -u plan2api --since "1 hour ago"
sudo systemctl restart plan2api          # after an upgrade or a changed unit
```

`Restart=on-failure` restarts the server after a crash but not after `systemctl stop`.

#### Windows (Task Scheduler)

Run the foreground server from a task that starts when you log in. This runs as you, so your Claude
login and keys apply. In PowerShell:

```powershell
$node   = (Get-Command node).Source
$script = Join-Path (npm root -g) 'plan2api\bin\plan2api.js'
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" start"
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName plan2api -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName plan2api
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` stops Windows from ending the task after its default 72
hours. The task shows a console window; to hide it, open the task in Task Scheduler and choose "Run
whether user is logged on or not". Check or stop it with `Get-ScheduledTask plan2api` and
`Stop-ScheduledTask plan2api`. A task whose program has already exited may have the processes it
started ended with it, which is why the task should run the foreground server instead of
`--background`.

#### pm2

[pm2](https://pm2.keymetrics.io) also works on any system. Point it at the foreground command:

```sh
npm install -g pm2
pm2 start "$(readlink -f "$(command -v plan2api)")" --name plan2api -- start
pm2 save && pm2 startup                  # restart at boot (follow the command it prints)
pm2 logs plan2api
```

On Windows use `(npm root -g)\plan2api\bin\plan2api.js` as the script path.

## Use your own domain

plan2api speaks plain HTTP and, by design, only listens on `127.0.0.1`. To reach it from elsewhere
under your own domain, keep plan2api on loopback and put a reverse proxy or tunnel in front that
provides **HTTPS**. Never expose the plain-HTTP port directly: API keys would travel in clear text.

### Caddy

[Caddy](https://caddyserver.com) gets and renews a certificate for you. Point your domain's DNS at
the machine, then use a `Caddyfile` like this:

```caddyfile
api.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Run `caddy run` (or `caddy start`). Callers then use `https://api.example.com/v1/messages`.

### Cloudflare Tunnel

[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) makes
an outbound connection, so you open no ports. A quick, temporary test URL:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

For a permanent hostname on a domain in your Cloudflare account:

```sh
cloudflared tunnel login
cloudflared tunnel create plan2api
cloudflared tunnel route dns plan2api api.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: plan2api
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: api.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

then run `cloudflared tunnel run plan2api`. Cloudflare gives up on a response that takes more than
about 100 seconds, so with a tunnel keep `--timeout` below that (for example `--timeout 90`).

Once your endpoint is public, anyone who has a key can use your Claude login, so treat keys like
passwords, give each app its own key, and delete the ones you no longer need.

To try plan2api from other machines without a domain of your own, see
[Docker Sandboxes](docker-sandboxes.md): it runs plan2api in a cloud sandbox behind an HTTPS URL that
Docker publishes.

## Security notes

- **Call it from your server, never from a browser or a mobile app.** An API key placed in
  front-end code or an app bundle can be read by anyone. plan2api sends **no CORS headers** on
  purpose, so browsers cannot call it from other sites. Make requests from your backend and keep the
  key in an environment variable or secret store.
- Keys are random, shown **once**, and only their SHA-256 hash is stored in `~/.plan2api/keys.json`
  (directory `0700`, file `0600` on Linux and macOS). Deleting a key stops it working at once.
- Keys are compared in constant time, and the key file is re-read on every request.
- Logs contain the method, path, status, duration and **key name** only: never prompts, answers or
  keys.
- Every endpoint except `/health` needs a key. Requests are limited per key (`--rate-limit`), bodies
  are capped at 1 MB, and concurrent Claude runs are capped (`--concurrency`).
- By default the server only listens on `127.0.0.1`. Binding to `0.0.0.0` or another address prints
  a warning: put HTTPS in front first.

## Terms and personal use

plan2api is an **unofficial** tool. It is not affiliated with Anthropic, and "Claude" and "Claude
Code" are Anthropic's trademarks. It is intended for personal use, on your own machine, with your
own Claude login.

Your Claude plan, its usage limits, and Anthropic's terms and usage policies still apply, including
rules about how an account may be used and by whom. Read them and make sure what you build complies.
Do not share your login, or give access to other people or customers through a plan2api endpoint.

## Troubleshooting

Start with `plan2api doctor`: it checks the usual causes and tells you how to fix each one.

- **`Cannot start: Claude Code was not found`**: install it with
  `npm install -g @anthropic-ai/claude-code`, or set `PLAN2API_CLAUDE_PATH` to the full path of
  `claude` (on Windows, `claude.exe` or the npm `claude.cmd`).
- **`Cannot use --effort: ... does not list --effort`**: your Claude Code is too old to know the
  option. Update it with `claude update` (or `npm install -g @anthropic-ai/claude-code`), or start
  plan2api without `--effort`.
- **`500` mentioning `/login`**: Claude Code is not logged in. Run `claude` in a terminal and sign in.
- **`500` saying "Claude Code could not answer this request"**: the reason is not sent to the caller
  (it can name files on your machine). Read it in the server's output: the terminal where
  `plan2api start` runs, or `~/.plan2api/plan2api.log` for a background server. `plan2api doctor`
  checks the usual causes.
- **`504`**: Claude took longer than `--timeout`. Raise it, or shorten the prompt.
- **`429` with `retry-after`**: you hit `--rate-limit`, or too many requests are queued. Wait, or
  raise `--concurrency` / `--rate-limit` (your Claude plan's own limits still apply).
- **`Port 8787 is already in use`**: pick another one with `--port`.
- **`The background server did not start`**: the message includes the last lines of the log
  (`~/.plan2api/plan2api.log`). The usual causes are the ones `plan2api doctor` checks.
- **`Not stopping process 1234`**: the pid file names a process that does not answer as a plan2api
  server, so the pid probably belongs to another program now. plan2api does not touch it. If it really
  is a stuck plan2api server, end it yourself and delete `server.pid`.
- **A client cannot connect to `http://localhost:8787`**: plan2api listens on IPv4 `127.0.0.1` only,
  and some clients try IPv6 (`::1`) first for `localhost`. Use `http://127.0.0.1:8787`, as the
  examples do.

## Where data lives

| Item           | Location                                               |
| -------------- | ------------------------------------------------------ |
| Data directory | `~/.plan2api/` (override with `PLAN2API_HOME`)         |
| Key store      | `~/.plan2api/keys.json`                                |
| Background pid | `~/.plan2api/server.pid` (pid, host, port, start time) |
| Background log | `~/.plan2api/plan2api.log` (trimmed above 5 MB)        |
| Claude Code    | found on `PATH` (override with `PLAN2API_CLAUDE_PATH`) |
