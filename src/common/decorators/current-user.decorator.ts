import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../../shared';

/**
 * @CurrentUser() -> the JWT principal { userId, businessId, role }.
 * @CurrentUser('businessId') -> a single claim.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    return data && user ? user[data] : user;
  },
);
