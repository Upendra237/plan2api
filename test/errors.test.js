import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMissingPathError, Plan2ApiError } from '../src/errors.js';

describe('isMissingPathError', () => {
  it('counts ENOENT and ENOTDIR as "nothing there"', () => {
    assert.equal(isMissingPathError(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
    // Linux and macOS report a path that goes through a file as ENOTDIR; Windows says ENOENT.
    assert.equal(isMissingPathError(Object.assign(new Error('x'), { code: 'ENOTDIR' })), true);
  });

  it('does not hide real problems', () => {
    for (const code of ['EACCES', 'EPERM', 'EISDIR', 'EBUSY', 'EEXIST', 'EMFILE', undefined]) {
      assert.equal(isMissingPathError(Object.assign(new Error('x'), { code })), false, code);
    }
    assert.equal(isMissingPathError(new Plan2ApiError('x')), false);
    assert.equal(isMissingPathError(null), false);
    assert.equal(isMissingPathError(undefined), false);
  });
});
