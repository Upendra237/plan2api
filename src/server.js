import http from 'node:http';
import net from 'node:net';
import { ClaudeError, runClaude as defaultRunClaude } from './claude.js';
import { Plan2ApiError } from './errors.js';
import { KeyError, verifyKey } from './keys.js';
import { AbortedError, Limiter, QueueFullError, RateLimiter, ShutdownError } from './limits.js';
import { ApiError, buildMessageResponse, errorBody, parseMessagesRequest } from './messages.js';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  concurrency: 1,
  timeoutSeconds: 120,
  rateLimit: 30,
});

export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
const MAX_QUEUE = 8;
const QUEUE_RETRY_AFTER_SECONDS = 5;
const FORCE_CLOSE_AFTER_MS = 500;

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** True for hosts that are only reachable from this machine. */
export function isLoopbackHost(host) {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name);
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function requestPath(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/** Makes a path safe to print on one log line. */
function loggable(text) {
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

function extractApiKey(headers) {
  const direct = headers['x-api-key'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '');
  return bearer ? bearer[1] : null;
}

/**
 * Reads the request body, refusing anything over `limit` bytes with a 413.
 * Oversized bodies are drained (and thrown away) so the client can still read the response.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      new ApiError(
        413,
        'request_too_large',
        `The request body is larger than the ${limit / 1024} KB limit.`,
      );
    const declared = Number(req.headers['content-length']);
    let received = 0;
    let settled = false;
    const chunks = [];
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    if (Number.isFinite(declared) && declared > limit) settle(reject, tooLarge());

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_DRAIN_BYTES) {
        req.destroy();
        return;
      }
      if (received > limit) {
        chunks.length = 0;
        settle(reject, tooLarge());
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => settle(reject, err));
    req.on('close', () => settle(reject, new AbortedError()));
  });
}

function parseJson(text) {
  // PowerShell 5.1 writes JSON files with a byte order mark, which RFC 8259 lets parsers ignore.
  const json = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(json);
  } catch {
    throw new ApiError(400, 'invalid_request_error', 'The request body is not valid JSON.');
  }
}

/**
 * Builds the HTTP server without starting it.
 * `runClaude` is injectable so tests never call the real Claude. `effort` (optional, one of
 * EFFORT_LEVELS) is passed to every Claude run.
 */
export function createServer({
  runClaude = defaultRunClaude,
  concurrency = DEFAULTS.concurrency,
  timeoutSeconds = DEFAULTS.timeoutSeconds,
  rateLimit = DEFAULTS.rateLimit,
  effort,
  maxQueue = MAX_QUEUE,
  now = Date.now,
  log = () => {},
  logError = () => {},
} = {}) {
  const limiter = new Limiter({ concurrency, maxQueue });
  const rateLimiter = new RateLimiter({ limit: rateLimit, now });
  const running = new Set();
  const openResponses = new Set();
  let closing = false;
  let closePromise = null;

  function authenticate(req) {
    const key = extractApiKey(req.headers);
    if (key === null) {
      throw new ApiError(
        401,
        'authentication_error',
        'Missing API key. Send it in the x-api-key header or as "Authorization: Bearer <key>".',
      );
    }
    let name;
    try {
      name = verifyKey(key);
    } catch (err) {
      if (!(err instanceof KeyError)) throw err;
      logError(`key store error: ${err.message}`);
      throw new ApiError(
        500,
        'api_error',
        'plan2api could not read its key file. Run "plan2api doctor" on the server.',
      );
    }
    if (name === null) throw new ApiError(401, 'authentication_error', 'Invalid API key.');
    return name;
  }

  /** Turns anything thrown while answering a request into an ApiError (or null to say nothing). */
  function toApiError(err) {
    if (err instanceof ApiError) return err;
    if (err instanceof AbortedError || (err instanceof ClaudeError && err.code === 'aborted')) {
      // Either the client went away (nobody to answer) or we are shutting down.
      return closing ? new ApiError(503, 'api_error', 'plan2api is shutting down.') : null;
    }
    if (err instanceof ShutdownError) {
      return new ApiError(503, 'api_error', 'plan2api is shutting down.');
    }
    if (err instanceof QueueFullError) {
      return new ApiError(
        429,
        'rate_limit_error',
        'Too many requests are waiting for Claude. Try again shortly.',
        { 'retry-after': String(QUEUE_RETRY_AFTER_SECONDS) },
      );
    }
    if (err instanceof ClaudeError) {
      if (err.code === 'timeout') return new ApiError(504, 'timeout_error', err.message);
      if (err.code === 'invalid_model')
        return new ApiError(400, 'invalid_request_error', err.message);
      if (err.upstreamStatus === 404) return new ApiError(404, 'not_found_error', err.message);
      if (err.upstreamStatus === 429) return new ApiError(429, 'rate_limit_error', err.message);
      logError(`claude error (${err.code}): ${err.message}`);
      // Claude's own error text ("Please run /login") helps the caller. Anything else (a failed
      // start, stderr, file paths) describes this machine and is only in the server log.
      return new ApiError(
        500,
        'api_error',
        err.reported
          ? err.message
          : 'Claude Code could not answer this request. The details are in the plan2api server log.',
      );
    }
    logError(`unexpected error: ${err?.message ?? err}`);
    return new ApiError(500, 'api_error', 'Internal server error.');
  }

  async function handleMessages(req, res) {
    const body = parseJson(await readBody(req, MAX_BODY_BYTES));
    const { model, system, prompt } = parseMessagesRequest(body);

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) controller.abort();
    };
    running.add(controller);
    res.once('close', onClose);
    try {
      const result = await limiter.run(
        () =>
          runClaude({
            prompt,
            system,
            model,
            // Server-wide and opt-in: without --effort no effort argument is passed at all.
            ...(effort === undefined ? {} : { effort }),
            timeoutMs: timeoutSeconds * 1000,
            signal: controller.signal,
          }),
        controller.signal,
      );
      // Report the model that really answered; the alias the client sent ("sonnet") is only
      // used when Claude Code did not say which model it was.
      const answeredBy = typeof result.model === 'string' && result.model ? result.model : model;
      sendJson(
        res,
        200,
        buildMessageResponse({ model: answeredBy, text: result.text, usage: result.usage }),
      );
    } finally {
      running.delete(controller);
      res.off('close', onClose);
    }
  }

  async function route(req, res, context) {
    const path = requestPath(req.url);

    if (path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new ApiError(405, 'invalid_request_error', 'Use GET.', { allow: 'GET, HEAD' });
      }
      // The pid lets `plan2api stop` confirm that the process it is about to kill is this server.
      sendJson(res, 200, { status: 'ok', pid: process.pid });
      return;
    }

    context.keyName = authenticate(req);
    const rate = rateLimiter.hit(context.keyName);
    if (!rate.allowed) {
      throw new ApiError(
        429,
        'rate_limit_error',
        `Rate limit exceeded: at most ${rateLimit} requests per minute for this key.`,
        { 'retry-after': String(rate.retryAfterSeconds) },
      );
    }
    if (closing) throw new ApiError(503, 'api_error', 'plan2api is shutting down.');

    if (path === '/v1/messages') {
      if (req.method !== 'POST') {
        throw new ApiError(405, 'invalid_request_error', 'Use POST.', { allow: 'POST' });
      }
      await handleMessages(req, res);
      return;
    }
    throw new ApiError(404, 'not_found_error', 'Not found.');
  }

  const server = http.createServer(
    { requestTimeout: 60_000, headersTimeout: 30_000 },
    async (req, res) => {
      const started = performance.now();
      const context = { keyName: '-' };
      const path = loggable(requestPath(req.url));

      if (closing) res.setHeader('connection', 'close');
      openResponses.add(res);

      // Method, path, status, duration and key name only. Never prompts, responses or keys.
      res.once('close', () => {
        openResponses.delete(res);
        const status = res.writableFinished ? res.statusCode : 'aborted';
        const ms = Math.round(performance.now() - started);
        log(
          `${new Date().toISOString()} ${req.method} ${path} ${status} ${ms}ms key=${context.keyName}`,
        );
      });

      try {
        await route(req, res, context);
      } catch (err) {
        const apiError = toApiError(err);
        if (apiError)
          sendJson(
            res,
            apiError.status,
            errorBody(apiError.type, apiError.message),
            apiError.headers,
          );
        else if (!res.writableEnded) res.destroy();
      }
    },
  );

  /** Stops accepting requests, kills running Claude processes, and closes the server. */
  function shutdown() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = new Promise((resolve) => {
      server.close(() => resolve());
      // Answers still to be written (the 503s) must not leave idle keep-alive connections behind.
      for (const res of openResponses) {
        if (!res.headersSent) res.setHeader('connection', 'close');
      }
      limiter.close();
      for (const controller of running) controller.abort();
      // Give the 503 responses a moment to flush, then drop whatever is left.
      setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS).unref();
    });
    return closePromise;
  }

  const stats = () => ({ running: limiter.active, queued: limiter.queued });
  return { server, shutdown, stats };
}

/**
 * Tries to listen on `host:port` for a moment.
 * Resolves to `{ free: true }`, or `{ free: false, code }` (for example EADDRINUSE).
 */
export function probePort(port, host = DEFAULTS.host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve({ free: false, code: err.code }));
    probe.listen(port, host, () => probe.close(() => resolve({ free: true })));
  });
}

export function describeListenError(err, host, port) {
  switch (err.code) {
    case 'EADDRINUSE':
      return `Port ${port} is already in use on ${host}. Stop the other program, or pick another port with --port.`;
    case 'EACCES':
      return `Not allowed to listen on port ${port}. Try a port above 1024 with --port.`;
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return `Cannot listen on ${host}: that address is not available on this machine.`;
    default:
      return `Could not start the server: ${err.message}`;
  }
}

/**
 * Starts the server. Resolves once it is listening, with the URL and a `shutdown()` function;
 * `closed` resolves when the server has fully stopped.
 */
export async function startServer({ host = DEFAULTS.host, port = DEFAULTS.port, ...options } = {}) {
  const { server, shutdown, stats } = createServer(options);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    throw new Plan2ApiError(describeListenError(err, host, port));
  }

  const actualPort = server.address().port;
  const closed = new Promise((resolve) => server.once('close', resolve));
  const shownHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    server,
    host,
    port: actualPort,
    url: `http://${shownHost}:${actualPort}`,
    shutdown,
    stats,
    closed,
  };
}
