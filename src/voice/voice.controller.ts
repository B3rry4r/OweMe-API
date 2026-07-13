import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Roles, BusinessId, VoiceParseOutput } from '@common';
import { VoiceParseDto } from '@shared';
import { VoiceService } from './voice.service';

/**
 * POST /voice/parse — transcript -> structured debt {customerName, amount(kobo), description,
 * dueDate}. owner|staff, tenant-scoped. Debits 1 AI credit on success (403 PLAN_REQUIRED when
 * exhausted). The audio-upload path is not built (501) and is intentionally not exposed here.
 */
@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('parse')
  @HttpCode(200)
  @Roles('owner', 'staff')
  parse(
    @BusinessId() businessId: string,
    @Body() dto: VoiceParseDto,
  ): Promise<VoiceParseOutput> {
    return this.voice.parse(businessId, dto);
  }
}
