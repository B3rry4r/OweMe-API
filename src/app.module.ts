import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { BusinessModule } from './business/business.module';
import { PlansModule } from './plans/plans.module';
import { StaffModule } from './staff/staff.module';
import { UsageModule } from './usage/usage.module';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { NotificationPreferencesModule } from './notification-preferences/notification-preferences.module';
import { PayoutAccountModule } from './payout-account/payout-account.module';
import { BillingModule } from './billing/billing.module';
import { VoiceModule } from './voice/voice.module';
import { InsightsModule } from './insights/insights.module';
import { DebtsModule } from './debts/debts.module';
import { PaymentsModule } from './payments/payments.module';
import { RemindersModule } from './reminders/reminders.module';
import { BvumModule } from './bvum/bvum.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ActivityModule } from './activity/activity.module';
import { SyncModule } from './sync/sync.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    ScheduleModule.forRoot(), // cron transport for the reminder delivery worker

    // ── FEATURE MODULES (added per build wave) ──────────────────────────────
    // Wave 1:
    BusinessModule,
    PlansModule,
    // Wave 2:
    StaffModule,
    UsageModule,
    // Wave 3:
    AuthModule,
    CustomersModule,
    NotificationsModule,
    NotificationPreferencesModule,
    PayoutAccountModule,
    BillingModule,
    VoiceModule,
    InsightsModule,
    // Wave 4:
    DebtsModule,
    // Wave 5:
    PaymentsModule,
    RemindersModule,
    BvumModule,
    // Wave 6:
    DashboardModule,
    ActivityModule,
    SyncModule,
    WebhooksModule,
    // Admin surface (all /admin/* resources aggregate inside AdminModule):
    AdminModule,
    // ────────────────────────────────────────────────────────────────────────
  ],
  providers: [
    // Global auth + role enforcement. Routes opt out with @Public(); gate with @Roles().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
