import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMissingPathError, Plan2ApiError } from './errors.js';

const KEY_PREFIX = 'p2a_';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STORE_VERSION = 1;
const MAX_KEY_LENGTH = 512;

/** A problem with the key store or the user's input that can be reported as-is. */
export class KeyError extends Plan2ApiError {
  constructor(message) {
    super(message);
    this.name = 'KeyError';
  }
}

/**
 * Directory holding plan2api data. `PLAN2API_HOME` overrides the default `~/.plan2api`.
 * Always absolute: the background server runs with this directory as its working directory, so a
 * relative `PLAN2API_HOME` would otherwise point somewhere else for the server than for the CLI.
 */
export function getConfigDir() {
  const override = process.env.PLAN2API_HOME;
  return override ? resolve(override) : join(homedir(), '.plan2api');
}

export function getKeysPath() {
  return join(getConfigDir(), 'keys.json');
}

export function generateKey() {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function hashKey(key) {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new KeyError('A key name is required.');
  }
  if (!NAME_PATTERN.test(name)) {
    throw new KeyError(
      `Invalid key name ${JSON.stringify(name)}. Use 1-64 characters: letters, digits, ".", "_" ` +
        'or "-", starting with a letter or digit.',
    );
  }
}

function isValidRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.name === 'string' &&
    typeof record.hash === 'string' &&
    typeof record.createdAt === 'string'
  );
}

function readStore() {
  const file = getKeysPath();
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (isMissingPathError(err)) return { version: STORE_VERSION, keys: [] };
    throw new KeyError(`Could not read ${file}: ${err.message}`);
  }

  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw new KeyError(`${file} is not valid JSON. Fix or remove the file and try again.`);
  }
  if (store === null || !Array.isArray(store.keys) || !store.keys.every(isValidRecord)) {
    throw new KeyError(`${file} does not look like a plan2api key file. Fix or remove it.`);
  }
  return store;
}

function writeStore(store) {
  const dir = getConfigDir();
  const file = getKeysPath();
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // POSIX modes are not meaningful on Windows; there the user profile's ACLs apply.
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    // Write to a private temp file and rename, so a crash never leaves a half-written key file.
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort: a failed clean-up must not hide why the write failed.
    }
    throw new KeyError(`Could not write ${file}: ${err.message}`);
  }
}

/**
 * Creates a key and stores only its SHA-256 hash.
 * The returned `key` is the only copy that will ever exist.
 */
export function createKey(name) {
  validateName(name);
  const store = readStore();
  if (store.keys.some((record) => record.name === name)) {
    throw new KeyError(
      `A key named ${JSON.stringify(name)} already exists. ` +
        `Pick another name, or remove it first with: plan2api delete ${name}`,
    );
  }

  const key = generateKey();
  const createdAt = new Date().toISOString();
  store.keys.push({ name, hash: hashKey(key), createdAt });
  writeStore(store);
  return { name, key, createdAt };
}

/**
 * Checks a presented key against the stored hashes and returns the key's name, or null.
 * The key file is re-read on every call, so create and delete take effect immediately.
 * Digests are compared in constant time, and every stored hash is checked.
 */
export function verifyKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  const presented = createHash('sha256').update(key, 'utf8').digest();

  let name = null;
  for (const record of readStore().keys) {
    const stored = Buffer.from(record.hash, 'hex');
    const matches = stored.length === presented.length && timingSafeEqual(stored, presented);
    if (matches) name = record.name;
  }
  return name;
}

/** Returns key names and creation dates only; hashes never leave this module. */
export function listKeys() {
  return readStore().keys.map(({ name, createdAt }) => ({ name, createdAt }));
}

export function deleteKey(name) {
  validateName(name);
  const store = readStore();
  const remaining = store.keys.filter((record) => record.name !== name);
  if (remaining.length === store.keys.length) {
    throw new KeyError(
      `No key named ${JSON.stringify(name)}. Run "plan2api list" to see existing keys.`,
    );
  }
  store.keys = remaining;
  writeStore(store);
}
