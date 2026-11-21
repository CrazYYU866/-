import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  BankAccountSchema,
  CreateOrganizationSchema,
  UpdateOrganizationSchema,
  UploadDocumentSchema,
  type BankAccountRequest,
  type CreateOrganization,
  type OtpRequestResponse,
  type UpdateOrganization,
  type UploadDocument,
} from '@kovsh/contracts';
import type { Request } from 'express';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BankAccountService } from './bank-account.service';
import { DocumentsService, type DocumentView } from './documents.service';
import { AllowBlockedOrg, CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from './org-context.guard';
import { OrganizationsService, type MembershipView, type OrganizationView } from './organizations.service';
import { assertPartnerApp } from './partner-app';

@ApiTags('partner: организация')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('partner')
export class PartnerOrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly docs: DocumentsService,
    private readonly bank: BankAccountService,
  ) {}

  @Get('memberships')
  async memberships(@CurrentUser() user: AuthUser): Promise<MembershipView[]> {
    assertPartnerApp(user);
    return this.orgs.memberships(user.userId);
  }

  @Post('organizations')
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateOrganizationSchema)) dto: CreateOrganization,
  ): Promise<OrganizationView> {
    assertPartnerApp(user);
    const org = await this.orgs.create(user.userId, dto);
    return this.orgs.view(org.id, 'owner');
  }

  @Get('organizations/current')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @AllowBlockedOrg()
  async current(@CurrentOrg() org: OrgContext): Promise<OrganizationView> {
    return this.orgs.view(org.orgId, org.role);
  }

  @Patch('organizations/current')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async update(
    @CurrentOrg() org: OrgContext,
    @Body(new ZodValidationPipe(UpdateOrganizationSchema)) dto: UpdateOrganization,
  ): Promise<OrganizationView> {
    await this.orgs.update(org.orgId, dto);
    return this.orgs.view(org.orgId, org.role);
  }

  @Post('organizations/current/submit')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser): Promise<OrganizationView> {
    await this.orgs.submit(org.orgId, user.userId);
    return this.orgs.view(org.orgId, org.role);
  }

  @Post('organizations/current/documents')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async uploadDocument(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UploadDocumentSchema)) dto: UploadDocument,
  ): Promise<DocumentView> {
    const o = await this.orgs.get(org.orgId);
    return this.docs.upload('organization', org.orgId, dto, user.userId, o.legalForm);
  }

  @Get('organizations/current/documents')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner', 'manager')
  async documents(@CurrentOrg() org: OrgContext): Promise<DocumentView[]> {
    return this.docs.list('organization', org.orgId);
  }

  @Post('organizations/current/bank-account/code')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner')
  async bankCode(@CurrentUser() user: AuthUser, @Req() req: Request): Promise<OtpRequestResponse> {
    return this.bank.requestCode(user.userId, req.ip ?? null);
  }

  @Put('organizations/current/bank-account')
  @ApiHeader({ name: 'X-Org-Id', required: true })
  @UseGuards(OrgContextGuard)
  @OrgRoles('owner')
  async setBank(
    @CurrentOrg() org: OrgContext,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BankAccountSchema)) dto: BankAccountRequest,
    @Req() req: Request,
  ): Promise<{ accountLast4: string }> {
    return this.bank.set(org.orgId, user.userId, dto, req.ip ?? null);
  }
}
