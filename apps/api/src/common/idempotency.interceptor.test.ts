import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@onlinepay/db';
import { firstValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';

type Rec = {
  key: string;
  requestHash: string;
  statusCode: number | null;
  responseJson: unknown;
};

function setup() {
  const records = new Map<string, Rec>();
  const prisma = {
    idempotencyRecord: {
      create: vi.fn(async ({ data }: { data: Rec }) => {
        if (records.has(data.key)) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        records.set(data.key, { ...data, statusCode: null, responseJson: null });
      }),
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => records.get(where.key)),
      update: vi.fn(async ({ where, data }: { where: { key: string }; data: Partial<Rec> }) => {
        records.set(where.key, { ...records.get(where.key)!, ...data });
      }),
      delete: vi.fn(async ({ where }: { where: { key: string } }) => {
        records.delete(where.key);
      }),
    },
  };
  const reflector = { get: () => true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interceptor = new IdempotencyInterceptor(reflector as any, prisma as any);
  const ctx = (body: unknown) =>
    ({
      getHandler: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          header: () => 'key-0123456789abcdef',
          user: { id: 'u1' },
          method: 'POST',
          route: { path: '/cards/:id/fund' },
          params: { id: 'c1' },
          body,
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  return { interceptor, ctx, records };
}

describe('IdempotencyInterceptor', () => {
  it('stores the response before returning it and replays it', async () => {
    const { interceptor, ctx, records } = setup();
    const handler = { handle: vi.fn(() => of({ balanceFils: 100 })) };
    await expect(
      firstValueFrom(interceptor.intercept(ctx({ amountFils: 100 }), handler)),
    ).resolves.toEqual({ balanceFils: 100 });
    expect([...records.values()][0]!.statusCode).toBe(200);

    await expect(
      firstValueFrom(interceptor.intercept(ctx({ amountFils: 100 }), handler)),
    ).resolves.toEqual({ balanceFils: 100 });
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('replays a 4xx outcome instead of re-running the handler', async () => {
    const { interceptor, ctx } = setup();
    const handler = {
      handle: vi.fn(() => throwError(() => new BadRequestException({ code: 'NOPE' }))),
    };
    await expect(firstValueFrom(interceptor.intercept(ctx({ a: 1 }), handler))).rejects.toThrow();
    await expect(
      firstValueFrom(interceptor.intercept(ctx({ a: 1 }), handler)),
    ).rejects.toMatchObject({ status: 400, response: { code: 'NOPE' } });
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('releases the key after a 5xx so the client can retry', async () => {
    const { interceptor, ctx, records } = setup();
    const handler = {
      handle: vi.fn(() => throwError(() => new ServiceUnavailableException())),
    };
    await expect(firstValueFrom(interceptor.intercept(ctx({ a: 1 }), handler))).rejects.toThrow();
    expect(records.size).toBe(0);
  });

  it('rejects reuse of a key with a different body', async () => {
    const { interceptor, ctx } = setup();
    const handler = { handle: vi.fn(() => of({ ok: true })) };
    await firstValueFrom(interceptor.intercept(ctx({ amountFils: 100 }), handler));
    await expect(
      firstValueFrom(interceptor.intercept(ctx({ amountFils: 5_000_000 }), handler)),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });
});
