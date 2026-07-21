import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminPrincipal } from './admin-principal';

/**
 * @CurrentAdmin() -> the admin principal attached by AdminJwtGuard (request.admin).
 * @CurrentAdmin('adminId') -> a single field.
 */
export const CurrentAdmin = createParamDecorator(
  (data: keyof AdminPrincipal | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ admin?: AdminPrincipal }>();
    const admin = req.admin;
    return data && admin ? admin[data] : admin;
  },
);
