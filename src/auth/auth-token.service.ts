import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../shared';
import { uuidv7 } from '../common';

/**
 * Signs/verifies the JWT access + refresh pair.
 *
 * Access-token claims are EXACTLY what @common's JwtStrategy expects:
 *   { sub: staff.id, businessId, role }  signed with JWT_ACCESS_SECRET.
 * Refresh tokens are signed with JWT_REFRESH_SECRET and carry a unique `jti` so every
 * issued token hashes distinctly (rotation + reuse detection rely on that uniqueness).
 * Secret fallbacks match the JwtStrategy fallback so dev/test stay consistent.
 */
export interface TokenSubject {
  id: string;
  businessId: string;
  role: Role;
}

@Injectable()
export class AuthTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private accessSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET') ?? 'dev-access-secret-change-me';
  }

  private refreshSecret(): string {
    return this.config.get<string>('JWT_REFRESH_SECRET') ?? 'dev-refresh-secret-change-me';
  }

  signAccess(subject: TokenSubject): Promise<string> {
    return this.jwt.signAsync(
      { sub: subject.id, businessId: subject.businessId, role: subject.role },
      { secret: this.accessSecret(), expiresIn: '15m' },
    );
  }

  signRefresh(subject: TokenSubject): Promise<string> {
    return this.jwt.signAsync(
      { sub: subject.id, businessId: subject.businessId, role: subject.role, jti: uuidv7() },
      { secret: this.refreshSecret(), expiresIn: '30d' },
    );
  }

  verifyRefresh(token: string): Promise<{ sub: string; businessId: string; role: Role }> {
    return this.jwt.verifyAsync(token, { secret: this.refreshSecret() });
  }
}
