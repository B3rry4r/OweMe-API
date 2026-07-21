import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PAYSTACK_GATEWAY, PaystackGateway } from '../../common';
import { PrismaService } from '../../prisma/prisma.service';
import { PAGINATION_DEFAULT_LIMIT } from '../../shared';
import { PayoutAccountsQueryDto } from './dto/admin-payouts.dto';
import { AdminPayoutAccountView, AdminPayoutStatsView, Paged } from './admin-payouts.views';

/**
 * Payout-account monitor reads (registry AdminPayoutsView). READ-ONLY: the app's
 * PayoutAccount write path (resolve/upsert + Paystack subaccount creation) is
 * protected surface and is never touched from here.
 *
 * Two deliberate behaviours from the registry design notes:
 *  - The NUBAN is masked SERVER-side ('****' + last 4). The full account number
 *    never crosses the admin boundary, fixing the dashboard fragment's
 *    client-side-masking defect.
 *  - Settlement figures are null (partial-honest-empty ruling): settlement lives
 *    provider-side and no source exists in v1, so the cards ship HONEST-EMPTY
 *    rather than showing a fabricated zero.
 */
@Injectable()
export class AdminPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYSTACK_GATEWAY) private readonly paystack: PaystackGateway,
  ) {}

  /** GET /admin/payouts/accounts - offset-paged, empty-table graceful. */
  async accounts(query: PayoutAccountsQueryDto): Promise<Paged<AdminPayoutAccountView>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? PAGINATION_DEFAULT_LIMIT;
    const search = query.search?.trim();

    // One bank-list fetch per request: it both resolves bankName and lets the
    // search term match a bank by NAME even though only the code is stored.
    const bankNameByCode = await this.bankNames();

    let where: Prisma.PayoutAccountWhereInput = {};
    if (search) {
      const matchedCodes = [...bankNameByCode.entries()]
        .filter(([, name]) => name.toLowerCase().includes(search.toLowerCase()))
        .map(([code]) => code);
      where = {
        OR: [
          { business: { businessName: { contains: search } } },
          { accountName: { contains: search } },
          ...(matchedCodes.length > 0 ? [{ bankCode: { in: matchedCodes } }] : []),
        ],
      };
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payoutAccount.count({ where }),
      this.prisma.payoutAccount.findMany({
        where,
        include: { business: { select: { businessName: true, paystackSubaccount: true } } },
        // PayoutAccount has no timestamp (one row per business), so the table is
        // ordered by business name; businessId breaks ties deterministically.
        orderBy: [{ business: { businessName: 'asc' } }, { businessId: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: rows.map((row) => ({
        businessId: row.businessId,
        businessName: row.business.businessName,
        bankName: bankNameByCode.get(row.bankCode) ?? row.bankCode,
        nubanMasked: this.maskNuban(row.accountNumber),
        accountName: row.accountName,
        subaccountActive: row.business.paystackSubaccount !== null,
        settledMonthKobo: null,
        settledTotalKobo: null,
        pendingSettlements: null,
        lastSettlementAt: null,
      })),
      page,
      total,
    };
  }

  /** GET /admin/payouts/stats - real counts; settlement figures honest-null. */
  async stats(): Promise<AdminPayoutStatsView> {
    const [payoutAccountsSetUpCount, activeSubaccountCount] = await this.prisma.$transaction([
      this.prisma.payoutAccount.count(),
      this.prisma.business.count({ where: { paystackSubaccount: { not: null } } }),
    ]);

    return {
      payoutAccountsSetUpCount,
      activeSubaccountCount,
      settledToTradersMonthKobo: null,
      pendingSettlementsTotal: null,
      failedAccountResolutionCount: null,
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * The same bank list the live GET /banks serves, keyed by code. A provider
   * outage must not take the monitor table down, so a failed lookup degrades to
   * an empty map and rows fall back to showing the raw bankCode.
   */
  private async bankNames(): Promise<Map<string, string>> {
    try {
      const banks = await this.paystack.listBanks();
      return new Map(banks.map((b) => [b.code, b.name]));
    } catch {
      return new Map();
    }
  }

  /** '****' + last 4 digits; short/blank numbers are never widened past what is stored. */
  private maskNuban(accountNumber: string): string {
    return `****${accountNumber.slice(-4)}`;
  }
}
