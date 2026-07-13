import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as unauthenticated (skips JwtAuthGuard). e.g. /auth/request-otp. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
