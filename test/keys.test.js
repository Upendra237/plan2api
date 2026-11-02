import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { failFs, restoreFs } from '../fixtures/fs-fault.js';
import {
  createKey,
  deleteKey,
  generateKey,
  getConfigDir,
  getKeysPath,
  hashKey,
  KeyError,
  listKeys,
  verifyKey,
} from '../src/keys.js';

let sandbox;
let previousHome;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'plan2api-test-'));
  previousHome = process.env.PLAN2API_HOME;
  // A directory that does not exist yet, so creation is exercised too.
  process.env.PLAN2API_HOME = join(sandbox, 'home');
});

afterEach(() => {
  restoreFs();
  if (previousHome === undefined) delete process.env.PLAN2API_HOME;
  else process.env.PLAN2API_HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe('getConfigDir', () => {
  it('uses PLAN2API_HOME as an absolute path, so a relative one means the same place everywhere', () => {
    process.env.PLAN2API_HOME = join('relative', 'data');
    assert.equal(isAbsolute(getConfigDir()), true);
    assert.equal(getConfigDir(), resolve('relative', 'data'));
    assert.equal(getKeysPath(), join(resolve('relative', 'data'), 'keys.json'));
  });

  it('falls back to ~/.plan2api, also when PLAN2API_HOME is empty', () => {
    process.env.PLAN2API_HOME = '';
    assert.match(getConfigDir(), /[\\/]\.plan2api$/);
    assert.equal(isAbsolute(getConfigDir()), true);
  });
});

describe('a key file that is not there', () => {
  // The same situation is ENOENT on Windows and ENOTDIR on Linux and macOS (a folder in the path
  // is a file), so the error is faked and the outcome must not depend on the operating system.
  for (const code of ['ENOENT', 'ENOTDIR']) {
    it(`means no keys when reading it fails with ${code}, and nobody gets in`, () => {
      createKey('real');
      failFs('readFileSync', /keys\.json$/, code);
      assert.deepEqual(listKeys(), []);
      assert.equal(verifyKey('p2a_anything'), null);
    });
  }

  for (const code of ['EACCES', 'EISDIR', 'EPERM']) {
    it(`is still an error when reading it fails with ${code}`, () => {
      createKey('real');
      failFs('readFileSync', /keys\.json$/, code);
      assert.throws(
        () => listKeys(),
        (err) => err instanceof KeyError && /^Could not read .*keys\.json: /.test(err.message),
      );
      assert.throws(() => verifyKey('p2a_anything'), KeyError, 'it must not let anyone in');
    });
  }

  it('also works for real when the data directory is inside a regular file', () => {
    writeFileSync(join(sandbox, 'a-file'), 'x');
    process.env.PLAN2API_HOME = join(sandbox, 'a-file', 'inside');
    assert.deepEqual(listKeys(), []);
    assert.throws(
      () => createKey('nope'),
      (err) => err instanceof KeyError && /^Could not write /.test(err.message),
    );
  });

  it('reports a failed write as a KeyError even when the clean-up fails too', () => {
    failFs('rmSync', /\.tmp$/, 'ENOTDIR');
    failFs('mkdirSync', /home$/, 'ENOTDIR');
    assert.throws(
      () => createKey('nope'),
      (err) => err instanceof KeyError && /^Could not write .*ENOTDIR/.test(err.message),
    );
  });
});

describe('generateKey / hashKey', () => {
  it('generates unique keys with the p2a_ prefix', () => {
    const a = generateKey();
    const b = generateKey();
    assert.match(a, /^p2a_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, b);
  });

  it('hashes with SHA-256 (hex)', () => {
    assert.equal(
      hashKey('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('createKey', () => {
  it('returns the key once and stores only its hash', () => {
    const { name, key, createdAt } = createKey('my-app');
    assert.equal(name, 'my-app');
    assert.match(key, /^p2a_/);
    assert.equal(new Date(createdAt).toISOString(), createdAt);

    const raw = readFileSync(getKeysPath(), 'utf8');
    assert.ok(!raw.includes(key), 'raw key must not be written to disk');

    const stored = JSON.parse(raw);
    assert.equal(stored.keys.length, 1);
    assert.deepEqual(Object.keys(stored.keys[0]).sort(), ['createdAt', 'hash', 'name']);
    assert.equal(stored.keys[0].hash, hashKey(key));
    assert.equal(stored.keys[0].name, 'my-app');
    assert.equal(stored.keys[0].createdAt, createdAt);
  });

  it('rejects a duplicate name and leaves the store unchanged', () => {
    createKey('dup');
    const before = readFileSync(getKeysPath(), 'utf8');
    assert.throws(
      () => createKey('dup'),
      (err) => err instanceof KeyError && /already exists/.test(err.message),
    );
    assert.equal(readFileSync(getKeysPath(), 'utf8'), before);
  });

  it('rejects invalid names', () => {
    const bad = ['', ' ', 'has space', 'a/b', '..', '../x', '-flag', '.hidden', 'x'.repeat(65)];
    for (const name of bad) {
      assert.throws(() => createKey(name), KeyError, `expected ${JSON.stringify(name)} to fail`);
    }
    assert.throws(() => createKey(undefined), KeyError);
    assert.deepEqual(listKeys(), []);
  });

  it(
    'restricts permissions on the key file and its directory',
    { skip: process.platform === 'win32' && 'POSIX modes do not apply on Windows' },
    () => {
      createKey('perms');
      assert.equal(statSync(getKeysPath()).mode & 0o777, 0o600);
      assert.equal(statSync(join(sandbox, 'home')).mode & 0o777, 0o700);
    },
  );
});

describe('listKeys', () => {
  it('returns an empty list when nothing has been created', () => {
    assert.deepEqual(listKeys(), []);
  });

  it('returns only names and dates, in creation order', () => {
    const first = createKey('first');
    const second = createKey('second');
    const keys = listKeys();
    assert.deepEqual(keys, [
      { name: 'first', createdAt: first.createdAt },
      { name: 'second', createdAt: second.createdAt },
    ]);
    const serialized = JSON.stringify(keys);
    assert.ok(!serialized.includes(first.key));
    assert.ok(!serialized.includes(hashKey(first.key)));
  });
});

describe('deleteKey', () => {
  it('removes only the named key', () => {
    createKey('keep');
    createKey('drop');
    deleteKey('drop');
    assert.deepEqual(
      listKeys().map((k) => k.name),
      ['keep'],
    );
  });

  it('fails clearly when the key does not exist', () => {
    createKey('real');
    assert.throws(
      () => deleteKey('ghost'),
      (err) => err instanceof KeyError && /No key named "ghost"/.test(err.message),
    );
    assert.equal(listKeys().length, 1);
  });

  it('frees the name for reuse with a brand new key', () => {
    const old = createKey('reuse');
    deleteKey('reuse');
    const fresh = createKey('reuse');
    assert.notEqual(old.key, fresh.key);
    assert.equal(listKeys().length, 1);
  });
});

describe('verifyKey', () => {
  it('returns the name for a valid key and null for anything else', () => {
    const { key } = createKey('alpha');
    createKey('beta');
    assert.equal(verifyKey(key), 'alpha');
    for (const wrong of [`${key}x`, key.slice(0, -1), key.toUpperCase(), 'p2a_nope', '', ' ']) {
      assert.equal(verifyKey(wrong), null, wrong);
    }
    for (const notAString of [undefined, null, 5, {}, []]) {
      assert.equal(verifyKey(notAString), null);
    }
    assert.equal(verifyKey('x'.repeat(1000)), null);
  });

  it('finds the right key among several', () => {
    const keys = ['one', 'two', 'three'].map((name) => ({ name, ...createKey(name) }));
    for (const { name, key } of keys) assert.equal(verifyKey(key), name);
  });

  it('stops accepting a key as soon as it is deleted, and sees new keys at once', () => {
    const { key } = createKey('gone');
    assert.equal(verifyKey(key), 'gone');
    deleteKey('gone');
    assert.equal(verifyKey(key), null);
    const later = createKey('later');
    assert.equal(verifyKey(later.key), 'later');
  });

  it('returns null when there is no key file yet', () => {
    assert.equal(verifyKey(generateKey()), null);
  });

  it('fails loudly (not "invalid key") when the key file is unreadable', () => {
    createKey('seed');
    writeFileSync(getKeysPath(), '{ nope');
    assert.throws(() => verifyKey('p2a_anything'), KeyError);
  });
});

describe('corrupt key file', () => {
  it('refuses to overwrite invalid JSON', () => {
    createKey('seed');
    writeFileSync(getKeysPath(), '{ not json');
    assert.throws(
      () => createKey('another'),
      (err) => err instanceof KeyError && /not valid JSON/.test(err.message),
    );
    assert.equal(readFileSync(getKeysPath(), 'utf8'), '{ not json');
  });

  it('refuses a file with an unexpected shape', () => {
    createKey('seed');
    writeFileSync(getKeysPath(), JSON.stringify({ keys: [{ name: 1 }] }));
    assert.throws(() => listKeys(), KeyError);
  });
});
