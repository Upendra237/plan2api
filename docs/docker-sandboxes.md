# Docker Sandboxes

This guide runs plan2api inside a Docker Sandboxes cloud sandbox and publishes it at a public HTTPS
URL, so other machines can call it with an API key.

> **Third-party product.** Docker Sandboxes is made by Docker and is not affiliated with plan2api or
> Anthropic. Its command line (`sbx`) can change, so if a step here no longer matches, follow
> [Docker's documentation](https://docs.docker.com/ai/sandboxes/), which is the source of truth.

## What Docker Sandboxes is

Docker Sandboxes runs disposable microVMs. Each one has its own kernel and its own private Docker
daemon, and you control them with the `sbx` command.

Local sandboxes are free. Cloud sandboxes, which this guide uses, are pay-as-you-go: compute is
metered per second while the sandbox runs, and a paused sandbox costs nothing. Micro is the cheapest
size. [Docker's Sandboxes page](https://www.docker.com/products/docker-sandboxes/) lists the sizes
and what they cost.

A sandbox stops after 1 hour by default and can run for up to 24 hours per session.

## Install `sbx`

Install it on the machine you work from, not inside the sandbox.

**Windows:**

```powershell
winget install Docker.sbx
```

Windows does not refresh `PATH` in a terminal that is already open, so open a fresh terminal after
installing.

On macOS and Linux, follow the steps in
[Install Docker Sandboxes](https://docs.docker.com/ai/sandboxes/install/).

Then log in:

```sh
sbx login
```

## Run plan2api in a cloud sandbox

Create the sandbox in the Docker Agentic Platform web console: choose **New**, pick the `shell`
agent, set compute to **Micro**, then choose **Run**. It opens a terminal in your browser. If you
prefer the `sbx` command line, see Docker's
[Use cloud sandboxes](https://docs.docker.com/ai/sandboxes/cloud/usage/) and
[Shell](https://docs.docker.com/ai/sandboxes/agents/shell/) pages.

The shell image includes Node.js and git but no agent binary, so you install plan2api and Claude
Code yourself. plan2api needs Node.js 20 or newer.

Then, inside the sandbox:

```sh
npm install -g plan2api
npm install -g @anthropic-ai/claude-code
claude                                     # type /login and complete the browser flow
plan2api doctor                            # all checks should pass
plan2api create <key-name>                 # prints a p2a_ key ONCE: copy it now
plan2api start --background --host 0.0.0.0
```

plan2api listens on `127.0.0.1` by default, and that address cannot be reached from outside the
sandbox. `--host 0.0.0.0` makes it listen on every address instead.

With a non-loopback `--host`, plan2api prints a warning that API keys travel in clear text over plain
HTTP. In this setup the URL that Docker publishes (next step) terminates HTTPS in front of plan2api,
so that warning is already addressed.

## Publish the port

From your own machine, not inside the sandbox:

```sh
sbx --cloud ports <sandbox-name> --publish 8787
```

`<sandbox-name>` is the name of your sandbox, and `8787` is plan2api's default port. The command
returns a public HTTPS URL of the form:

```text
https://8787-<sandbox-id>.sbx.sandboxes-cloud.docker.com
```

That URL is public. Read [Security](#security) before you share it.

## Verify it works

From any machine:

```sh
export PLAN2API_URL=https://8787-<sandbox-id>.sbx.sandboxes-cloud.docker.com
export PLAN2API_KEY=<your-key>

curl "$PLAN2API_URL/health"

curl "$PLAN2API_URL/v1/messages" \
  -H "x-api-key: $PLAN2API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"sonnet","max_tokens":256,"messages":[{"role":"user","content":"Say hello in one short sentence."}]}'
```

`/health` needs no key and answers `{"status":"ok","pid":1234}` (the pid will differ). The second
request returns a message in Anthropic's format. A `401` means the key is missing, wrong, or deleted.
See [The API](usage.md#the-api) for the reply and error formats, and [Examples](usage.md#examples)
for calling it from an SDK: use the published URL as the base URL.

## Security

- **The URL is public.** Docker account login does not protect it. Anyone who has the URL can send
  requests to it.
- **The plan2api API key is the only thing in front of it.** Every endpoint except `/health` needs a
  key, and anyone who has a key can use your Claude login.
- Treat each key as a secret. Create one key per client (`plan2api create <key-name>`), and delete it
  when you are done with it (`plan2api delete <key-name>`; it stops working at once).
- plan2api is meant for personal use with your own Claude login. See
  [Terms and personal use](usage.md#terms-and-personal-use).
- This is a testing setup, not a production deployment.

## Clean up

Inside the sandbox, delete the keys you created:

```sh
plan2api delete <key-name>
```

Then, from your own machine:

```sh
sbx --cloud ports <sandbox-name> --unpublish 8787
sbx --cloud stop <sandbox-name>
sbx --cloud ls                             # check nothing is still running and billing
```

Billing stops when the sandbox stops. Unpublishing matters because the URL stays routable otherwise.
