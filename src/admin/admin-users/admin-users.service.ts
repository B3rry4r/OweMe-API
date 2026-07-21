import { Injectable } from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundAppException, ValidationException, uuidv7 } from '../../common';
import {
  AdminPrincipal,
  AdminRole,
  generateTempPassword,
  hashPassword,
} from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminUserCreatedView, AdminUserView } from './admin-users.views';

/**
 * Admin-user management (superadmin only; registry AdminUserManagement). Every write
 * is audit-logged via AdminAuditService. Per the replace-invite-with-create ruling
 * there is no invite email: create returns a server-generated temp password ONCE
 * with mustChangePassword=true, and the dashboard's 'invited' state derives from
 * pendingFirstLogin (mustChangePassword && never logged in).
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** GET /admin/admin-users */
  async list(): Promise<AdminUserView[]> {
    const admins = await this.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
    return admins.map((a) => this.toView(a));
  }

  /** POST /admin/admin-users - temp password returned ONCE, never retrievable again. */
  async create(
    actor: AdminPrincipal,
    input: { email: string; name: string; role: AdminRole },
  ): Promise<AdminUserCreatedView> {
    const duplicate = await this.prisma.adminUser.findUnique({ where: { email: input.email } });
    if (duplicate) {
      throw new ValidationException('An admin with this email already exists', [
        { field: 'email', message: 'already in use' },
      ]);
    }

    const tempPassword = generateTempPassword();
    const admin = await this.prisma.adminUser.create({
      data: {
        id: uuidv7(),
        email: input.email,
        name: input.name,
        passwordHash: hashPassword(tempPassword),
        role: input.role,
        status: 'active',
        mustChangePassword: true,
      },
    });

    await this.audit.record(actor, {
      actionType: 'create-admin',
      action: `${actor.name} created ${input.role} admin ${admin.name} (${admin.email})`,
      targetType: 'AdminUser',
      targetId: admin.id,
      after: { email: admin.email, name: admin.name, role: admin.role, status: admin.status },
    });
    return { admin: this.toView(admin), tempPassword };
  }

  /** POST /admin/admin-users/:id/disable - self-disable refused; revokes the target's live sessions. */
  async disable(actor: AdminPrincipal, id: string): Promise<AdminUserView> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundAppException('Admin not found');
    if (admin.id === actor.adminId) {
      throw new ValidationException('You cannot disable your own account');
    }

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: { status: 'disabled' },
    });
    await this.prisma.adminRefreshToken.updateMany({
      where: { adminUserId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record(actor, {
      actionType: 'disable-admin',
      action: `${actor.name} disabled admin ${admin.name} (${admin.email})`,
      targetType: 'AdminUser',
      targetId: admin.id,
      before: { status: admin.status },
      after: { status: 'disabled' },
    });
    return this.toView(updated);
  }

  /** POST /admin/admin-users/:id/enable */
  async enable(actor: AdminPrincipal, id: string): Promise<AdminUserView> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundAppException('Admin not found');

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: { status: 'active' },
    });

    await this.audit.record(actor, {
      actionType: 'enable-admin',
      action: `${actor.name} enabled admin ${admin.name} (${admin.email})`,
      targetType: 'AdminUser',
      targetId: admin.id,
      before: { status: admin.status },
      after: { status: 'active' },
    });
    return this.toView(updated);
  }

  /**
   * DELETE /admin/admin-users/:id - revoke-invite analog: hard delete permitted ONLY
   * for never-activated accounts (lastLoginAt null); activated accounts must be
   * disabled instead, preserving audit-log actor referential integrity.
   */
  async remove(actor: AdminPrincipal, id: string): Promise<{ ok: true }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundAppException('Admin not found');
    if (admin.lastLoginAt !== null) {
      throw new ValidationException('This admin has signed in at least once; disable instead');
    }

    await this.prisma.adminRefreshToken.deleteMany({ where: { adminUserId: id } });
    await this.prisma.adminUser.delete({ where: { id } });

    await this.audit.record(actor, {
      actionType: 'revoke-admin',
      action: `${actor.name} removed never-activated admin ${admin.name} (${admin.email})`,
      targetType: 'AdminUser',
      targetId: admin.id,
      before: { email: admin.email, name: admin.name, role: admin.role },
    });
    return { ok: true };
  }

  // --- internals -----------------------------------------------------------

  private toView(admin: AdminUser): AdminUserView {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role as AdminRole,
      status: admin.status as 'active' | 'disabled',
      pendingFirstLogin: admin.mustChangePassword && admin.lastLoginAt === null,
      lastActiveAt: admin.lastActiveAt ? admin.lastActiveAt.toISOString() : null,
    };
  }
}
