/** An expected problem whose message can be shown to the user as-is (no stack trace). */
export class Plan2ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Plan2ApiError';
  }
}
