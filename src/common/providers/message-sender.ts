import { Injectable, Logger } from '@nestjs/common';

export interface SendMessageInput {
  phone: string;
  message: string;
  channel: 'sms' | 'whatsapp';
}

export interface SendMessageResult {
  providerMessageId: string;
  accepted: boolean;
}

/** MessageSender — reminder delivery (BulkSMSNigeria, shared sender ID "INFINITI"). FROZEN interface. */
export interface MessageSender {
  send(input: SendMessageInput): Promise<SendMessageResult>;
}

/** Default stub — logs instead of sending. */
@Injectable()
export class StubMessageSender implements MessageSender {
  private readonly logger = new Logger(StubMessageSender.name);

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    this.logger.log(`[stub] ${input.channel} to ${input.phone}: ${input.message}`);
    return { providerMessageId: `stub-${Date.now()}`, accepted: true };
  }
}
