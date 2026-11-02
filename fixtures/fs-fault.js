// Lets a test make one `node:fs` function fail with a chosen error code (such as ENOTDIR) for
// paths that match a pattern, so the result does not depend on how the operating system reports
// the situation: the same path can give ENOENT on Windows and ENOTDIR on Linux and macOS.
// Every other call goes through to the real function. Call `restoreFs()` after each test.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';

/** Makes `fs[method](path, ...)` throw an error with `code` when `path` matches `pattern`. */
export function failFs(method, pattern, code) {
  const real = fs[method];
  mock.method(fs, method, (path, ...rest) => {
    if (typeof path === 'string' && pattern.test(path)) {
      throw Object.assign(new Error(`${code}: simulated by the test`), { code });
    }
    return real(path, ...rest);
  });
  // The source files use named imports, which only see the change after this call.
  syncBuiltinESMExports();
}

export function restoreFs() {
  mock.restoreAll();
  syncBuiltinESMExports();
}
