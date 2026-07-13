import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYSTACK_GATEWAY,
  PaystackGateway,
  ValidationException,
  NotFoundAppException,
} from '../common';
import {
  Bank,
  PayoutAccount,
  ResolvePayoutAccountDto,
  UpdatePayoutAccountDto,
} from '../shared';

/**
 * PayoutAccount — Paystack platform-merchant model. One subaccount per business, built
 * server-side from (bankCode, accountNumber, accountName) only; nothing else stored.
 * All external calls go through the injected PAYSTACK_GATEWAY (never a hardcoded credential).
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaystackGateway,
  ) {}

  /** GET /banks — proxy Paystack's bank list. */
  async listBanks(): Promise<Bank[]> {
    const banks = await this.paystack.listBanks();
    return banks.map((b) => ({ code: b.code, name: b.name }));
  }

  /** POST /payout-account/resolve — Paystack name lookup; invalid account -> error envelope. */
  async resolve(dto: ResolvePayoutAccountDto): Promise<{ accountName: string }> {
    try {
      const { accountName } = await this.paystack.resolveAccount(dto.bankCode, dto.accountNumber);
      return { accountName };
    } catch {
      throw new ValidationException('Could not resolve account with the provided bank/number');
    }
  }

  /** GET /payout-account — the business's payout account, or null. */
  async get(businessId: string): Promise<PayoutAccount | null> {
    const row = await this.prisma.payoutAccount.findUnique({ where: { businessId } });
    return row ? this.toShape(row) : null;
  }

  /**
   * PUT /payout-account — creates/updates the business's Paystack subaccount from the 3 fields,
   * stores them, and writes Business.paystackSubaccount. Nothing else is persisted.
   */
  async upsert(businessId: string, dto: UpdatePayoutAccountDto): Promise<PayoutAccount> {
    const business = await this.prisma.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new NotFoundAppException('Business not found');
    }

    const { subaccountCode } = await this.paystack.createSubaccount({
      businessName: business.businessName,
      bankCode: dto.bankCode,
      accountNumber: dto.accountNumber,
    });

    const row = await this.prisma.payoutAccount.upsert({
      where: { businessId },
      create: {
        businessId,
        bankCode: dto.bankCode,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
      },
      update: {
        bankCode: dto.bankCode,
        accountNumber: dto.accountNumber,
        accountName: dto.accountName,
      },
    });

    await this.prisma.business.update({
      where: { id: businessId },
      data: { paystackSubaccount: subaccountCode },
    });

    return this.toShape(row);
  }

  private toShape(row: {
    businessId: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
  }): PayoutAccount {
    return {
      businessId: row.businessId,
      bankCode: row.bankCode,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
    };
  }
}
