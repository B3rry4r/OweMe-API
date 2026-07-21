import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { uuidv7 } from '../../common';
import { AdminRole } from './admin-principal';

/**
 * Signs/verifies the ADMIN JWT access + refresh pair. Fully separate from the user
 * flow: distinct env secrets (ADMIN_JWT_SECRET / ADMIN_JWT_REFRESH_SECRET), distinct
 * iss/aud claims, distinct claim shape. Cross-rejection with the user tokens is a
 * contract-tested invariant, both directions.
 *
 * Access-token claims: { sub: adminUser.id, role, sid } where sid is the id of the
 * live admin_refresh_tokens row of this session leg (change-password uses it to
 * revoke every OTHER live session). Refresh tokens carry a unique jti so every
 * issued token hashes distinctly (rotation + reuse detection rely on that).
 *
 * SECRETS: no insecure dev fallback. Missing env in production mode throws AT BOOT
 * (this service is instantiated with the AdminModule). Outside production a
 * clearly-marked TEST-ONLY fallback keeps keyless spec boots working, consistent
 * with how test/setenv.ts boots the user-auth specs.
 */

export const ADMIN_JWT_ISSUER = 'oweme-admin';
export const ADMIN_JWT_AUDIENCE = 'admin-dashboard';

// TEST-ONLY fallbacks. Never reachable in production: the constructor throws first.
// Distinct from the user-auth test secrets so cross-rejection holds in specs too.
const TEST_ONLY_ACCESS_SECRET = 'test-only-admin-access-secret';
const TEST_ONLY_REFRESH_SECRET = 'test-only-admin-refresh-secret';

export interface AdminTokenSubject {
  adminId: string;
  role: AdminRole;
  /** admin_refresh_tokens row id of the session leg being signed. */
  sessionId: string;
}

export interface AdminAccessClaims {
  sub: string;
  role: AdminRole;
  sid: string;
}

@Injectable()
export class AdminTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    if (process.env.NODE_ENV === 'production') {
      const missing = ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET'].filter(
        (key) => !this.config.get<string>(key),
      );
      if (missing.length > 0) {
        throw new Error(
          `Admin auth cannot boot in production without ${missing.join(', ')} set in the environment`,
        );
      }
    }
  }

  private accessSecret(): string {
    return this.config.get<string>('ADMIN_JWT_SECRET') ?? TEST_ONLY_ACCESS_SECRET;
  }

  private refreshSecret(): string {
    return this.config.get<string>('ADMIN_JWT_REFRESH_SECRET') ?? TEST_ONLY_REFRESH_SECRET;
  }

  signAccess(subject: AdminTokenSubject): Promise<string> {
    return this.jwt.signAsync(
      { sub: subject.adminId, role: subject.role, sid: subject.sessionId },
      {
        secret: this.accessSecret(),
        expiresIn: '15m',
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      },
    );
  }

  signRefresh(subject: AdminTokenSubject): Promise<string> {
    return this.jwt.signAsync(
      { sub: subject.adminId, role: subject.role, sid: subject.sessionId, jti: uuidv7() },
      {
        secret: this.refreshSecret(),
        expiresIn: '30d',
        issuer: ADMIN_JWT_ISSUER,
        audience: ADMIN_JWT_AUDIENCE,
      },
    );
  }

  /** Throws on any invalid/expired/foreign token (wrong secret, iss or aud). */
  verifyAccess(token: string): Promise<AdminAccessClaims> {
    return this.jwt.verifyAsync<AdminAccessClaims>(token, {
      secret: this.accessSecret(),
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
    });
  }

  verifyRefresh(token: string): Promise<AdminAccessClaims> {
    return this.jwt.verifyAsync<AdminAccessClaims>(token, {
      secret: this.refreshSecret(),
      issuer: ADMIN_JWT_ISSUER,
      audience: ADMIN_JWT_AUDIENCE,
    });
  }
}
