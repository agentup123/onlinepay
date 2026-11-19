import { HttpException, HttpStatus } from '@nestjs/common';

export class TooManyRequestsException extends HttpException {
  constructor(body: Record<string, unknown>) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
