import { Injectable, Logger } from '@nestjs/common';

/** OtpSender — sole impl is BulkSMSNigeria (gateway:'otp'); Termii can replace it later. FROZEN interface. */
export interface OtpSender {
  /** Deliver a one-time code to a phone number. */
  sendOtp(phone: string, code: string): Promise<void>;
}

/** Default stub — logs instead of sending (no external calls in dev/tests). */
@Injectable()
export class StubOtpSender implements OtpSender {
  private readonly logger = new Logger(StubOtpSender.name);

  async sendOtp(phone: string, code: string): Promise<void> {
    this.logger.log(`[stub] OTP for ${phone}: ${code}`);
  }
}
