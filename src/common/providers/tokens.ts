/**
 * Injectable DI tokens for the frozen provider interfaces. Inject with @Inject(TOKEN).
 * Default stub implementations are bound in CommonModule; contract tests / real impls override them.
 */
export const OTP_SENDER = Symbol('OTP_SENDER');
export const MESSAGE_SENDER = Symbol('MESSAGE_SENDER');
export const PAYSTACK_GATEWAY = Symbol('PAYSTACK_GATEWAY');
export const RECEIPT_VERIFIER = Symbol('RECEIPT_VERIFIER');
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
