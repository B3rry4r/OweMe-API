import { Injectable } from '@nestjs/common';
import type { AdminUser } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UnauthenticatedException, uuidv7 } from '../../common';
import {
  AdminPrincipal,
  AdminRole,
  AdminTokenService,
  hashAdminToken,
  hashPassword,
  verifyPassword,
} from '../common';
import { AdminAuditService } from '../audit/admin-audit.service';
import { AdminSelfView, AdminSessionView } from './admin-auth.views';

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, mirroring the live token idiom

/**
 * Admin auth: email + password login, JWT access/refresh with rotation + reuse
 * detection mirroring the live RefreshToken semantics but entirely on
 * admin_users/admin_refresh_tokens with distinct secrets and iss/aud claims.
 *
 * Contract invariants (admin registry AdminAuth block):
 *  - Bad credentials and disabled accounts are rejected identically (no enumeration).
 *  - Login stamps lastLoginAt/lastActiveAt and audit-logs 'login'.
 *  - Refresh rotates the pair; reusing a rotated/revoked token revokes the admin's
 *    whole live chain -> 401.
 *  - change-password clears mustChangePassword and revokes every OTHER live session
 *    (all admin_refresh_tokens rows except the caller's own session leg).
 */
@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AdminTokenService,
    private readonly audit: AdminAuditService,
  ) {}

  /** POST /admin/auth/login */
  async login(email: string, password: string): Promise<AdminSessionView> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    // Disabled admins are rejected identically to bad credentials (no enumeration).
    if (!admin || !verifyPassword(password, admin.passwordHash) || admin.status !== 'active') {
      throw new UnauthenticatedException('Invalid email or password');
    }

    const now = new Date();
    const stamped = await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: now, lastActiveAt: now },
    });

    const session = await this.issuePair(stamped, null);
    await this.audit.record(
      { adminId: stamped.id, name: stamped.name, role: stamped.role as AdminRole },
      { actionType: 'login', action: `${stamped.name} signed in to the admin dashboard` },
    );
    return session;
  }

  /** POST /admin/auth/refresh - verify + ROTATE (reuse -> revoke chain + 401). */
  async refresh(token: string): Promise<AdminSessionView> {
    try {
      await this.tokens.verifyRefresh(token);
    } catch {
      throw new UnauthenticatedException('Invalid refresh token');
    }

    const stored = await this.prisma.adminRefreshToken.findFirst({
      where: { tokenHash: hashAdminToken(token) },
    });
    if (!stored) throw new UnauthenticatedException('Invalid refresh token');

    // Reuse of an already-rotated/revoked token: revoke the whole live chain.
    if (stored.revokedAt) {
      await this.prisma.adminRefreshToken.updateMany({
        where: { adminUserId: stored.adminUserId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthenticatedException('Refresh token reuse detected');
    }
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthenticatedException('Expired refresh token');
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: stored.adminUserId } });
    if (!admin || admin.status !== 'active') {
      throw new UnauthenticatedException('Invalid refresh token');
    }

    // Rotate: revoke the presented token, then mint a new leg linked via rotatedFrom.
    await this.prisma.adminRefreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issuePair(admin, stored.id);
  }

  /** GET /admin/auth/me */
  async me(adminId: string): Promise<AdminSelfView> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthenticatedException();
    return this.toSelfView(admin);
  }

  /** POST /admin/auth/change-password */
  async changePassword(
    principal: AdminPrincipal,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: principal.adminId } });
    if (!admin || !verifyPassword(currentPassword, admin.passwordHash)) {
      throw new UnauthenticatedException('Current password is incorrect');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: hashPassword(newPassword), mustChangePassword: false },
    });
    // Revoke every OTHER live session; the caller's own leg (sid claim) stays valid.
    await this.prisma.adminRefreshToken.updateMany({
      where: { adminUserId: admin.id, revokedAt: null, id: { not: principal.sessionId } },
      data: { revokedAt: new Date() },
    });

    await this.audit.record(
      { adminId: admin.id, name: admin.name, role: admin.role as AdminRole },
      { actionType: 'change-password', action: `${admin.name} changed their admin password` },
    );
    return { ok: true };
  }

  // --- internals -----------------------------------------------------------

  /** Sign a fresh access+refresh pair; the refresh row id doubles as the session id (sid claim). */
  private async issuePair(admin: AdminUser, rotatedFrom: string | null): Promise<AdminSessionView> {
    const sessionId = uuidv7();
    const subject = { adminId: admin.id, role: admin.role as AdminRole, sessionId };
    const accessToken = await this.tokens.signAccess(subject);
    const refreshToken = await this.tokens.signRefresh(subject);
    await this.prisma.adminRefreshToken.create({
      data: {
        id: sessionId,
        adminUserId: admin.id,
        tokenHash: hashAdminToken(refreshToken),
        rotatedFrom,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken, refreshToken, admin: this.toSelfView(admin) };
  }

  private toSelfView(admin: AdminUser): AdminSelfView {
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role as AdminRole,
      org: 'OweMe',
      mustChangePassword: admin.mustChangePassword,
    };
  }
}
