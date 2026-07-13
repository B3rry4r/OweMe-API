import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PayoutAccountController } from './payout-account.controller';
import { PayoutAccountService } from './payout-account.service';

/** PayoutAccount (Paystack) feature module. Register in app.module: `PayoutAccountModule`. */
@Module({
  imports: [PrismaModule],
  controllers: [PayoutAccountController],
  providers: [PayoutAccountService],
})
export class PayoutAccountModule {}
