import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokenService } from './auth-token.service';

/**
 * Auth (phone + OTP) feature module. Register in app.module: `AuthModule`.
 * Consumes @common's JwtModule/JwtStrategy (global) + the OTP_SENDER stub token.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, AuthTokenService],
})
export class AuthModule {}
