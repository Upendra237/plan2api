# Security Policy

## Supported versions

plan2api is in early development. Only the latest released version receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull requests or discussions.**

Use GitHub's private vulnerability reporting instead:

1. Go to the [Security tab](https://github.com/Upendra237/plan2api/security) of this repository.
2. Click **Report a vulnerability**, or open
   [a new advisory](https://github.com/Upendra237/plan2api/security/advisories/new) directly.
3. Describe the issue, how to reproduce it, and its impact. Include the plan2api version, your
   Node.js version and your operating system.

Please do not include real API keys or the contents of your `~/.plan2api/keys.json` in a report.

You will get a response through the advisory thread. Please give the maintainer reasonable time to
investigate and release a fix before disclosing the issue publicly. Reporters are credited in the
advisory and changelog unless they prefer to stay anonymous.

## Scope

Things worth reporting include:

- A way to recover or guess an API key from the stored data
- Keys or secrets written to disk, logs or output when they should not be
- Insecure file permissions on the plan2api data directory
- Bypassing API key authentication, or a way to make Claude run tools or touch your files through
  the API
- A way to inject arguments or commands into the `claude` process through request fields
- Path traversal or injection through key names or other input

plan2api is unofficial and is not affiliated with Anthropic. Issues in Claude Code or in Anthropic's
services should be reported to Anthropic.
