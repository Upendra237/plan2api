import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AbortedError,
  Limiter,
  QueueFullError,
  RateLimiter,
  ShutdownError,
} from '../src/limits.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Limiter', () => {
  it('runs tasks immediately while there is room', async () => {
    const limiter = new Limiter({ concurrency: 2, maxQueue: 0 });
    assert.equal(await limiter.run(async () => 'a'), 'a');
  });

  it('never runs more than `concurrency` tasks at once and keeps order', async () => {
    const limiter = new Limiter({ concurrency: 2, maxQueue: 10 });
    const order = [];
    let active = 0;
    let maxActive = 0;
    const gates = [];
    const task = (name) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${name}`);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      active -= 1;
      return name;
    };

    const results = ['a', 'b', 'c', 'd'].map((name) => limiter.run(task(name)));
    await tick();
    assert.deepEqual(order, ['start a', 'start b']);
    assert.deepEqual([limiter.active, limiter.queued], [2, 2]);

    gates[0].resolve();
    await tick();
    assert.deepEqual(order, ['start a', 'start b', 'start c']);
    gates[1].resolve();
    gates[2].resolve();
    await tick();
    gates[3].resolve();
    assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd']);
    assert.equal(maxActive, 2);
    assert.deepEqual([limiter.active, limiter.queued], [0, 0]);
  });

  it('rejects with QueueFullError when the queue is full', async () => {
    const limiter = new Limiter({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const queued = limiter.run(async () => 'queued');
    await assert.rejects(
      limiter.run(async () => 'overflow'),
      QueueFullError,
    );
    gate.resolve('first');
    assert.equal(await running, 'first');
    assert.equal(await queued, 'queued');
  });

  it('keeps going after a task fails', async () => {
    const limiter = new Limiter({ concurrency: 1, maxQueue: 2 });
    const failing = limiter.run(async () => {
      throw new Error('boom');
    });
    const next = limiter.run(async () => 'fine');
    await assert.rejects(failing, /boom/);
    assert.equal(await next, 'fine');
    assert.equal(limiter.active, 0);
  });

  it('drops a queued task whose signal aborts, without running it', async () => {
    const limiter = new Limiter({ concurrency: 1, maxQueue: 2 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const controller = new AbortController();
    let ran = false;
    const waiting = limiter.run(async () => {
      ran = true;
    }, controller.signal);
    assert.equal(limiter.queued, 1);

    controller.abort();
    await assert.rejects(waiting, AbortedError);
    assert.equal(limiter.queued, 0);
    gate.resolve();
    await running;
    await tick();
    assert.equal(ran, false);
  });

  it('refuses a task whose signal is already aborted', async () => {
    const limiter = new Limiter({ concurrency: 1, maxQueue: 1 });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      limiter.run(async () => 1, controller.signal),
      AbortedError,
    );
  });

  it('close() rejects waiting tasks and refuses new ones, but lets running ones finish', async () => {
    const limiter = new Limiter({ concurrency: 1, maxQueue: 2 });
    const gate = deferred();
    const running = limiter.run(() => gate.promise);
    const waiting = limiter.run(async () => 'never');
    limiter.close();
    await assert.rejects(waiting, ShutdownError);
    await assert.rejects(
      limiter.run(async () => 'late'),
      ShutdownError,
    );
    gate.resolve('done');
    assert.equal(await running, 'done');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then reports when to retry', () => {
    let now = 1_000;
    const limiter = new RateLimiter({ limit: 3, now: () => now });
    for (let i = 0; i < 3; i += 1) assert.deepEqual(limiter.hit('k'), { allowed: true });

    now += 20_000;
    assert.deepEqual(limiter.hit('k'), { allowed: false, retryAfterSeconds: 40 });
  });

  it('lets requests through again as old ones leave the window', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    limiter.hit('k'); // t = 0
    now = 30_000;
    limiter.hit('k'); // t = 30s
    now = 59_999;
    assert.equal(limiter.hit('k').allowed, false);
    now = 60_001; // the first hit has expired, the second has not
    assert.equal(limiter.hit('k').allowed, true);
    assert.equal(limiter.hit('k').allowed, false);
  });

  it('counts each id separately', () => {
    const limiter = new RateLimiter({ limit: 1, now: () => 0 });
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('b').allowed, true);
    assert.equal(limiter.hit('a').allowed, false);
  });

  it('does not count refused requests against the window', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 10_000, now: () => now });
    limiter.hit('k');
    for (let i = 0; i < 5; i += 1) limiter.hit('k');
    now = 10_001;
    assert.equal(limiter.hit('k').allowed, true);
  });

  it('is off when the limit is 0', () => {
    const limiter = new RateLimiter({ limit: 0, now: () => 0 });
    for (let i = 0; i < 100; i += 1) assert.equal(limiter.hit('k').allowed, true);
  });

  it('always asks to wait at least one second', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    limiter.hit('k');
    now = 59_999;
    assert.deepEqual(limiter.hit('k'), { allowed: false, retryAfterSeconds: 1 });
  });
});
