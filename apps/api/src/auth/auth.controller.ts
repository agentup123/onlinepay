import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import {
  loginStartSchema,
  otpCodeSchema,
  otpVerifySchema,
  signupStartSchema,
} from '@onlinepay/shared';
import { ZodPipe } from '../common/zod.pipe';
import { AuthedRequest, CurrentUser, Meta, RequestMeta } from '../common/request';
import { env } from '../config/env';
import { AuthService, SESSION_TTL_MS } from './auth.service';
import { SESSION_COOKIE, SessionGuard } from './session.guard';
import type { User } from '@onlinepay/db';

const signupVerifySchema = z.object({
  emailChallengeId: z.string().uuid(),
  emailCode: otpCodeSchema,
  phoneChallengeId: z.string().uuid(),
  phoneCode: otpCodeSchema,
});

const STRICT = { default: { limit: 5, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('signup')
  @Throttle(STRICT)
  signup(@Body(new ZodPipe(signupStartSchema)) body: z.infer<typeof signupStartSchema>) {
    return this.auth.startSignup(body);
  }

  @Post('signup/verify')
  @HttpCode(200)
  @Throttle(STRICT)
  async signupVerify(
    @Body(new ZodPipe(signupVerifySchema)) body: z.infer<typeof signupVerifySchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.auth.completeSignup(body, meta);
    setSessionCookie(res, token);
    return { ok: true };
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(STRICT)
  login(@Body(new ZodPipe(loginStartSchema)) body: z.infer<typeof loginStartSchema>) {
    return this.auth.startLogin(body.email);
  }

  @Post('login/verify')
  @HttpCode(200)
  @Throttle(STRICT)
  async loginVerify(
    @Body(new ZodPipe(otpVerifySchema)) body: z.infer<typeof otpVerifySchema>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { token } = await this.auth.completeLogin(body.challengeId, body.code, meta);
    setSessionCookie(res, token);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    if (req.sessionId) await this.auth.logout(req.sessionId);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: User) {
    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone.replace(/^(\+9715)\d{5}/, '$1•••••'),
      locale: user.locale,
    };
  }
}

function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}
