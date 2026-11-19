import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@onlinepay/db';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { sha256 } from './crypto';
import type { AuthedRequest } from './request';

export const IDEMPOTENT = 'idempotent';
/** Marks a money/card-moving route: requires an `Idempotency-Key` header. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

/**
 * Stores the first successful response per (scope, Idempotency-Key). A retry with the same key
 * replays it; a concurrent duplicate gets 409; reusing a key with a different body gets 400.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, ctx.getHandler())) return next.handle();

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const rawKey = req.header('idempotency-key');
    if (!rawKey || !/^[A-Za-z0-9_-]{16,100}$/.test(rawKey)) {
      throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    }
    const scope = req.user?.id ?? (req.admin ? `admin:${req.admin.id}` : 'anon');
    const key = `${scope}:${rawKey}`;
    const route = `${req.method} ${req.route?.path ?? req.path}`;
    const requestHash = sha256(
      JSON.stringify({ route, params: req.params, body: req.body ?? null }),
    );

    return from(this.claim(key, scope, route, requestHash)).pipe(
      switchMap((existing) => {
        if (existing) return of(existing);
        return next.handle().pipe(
          tap((response) => {
            void this.prisma.idempotencyRecord.update({
              where: { key },
              data: { statusCode: 200, responseJson: (response ?? null) as Prisma.InputJsonValue },
            });
          }),
          catchError((err) => {
            // Release the key so the client can retry after a failure.
            void this.prisma.idempotencyRecord.delete({ where: { key } }).catch(() => undefined);
            return throwError(() => err);
          }),
        );
      }),
    );
  }

  /** Returns a stored response to replay, or null if this request now owns the key. */
  private async claim(key: string, scope: string, route: string, requestHash: string) {
    try {
      await this.prisma.idempotencyRecord.create({ data: { key, scope, route, requestHash } });
      return null;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const record = await this.prisma.idempotencyRecord.findUnique({ where: { key } });
      if (!record) throw new ConflictException({ code: 'IDEMPOTENCY_RETRY' });
      if (record.requestHash !== requestHash) {
        throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      }
      if (record.statusCode == null) throw new ConflictException({ code: 'REQUEST_IN_PROGRESS' });
      return record.responseJson;
    }
  }
}
