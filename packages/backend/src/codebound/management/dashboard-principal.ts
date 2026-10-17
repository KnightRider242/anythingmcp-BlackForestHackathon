// SPDX-License-Identifier: AGPL-3.0-only
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../auth/auth.service';
import type { ExecutionPrincipal } from '../contracts';

export type DashboardRequest = Request & { user: { sub: string; organizationId: string } };

/** Only call after AuthGuard('jwt'): organization comes from its live DB lookup. */
export function dashboardPrincipal(request: DashboardRequest, auth: AuthService): ExecutionPrincipal {
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
  if (!bearer) throw new UnauthorizedException();
  const claims = auth.verifyToken(bearer[1]);
  if (claims.sub !== request.user.sub || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat! <= 0 || claims.exp! <= claims.iat!) throw new UnauthorizedException();
  return { userId: request.user.sub, organizationId: request.user.organizationId,
    tokenIssuedAtMs: claims.iat! * 1000, tokenExpiresAtMs: claims.exp! * 1000, origin: { kind: 'dashboard' } };
}
