/**
 * OweMe shared contracts — the ONE source of truth every build agent imports.
 * Import from '@shared' (or relative 'src/shared'). Do not re-declare these shapes.
 */
export * from './enums';
export * from './common';
export * from './entities';

// DTOs (class-validator request payloads)
export * from './dto/pagination.dto';
export * from './dto/auth.dto';
export * from './dto/business.dto';
export * from './dto/staff.dto';
export * from './dto/customer.dto';
export * from './dto/debt.dto';
export * from './dto/payment.dto';
export * from './dto/reminder.dto';
export * from './dto/notification-preferences.dto';
export * from './dto/payout-account.dto';
export * from './dto/billing.dto';
export * from './dto/voice.dto';
export * from './dto/sync.dto';
