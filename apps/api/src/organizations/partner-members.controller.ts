import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  ChangeMemberRoleSchema,
  ERROR_CODES,
  InviteMemberSchema,
  SetOperatesSchema,
  UploadDocumentSchema,
  type ChangeMemberRole,
  type InviteMember,
  type SetOperates,
  type UploadDocument,
} from '@kovsh/contracts';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ModerationService } from '../admin/moderation.service';
import { DocumentsService, type DocumentView, type RequirementView } from './documents.service';
import { MembersService, type InvitationView, type MemberView } from './members.service';
import { CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from './org-context.guard';
import { assertPartnerApp } from './partner-app';

@ApiTags('partner: сотрудники')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('partner')
export class PartnerMembersController {
  constructor(
    private readonly members: MembersService,
    private readonly docs: DocumentsService,
    private readonly moderation: ModerationService,
  ) {}

  // ── Приглашения текущего пользователя ─────────────────────────────────────
  @Get('invitations')
  async invitations(@CurrentUser() user: AuthUser): Promise<InvitationView[]> {
    assertPartnerApp(user);
    return this.members.invitations(user.userId);
  }

  @Post('invitations/:memberId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  async accept(@CurrentUser() user: AuthUser, @Param('memberId', ParseUUIDPipe) id: string): Promise<void> {
    assertPartnerApp(user);
    await this.members.respond(user.userId, id, true);
  }

  @Post('invitations/:memberId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async decline(@CurrentUser() user: AuthUser, @Param('memberId', ParseUUIDPipe) id: string): Promise<void> {
    assertPartnerApp(user);
    await this.members.respond(user.userId, id, false);
  }

  @Post('memberships/:orgId/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  async leave(@CurrentUser() user: AuthUser, @Param('orgId', ParseUUIDPipe) orgId: string): Promise<void> {
    assertPartnerApp(user);
    await this.members.leave(orgId, user.userId);
  }

  // ── Сотрудники организации ────────────────────────────────────────────────
  @Get('members')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager', 'dispatcher')
  async list(@CurrentOrg() org: OrgContext): Promise<MemberView[]> {
    return this.members.list(org.orgId);
  }

  @Post('members')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async invite(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(InviteMemberSchema)) dto: InviteMember,
  ): Promise<MemberView> {
    return this.members.invite(org, user.userId, dto);
  }

  @Patch('members/:id/role')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async role(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(ChangeMemberRoleSchema)) dto: ChangeMemberRole,
  ): Promise<MemberView> {
    return this.members.changeRole(org, user.userId, id, dto.role);
  }

  @Patch('members/:id/can-operate')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async canOperate(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(SetOperatesSchema)) dto: SetOperates,
  ): Promise<MemberView> {
    return this.members.setCanOperate(org, user.userId, id, dto.canOperate);
  }

  @Post('members/:id/block')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async block(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<MemberView> {
    return this.members.setBlocked(org, user.userId, id, true);
  }

  @Post('members/:id/unblock')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async unblock(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<MemberView> {
    return this.members.setBlocked(org, user.userId, id, false);
  }

  @Post('members/:id/detach')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async detach(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.members.detach(org, user.userId, id);
  }

  // ── Документы машиниста (В-32) ────────────────────────────────────────────
  @Get('members/:id/documents')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  async operatorDocuments(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ requirements: RequirementView[]; documents: DocumentView[] }> {
    await this.assertOperatorDocsAccess(org, user, id);
    const [requirements, documents] = await Promise.all([this.docs.requirements('operator', id), this.docs.list('operator', id)]);
    return { requirements, documents };
  }

  @Post('members/:id/documents')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  async uploadOperatorDocument(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UploadDocumentSchema)) dto: UploadDocument,
  ): Promise<DocumentView> {
    await this.assertOperatorDocsAccess(org, user, id);
    const doc = await this.docs.upload('operator', id, dto, user.userId);
    await this.moderation.recalcOperatorVerification(id);
    return doc;
  }

  /** Документы машиниста видят и загружают руководители компании и сам машинист. */
  private async assertOperatorDocsAccess(org: OrgContext, user: AuthUser, memberId: string): Promise<void> {
    const member = await this.members.getInOrg(org.orgId, memberId);
    if (!member.canOperate) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Сотрудник не работает машинистом', HttpStatus.BAD_REQUEST);
    }
    const isSelf = member.userId === user.userId;
    if (!isSelf && org.role !== 'owner' && org.role !== 'manager') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Недостаточно прав', HttpStatus.FORBIDDEN);
    }
  }
}
