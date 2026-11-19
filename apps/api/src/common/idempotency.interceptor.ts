import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@onlinepay/db';
import { Observable, catchError, from, map, mergeMap, of, switchMap, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { sha256 } from './crypto';
import type { AuthedRequest } from './request';

export const IDEMPOTENT = 'idempotent';
/** Marks a money/card-moving route: requires an `Idempotency-Key` header. */
export const Idempotent = () => SetMetadata(IDEMPOTENT, true);

/**
 * Stores the outcome of the first request per (scope, Idempotency-Key). A retry with the same key
 * replays it (successes and 4xx client errors alike); a concurrent duplicate gets 409; reusing a
 * key with a different body gets 400.
 *
 * Only an unexpected/5xx failure releases the key so the client can retry. That is safe because
 * every money-moving service is itself idempotent on the same key (it persists the operation
 * before calling the issuer/gateway and resumes it on retry) — this interceptor is a convenience
 * layer, not the only line of defence.
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
        if (existing) return this.replay(existing);
        return next.handle().pipe(
          // Persist before responding so an immediate retry replays instead of seeing 409.
          mergeMap((response) => from(this.store(key, 200, response)).pipe(map(() => response))),
          catchError((err: unknown) =>
            from(this.settleError(key, err)).pipe(mergeMap(() => throwError(() => err))),
          ),
        );
      }),
    );
  }

  private replay(record: { statusCode: number; body: unknown }): Observable<unknown> {
    if (record.statusCode >= 400) {
      return throwError(
        () => new HttpException(record.body as Record<string, unknown>, record.statusCode),
      );
    }
    return of(record.body);
  }

  private async store(key: string, statusCode: number, body: unknown) {
    await this.prisma.idempotencyRecord.update({
      where: { key },
      data: { statusCode, responseJson: (body ?? null) as Prisma.InputJsonValue },
    });
  }

  /** 4xx outcomes are final for this key; anything else releases the key for a retry. */
  private async settleError(key: string, err: unknown) {
    try {
      if (err instanceof HttpException && err.getStatus() < 500) {
        await this.store(key, err.getStatus(), err.getResponse());
      } else {
        await this.prisma.idempotencyRecord.delete({ where: { key } });
      }
    } catch {
      // Never mask the original error; a stuck record expires with the nightly cleanup.
    }
  }

  /** Returns a stored outcome to replay, or null if this request now owns the key. */
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
      return { statusCode: record.statusCode, body: record.responseJson };
    }
  }
}
