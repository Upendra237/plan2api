/** An expected problem whose message can be shown to the user as-is (no stack trace). */
export class Plan2ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Plan2ApiError';
  }
}

/**
 * True when a file system error means "nothing is there": ENOENT, or ENOTDIR, which is what
 * Linux and macOS report when a folder in the path is really a file (Windows says ENOENT).
 */
export function isMissingPathError(err) {
  return err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
}
