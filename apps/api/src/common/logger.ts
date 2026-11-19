import { ConsoleLogger } from '@nestjs/common';
import { redact, redactString } from '@onlinepay/shared';

/**
 * Global logger that redacts PAN-like numbers, Emirates IDs and sensitive keys from every
 * log line. Use this (Nest `Logger`) everywhere — never `console.log` request bodies.
 */
export class RedactingLogger extends ConsoleLogger {
  private clean(message: unknown): unknown {
    if (typeof message === 'string') return redactString(message);
    return redact(message);
  }
  override log(message: unknown, ...rest: unknown[]) {
    super.log(this.clean(message), ...rest.map((r) => this.clean(r)));
  }
  override warn(message: unknown, ...rest: unknown[]) {
    super.warn(this.clean(message), ...rest.map((r) => this.clean(r)));
  }
  override error(message: unknown, ...rest: unknown[]) {
    super.error(this.clean(message), ...rest.map((r) => this.clean(r)));
  }
  override debug(message: unknown, ...rest: unknown[]) {
    super.debug(this.clean(message), ...rest.map((r) => this.clean(r)));
  }
}
