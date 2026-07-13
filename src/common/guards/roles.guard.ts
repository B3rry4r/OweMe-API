import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthUser, Role } from '../../shared';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ForbiddenAppException, UnauthenticatedException } from '../exceptions/app.exception';

/** Enforces @Roles(). owner passes any role gate; staff only where explicitly allowed. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    if (!user) throw new UnauthenticatedException();

    // owner has full access to any role-gated route.
    if (user.role === 'owner') return true;
    if (required.includes(user.role)) return true;

    throw new ForbiddenAppException('Your role cannot perform this action');
  }
}
