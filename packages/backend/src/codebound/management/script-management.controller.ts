// SPDX-License-Identifier: AGPL-3.0-only
import { BadRequestException, Body, Controller, Delete, Get, HttpException, Param, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from '../../auth/auth.service';
import type { Outcome } from '../contracts';
import { ScriptPersistenceService } from '../persistence/script-persistence.service';
import { dashboardPrincipal, type DashboardRequest } from './dashboard-principal';
import { CreateScriptDto, RevisionDto, ScriptPageDto, UpdateScriptDto } from './script-management.dto';
import { ScriptBindingsService } from './script-bindings.service';

@Controller('api/codebound')
@UseGuards(AuthGuard('jwt'))
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
  exceptionFactory: () => new BadRequestException({ ok: false, error: { code: 'INVALID_INPUT', message: 'Invalid script request' } }) }))
export class ScriptManagementController {
  constructor(private readonly persistence: ScriptPersistenceService, private readonly auth: AuthService,
    private readonly bindings: ScriptBindingsService) {}

  private result<T>(result: Outcome<T>): Outcome<T> {
    if (!result.ok) throw new HttpException(result, ({ INVALID_INPUT: 400, NOT_FOUND: 404, FORBIDDEN: 403,
      VERSION_CONFLICT: 409 } as Record<string, number>)[result.error.code] ?? 500);
    return result;
  }
  @Get('bindings')
  async eligible(@Req() req: DashboardRequest, @Query() page: ScriptPageDto) {
    try { return { ok: true, value: await this.bindings.list(dashboardPrincipal(req, this.auth), page.afterId) }; }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Unable to load bindings' } }, 500);
    }
  }
  @Get('runs')
  async runs(@Req() req: DashboardRequest, @Query() page: ScriptPageDto) {
    return this.result(await this.persistence.listRunReceipts(dashboardPrincipal(req, this.auth), page.afterId));
  }
  @Get('scripts')
  async list(@Req() req: DashboardRequest, @Query() page: ScriptPageDto) {
    return this.result(await this.persistence.list(dashboardPrincipal(req, this.auth), { ...page, limit: 20 }));
  }
  @Get('scripts/:id')
  async get(@Req() req: DashboardRequest, @Param('id') id: string) {
    return this.result(await this.persistence.get(dashboardPrincipal(req, this.auth), id));
  }
  @Post('scripts')
  async create(@Req() req: DashboardRequest, @Body() body: CreateScriptDto) {
    return this.result(await this.persistence.create(dashboardPrincipal(req, this.auth), body.definition));
  }
  @Put('scripts/:id')
  async update(@Req() req: DashboardRequest, @Param('id') id: string, @Body() body: UpdateScriptDto) {
    return this.result(await this.persistence.update(dashboardPrincipal(req, this.auth), id, body.expectedRevision, body.definition));
  }
  @Delete('scripts/:id')
  async remove(@Req() req: DashboardRequest, @Param('id') id: string, @Body() body: RevisionDto) {
    return this.result(await this.persistence.remove(dashboardPrincipal(req, this.auth), id, body.expectedRevision));
  }
}
