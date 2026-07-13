import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../../shared';
import { ForbiddenAppException } from '../exceptions/app.exception';

/**
 * Resolve the caller's tenant (businessId) from the JWT principal. Every domain query
 * must be scoped to this. Throws FORBIDDEN if the caller has no business yet
 * (e.g. a freshly-created user before onboarding PUT /business).
 */
export function requireBusinessId(user: AuthUser | undefined): string {
  if (!user?.businessId) {
    throw new ForbiddenAppException('No business context for this user');
  }
  return user.businessId;
}

/** @BusinessId() -> the tenant id from the JWT (throws FORBIDDEN if absent). */
export const BusinessId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
  return requireBusinessId(req.user);
});
