import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenAppException, UnauthenticatedException } from '../../common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminPrincipal, AdminRole } from './admin-principal';
import { AdminTokenService } from './admin-token.service';
import { ALLOW_PENDING_PASSWORD_KEY } from './allow-pending-password.decorator';

/**
 * Bearer guard for the ADMIN surface. Applied controller-level on /admin routes
 * (which are @Public() to the GLOBAL user JwtAuthGuard: user tokens never validate
 * here, admin tokens never validate there - cross-rejection is contract-tested).
 *
 * Beyond signature/iss/aud verification the guard re-reads the AdminUser row every
 * request, so a disabled admin loses access immediately (not at token expiry), and
 * enforces the mustChangePassword lockout: 403 on every admin route except the
 * @AllowPendingPassword() pair (auth/me + auth/change-password).
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AdminTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown>; admin?: AdminPrincipal }>();

    const header = req.headers['authorization'];
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthenticatedException();

    let claims;
    try {
      claims = await this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthenticatedException();
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: claims.sub } });
    if (!admin || admin.status !== 'active') throw new UnauthenticatedException();

    if (admin.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) {
        throw new ForbiddenAppException('Change your temporary password before continuing');
      }
    }

    req.admin = {
      adminId: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role as AdminRole,
      mustChangePassword: admin.mustChangePassword,
      sessionId: claims.sid,
    };
    return true;
  }
}
