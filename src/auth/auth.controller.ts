import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { AuthSession, MeResponse, RefreshDto, RequestOtpDto, VerifyOtpDto } from '../shared';
import { CurrentUser, Public, Roles } from '../common';
import { AuthService } from './auth.service';

/**
 * Auth — phone + OTP login. Public request/verify/refresh; bearer-gated logout.
 *   POST /auth/request-otp -> ALWAYS 202 {} (no account enumeration).
 *   POST /auth/verify-otp  -> 200 { accessToken, refreshToken, user, business }.
 *   POST /auth/refresh     -> 200 { accessToken, refreshToken } (rotation + reuse detection).
 *   POST /auth/logout      -> 204 (revokes the caller's refresh token).
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-otp')
  @Public()
  @HttpCode(202)
  async requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string): Promise<Record<string, never>> {
    await this.auth.requestOtp(dto.phone, ip);
    return {};
  }

  @Post('verify-otp')
  @Public()
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<AuthSession> {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto): Promise<{ accessToken: string; refreshToken: string }> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @Roles('owner', 'staff')
  @HttpCode(204)
  logout(@CurrentUser('userId') userId: string): Promise<void> {
    return this.auth.logout(userId);
  }
}

/**
 * Session bootstrap. Lives on the root path (`GET /me`, per the registry) so it is a
 * separate controller from the `/auth`-prefixed surface.
 */
@Controller()
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  @Roles('owner', 'staff')
  me(@CurrentUser('userId') userId: string): Promise<MeResponse> {
    return this.auth.me(userId);
  }
}
