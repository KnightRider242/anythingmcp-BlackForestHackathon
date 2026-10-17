// SPDX-License-Identifier: AGPL-3.0-only
import { BadRequestException, Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request, Response } from 'express';
import { AuthService } from '../../auth/auth.service';
import { ScriptExecutionRequestDto } from '../contracts.validation';
import { ScriptExecutionService } from './script-execution.service';

@Controller('api/codebound')
@UseGuards(AuthGuard('jwt'))
export class ScriptExecutionController {
  constructor(private readonly execution: ScriptExecutionService, private readonly auth: AuthService) {}

  @Post('scripts/execute')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: () => new BadRequestException({ ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid execution request' } }) }))
  async execute(@Req() request: Request & { user: { sub: string; organizationId: string } },
    @Res({ passthrough: true }) response: Response, @Body() body: ScriptExecutionRequestDto) {
    // JwtStrategy supplies live active organization but omits token timestamps.
    // Reuse signature verification rather than decoding unverified JWT claims.
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
    if (!bearer) throw new UnauthorizedException();
    const claims = this.auth.verifyToken(bearer[1]);
    if (claims.sub !== request.user.sub || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat! <= 0 || claims.exp! <= claims.iat!) throw new UnauthorizedException();
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!response.writableFinished) abort(); };
    request.once('aborted', abort); response.once('close', close);
    // Authentication/other guards await database work before this handler.
    // A client may have disconnected before these listeners were installed.
    if (request.aborted || response.destroyed) controller.abort();
    try {
      const result = await this.execution.execute({ userId: request.user.sub, organizationId: request.user.organizationId,
        tokenIssuedAtMs: claims.iat! * 1000, tokenExpiresAtMs: claims.exp! * 1000, origin: { kind: 'dashboard' } }, body, controller.signal);
      // A created execution returns its terminal receipt even when execution
      // failed. Pre-admission failures have no receipt and use HTTP errors.
      if (!result.ok) response.status(({ INVALID_INPUT: 400, NOT_FOUND: 404, FORBIDDEN: 403, VERSION_CONFLICT: 409,
        CANCELLED: 408, SANDBOX_UNAVAILABLE: 503 } as Record<string, number>)[result.error.code] ?? 500);
      return result;
    } finally { request.removeListener('aborted', abort); response.removeListener('close', close); }
  }
}
