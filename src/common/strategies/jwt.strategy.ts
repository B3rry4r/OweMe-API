import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser, Role } from '../../shared';

interface AccessTokenClaims {
  sub: string;
  businessId: string | null;
  role: Role;
}

/** Bearer JWT access-token strategy. Claims: sub=userId, businessId (tenant), role. */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev-access-secret-change-me',
    });
  }

  /** Return value becomes request.user (the AuthUser principal). */
  validate(payload: AccessTokenClaims): AuthUser {
    return {
      userId: payload.sub,
      businessId: payload.businessId ?? null,
      role: payload.role,
    };
  }
}
