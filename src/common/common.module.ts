import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { EntitlementsGuard } from './guards/entitlements.guard';

import {
  OTP_SENDER,
  MESSAGE_SENDER,
  PAYSTACK_GATEWAY,
  RECEIPT_VERIFIER,
  LLM_PROVIDER,
} from './providers/tokens';
import { OtpSender, StubOtpSender } from './providers/otp-sender';
import { MessageSender, StubMessageSender } from './providers/message-sender';
import { PaystackGateway, StubPaystackGateway } from './providers/paystack-gateway';
import { ReceiptVerifier, StubReceiptVerifier } from './providers/receipt-verifier';
import { LlmProvider, StubLlmProvider } from './providers/llm-provider';

// Real provider implementations (see each file for the verified provider docs).
import { BulkSmsOtpSender } from './providers/impl/bulksms-otp-sender';
import { BulkSmsMessageSender } from './providers/impl/bulksms-message-sender';
import { PaystackGatewayHttp } from './providers/impl/paystack-gateway.http';
import { FlutterwaveGateway } from './providers/impl/flutterwave-gateway';
import { IapReceiptVerifier } from './providers/impl/iap-receipt-verifier';
import {
  GeminiLlmProvider,
  DEFAULT_GEMINI_MODEL,
} from './providers/impl/gemini-llm-provider';

// Env-driven selection: a real provider is used when its credentials are
// present, otherwise the deterministic stub (which keeps contract tests and
// keyless dev running). This is the ONLY place real-vs-stub is decided.
function otpSenderFactory(cfg: ConfigService): OtpSender {
  const token = cfg.get<string>('BULKSMS_API_TOKEN');
  if (!token) return new StubOtpSender();
  return new BulkSmsOtpSender(token, cfg.get<string>('BULKSMS_SENDER_ID') ?? 'OweMe');
}

function messageSenderFactory(cfg: ConfigService): MessageSender {
  const token = cfg.get<string>('BULKSMS_API_TOKEN');
  if (!token) return new StubMessageSender();
  return new BulkSmsMessageSender(token, cfg.get<string>('BULKSMS_SENDER_ID') ?? 'OweMe');
}

// PAYMENT_PROVIDER selects the payment backend (both implement PaystackGateway):
// 'flutterwave' uses Flutterwave, anything else (default) uses Paystack. Falls
// back to the stub when the selected provider's key is absent.
function paymentGatewayFactory(cfg: ConfigService): PaystackGateway {
  const provider = (cfg.get<string>('PAYMENT_PROVIDER') ?? 'paystack').toLowerCase();
  if (provider === 'flutterwave') {
    const key = cfg.get<string>('FLUTTERWAVE_SECRET_KEY');
    if (key) {
      return new FlutterwaveGateway(
        key,
        cfg.get<string>('FLUTTERWAVE_WEBHOOK_SECRET_HASH') ?? '',
      );
    }
    return new StubPaystackGateway();
  }
  const key = cfg.get<string>('PAYSTACK_SECRET_KEY');
  return key ? new PaystackGatewayHttp(key) : new StubPaystackGateway();
}

function receiptVerifierFactory(cfg: ConfigService): ReceiptVerifier {
  const apple = cfg.get<string>('APPLE_IAP_SHARED_SECRET');
  const google = cfg.get<string>('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON');
  if (!apple && !google) return new StubReceiptVerifier();
  return new IapReceiptVerifier(
    apple ?? '',
    google ?? '',
    cfg.get<string>('GOOGLE_PLAY_PACKAGE_NAME') ?? '',
  );
}

function llmProviderFactory(cfg: ConfigService): LlmProvider {
  const key =
    cfg.get<string>('GEMINI_API_KEY') ?? cfg.get<string>('LLM_PROVIDER_API_KEY');
  if (!key) return new StubLlmProvider();
  return new GeminiLlmProvider(
    key,
    cfg.get<string>('GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL,
  );
}

/**
 * Shared infrastructure module (guards, JWT strategy, provider stubs). Global so every
 * feature module gets the guards + provider tokens without re-importing. Build agents
 * CONSUME these; they do not edit this module. app.module imports PrismaModule + CommonModule only.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PassportModule,
    JwtModule.register({}),
  ],
  providers: [
    JwtStrategy,
    JwtAuthGuard,
    RolesGuard,
    EntitlementsGuard,
    { provide: OTP_SENDER, useFactory: otpSenderFactory, inject: [ConfigService] },
    { provide: MESSAGE_SENDER, useFactory: messageSenderFactory, inject: [ConfigService] },
    { provide: PAYSTACK_GATEWAY, useFactory: paymentGatewayFactory, inject: [ConfigService] },
    { provide: RECEIPT_VERIFIER, useFactory: receiptVerifierFactory, inject: [ConfigService] },
    { provide: LLM_PROVIDER, useFactory: llmProviderFactory, inject: [ConfigService] },
  ],
  exports: [
    JwtModule,
    PassportModule,
    JwtAuthGuard,
    RolesGuard,
    EntitlementsGuard,
    OTP_SENDER,
    MESSAGE_SENDER,
    PAYSTACK_GATEWAY,
    RECEIPT_VERIFIER,
    LLM_PROVIDER,
  ],
})
export class CommonModule {}
