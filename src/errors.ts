/**
 * Error raised by C3 when a construct is configured in a way that cannot be
 * synthesized safely. Messages should tell the developer what to change.
 */
export class C3ValidationError extends Error {
  constructor(message: string) {
    super(`[c3-aws] ${message}`);
    this.name = 'C3ValidationError';
  }
}
