import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthSession, Business, MeResponse, Staff } from '../shared';
import {
  OTP_SENDER,
  OtpSender,
  RateLimitedException,
  UnauthenticatedException,
  uuidv7,
} from '../common';
import { AuthTokenService, TokenSubject } from './auth-token.service';
import { generateOtp, hashOtpCode, hashToken, verifyOtpCode } from './auth.crypto';

const OTP_TTL_MS = 10 * 60 * 1000; // 10-minute expiry
const OTP_MAX_ATTEMPTS = 5; // per code
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// request-otp throttle (silent — response is ALWAYS 202, no enumeration).
const REQUEST_WINDOW_MS = 60 * 1000;
const REQUEST_MAX_PER_PHONE = 30; // per rolling minute
const REQUEST_MAX_PER_IP = 120; // per rolling minute

/**
 * Auth service — phone + OTP login, JWT access/refresh with rotation + reuse detection.
 *
 * Contract invariants (conventions.md Auth model):
 *  - request-otp ALWAYS resolves 202 regardless of account existence (no enumeration).
 *  - OTP codes hashed at rest, 10-min expiry, max 5 attempts, rate-limited per phone + IP.
 *  - verify-otp on an unknown phone backs the Staff row with a placeholder Business + owner
 *    Staff (Staff.businessId is non-null by schema, so businessId is always populated).
 *  - refresh rotates the pair; reusing a revoked token revokes the whole chain -> 401.
 */
@Injectable()
export class AuthService {
  private readonly phoneHits = new Map<string, number[]>();
  private readonly ipHits = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokenService,
    @Inject(OTP_SENDER) private readonly otpSender: OtpSender,
  ) {}

  /** POST /auth/request-otp — always 202. Generates a hashed 6-digit code + sends it (unless throttled). */
  async requestOtp(phone: string, ip: string): Promise<void> {
    if (this.isThrottled(phone, ip)) return; // silent: still 202, no enumeration

    const code = generateOtp();
    await this.prisma.otpCode.create({
      data: {
        id: uuidv7(),
        phone,
        codeHash: hashOtpCode(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        attempts: 0,
      },
    });
    await this.otpSender.sendOtp(phone, code);
  }

  /** POST /auth/verify-otp — validate latest code, then issue a session. */
  async verifyOtp(phone: string, code: string): Promise<AuthSession> {
    const record = await this.prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) throw new UnauthenticatedException('Invalid or expired code');

    // Too many attempts on this code -> rate-limited (429).
    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      throw new RateLimitedException('Too many verification attempts');
    }
    // Expired -> unauthenticated (401).
    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthenticatedException('Invalid or expired code');
    }
    // Wrong code -> count the attempt, then 401.
    if (!verifyOtpCode(code, record.codeHash)) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthenticatedException('Invalid or expired code');
    }

    // Success: consume every outstanding code for this phone.
    await this.prisma.otpCode.deleteMany({ where: { phone } });

    const { staff, business } = await this.resolveAccount(phone);
    const { accessToken, refreshToken } = await this.issuePair(staff, null);
    return { accessToken, refreshToken, user: staff as unknown as Staff, business };
  }

  /** POST /auth/refresh — verify + ROTATE (issue new pair, revoke old; reuse -> revoke chain + 401). */
  async refresh(token: string): Promise<{ accessToken: string; refreshToken: string }> {
    try {
      await this.tokens.verifyRefresh(token);
    } catch {
      throw new UnauthenticatedException('Invalid refresh token');
    }

    const stored = await this.prisma.refreshToken.findFirst({
      where: { tokenHash: hashToken(token) },
    });
    if (!stored) throw new UnauthenticatedException('Invalid refresh token');

    // Reuse of an already-rotated/revoked token: revoke the whole live chain for this user.
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthenticatedException('Refresh token reuse detected');
    }
    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthenticatedException('Expired refresh token');
    }

    const staff = await this.prisma.staff.findUnique({ where: { id: stored.userId } });
    if (!staff) throw new UnauthenticatedException('Invalid refresh token');

    // Rotate: revoke the presented token, then mint a new pair linked via rotatedFrom.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issuePair(staff as unknown as TokenSubject, stored.id);
  }

  /** POST /auth/logout — revoke the caller's live refresh token(s). */
  async logout(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** GET /me — session bootstrap for the bearer token. */
  async me(userId: string): Promise<MeResponse> {
    const staff = await this.prisma.staff.findUnique({ where: { id: userId } });
    if (!staff) throw new UnauthenticatedException();
    const business = await this.prisma.business.findUnique({ where: { id: staff.businessId } });
    return { user: staff as unknown as Staff, business: business as unknown as Business | null };
  }

  // --- internals -----------------------------------------------------------

  /** Existing phone -> its Staff + Business; unknown phone -> placeholder Business + owner Staff. */
  private async resolveAccount(
    phone: string,
  ): Promise<{ staff: TokenSubject & Record<string, unknown>; business: Business | null }> {
    const existing = await this.prisma.staff.findFirst({
      where: { phone },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      const business = await this.prisma.business.findUnique({
        where: { id: existing.businessId },
      });
      return {
        staff: existing as unknown as TokenSubject & Record<string, unknown>,
        business: business as unknown as Business | null,
      };
    }

    // Unknown phone: mint a placeholder tenant + its owner so businessId is always backed.
    const businessId = uuidv7();
    const business = await this.prisma.business.create({
      data: {
        id: businessId,
        businessName: '',
        ownerName: '',
        phone,
        category: '',
        currency: 'NGN (₦)',
        reminderTone: 'gentle',
        plan: 'starter',
      },
    });
    const staff = await this.prisma.staff.create({
      data: {
        id: uuidv7(),
        businessId,
        name: `Owner · ${phone}`,
        phone,
        role: 'owner',
        active: true,
      },
    });
    return {
      staff: staff as unknown as TokenSubject & Record<string, unknown>,
      business: business as unknown as Business,
    };
  }

  /** Sign a fresh access+refresh pair and persist the hashed refresh token. */
  private async issuePair(
    subject: TokenSubject,
    rotatedFrom: string | null,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = await this.tokens.signAccess(subject);
    const refreshToken = await this.tokens.signRefresh(subject);
    await this.prisma.refreshToken.create({
      data: {
        id: uuidv7(),
        userId: subject.id,
        tokenHash: hashToken(refreshToken),
        rotatedFrom,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return { accessToken, refreshToken };
  }

  /** Sliding-window throttle per phone AND per IP. Never surfaces (request-otp is always 202). */
  private isThrottled(phone: string, ip: string): boolean {
    const now = Date.now();
    const phoneOver = this.bump(this.phoneHits, phone, now, REQUEST_MAX_PER_PHONE);
    const ipOver = this.bump(this.ipHits, ip || 'unknown', now, REQUEST_MAX_PER_IP);
    return phoneOver || ipOver;
  }

  private bump(store: Map<string, number[]>, key: string, now: number, max: number): boolean {
    const recent = (store.get(key) ?? []).filter((t) => now - t < REQUEST_WINDOW_MS);
    if (recent.length >= max) {
      store.set(key, recent);
      return true;
    }
    recent.push(now);
    store.set(key, recent);
    return false;
  }
}
