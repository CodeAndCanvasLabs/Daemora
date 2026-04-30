/**
 * Secret<T> — a branded string that resists accidental logging.
 *
 * `toString()`, `toJSON()`, `inspect()` all return "[REDACTED]" so a
 * stray `console.log(secret)` or `JSON.stringify({ key: secret })`
 * never leaks the real value. To USE the value, call `.reveal()` —
 * an explicit, greppable call that's easy to audit.
 *
 *   const k = vault.get("ANTHROPIC_API_KEY");        // Secret
 *   if (k) provider({ apiKey: k.reveal() });          // explicit unwrap
 *   logger.info({ key: k });                          // prints "[REDACTED]"
 */

const REDACTED = "[REDACTED]";

const inspectSym = Symbol.for("nodejs.util.inspect.custom");

export class Secret {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  static of(value: string): Secret {
    return new Secret(value);
  }

  /** Explicit unwrap. Always grep `.reveal()` to find every site that touches a real secret. */
  reveal(): string {
    return this.#value;
  }

  /** Length of the underlying value, useful for "is this set" checks without revealing it. */
  get length(): number {
    return this.#value.length;
  }

  /** Last 4 chars, prefixed with bullets — useful for UI display ("•••• abc1"). */
  hint(): string {
    if (this.#value.length <= 4) return REDACTED;
    return `•••• ${this.#value.slice(-4)}`;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspectSym](): string {
    return REDACTED;
  }
}
