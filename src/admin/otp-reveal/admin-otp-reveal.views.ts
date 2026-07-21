/** Registry AdminOtpReveal response DTO, verbatim. */

export interface AdminOtpRevealView {
  /** The 6-digit plaintext code from otp_test_codes, TEST businesses only. */
  code: string;
  /** Whole seconds left on the code at the moment of the reveal (always > 0). */
  expiresInSeconds: number;
}
