/** Shared infrastructure barrel — build agents import guards/decorators/helpers/providers from '@common'. */
export * from './common.module';

// Filters + exceptions
export * from './filters/http-exception.filter';
export * from './exceptions/app.exception';

// Decorators
export * from './decorators/roles.decorator';
export * from './decorators/public.decorator';
export * from './decorators/current-user.decorator';
export * from './decorators/entitlements.decorator';

// Guards + strategy
export * from './guards/jwt-auth.guard';
export * from './guards/roles.guard';
export * from './guards/entitlements.guard';
export * from './strategies/jwt.strategy';

// Tenancy + concurrency helpers
export * from './tenancy/tenant';
export * from './concurrency/version';

// Utils
export * from './utils/money';
export * from './utils/phone';
export * from './utils/uuid';

// Provider interfaces + DI tokens + stubs
export * from './providers/tokens';
export * from './providers/otp-sender';
export * from './providers/message-sender';
export * from './providers/paystack-gateway';
export * from './providers/receipt-verifier';
export * from './providers/llm-provider';
