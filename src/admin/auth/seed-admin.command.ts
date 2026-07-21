import { PrismaClient } from '@prisma/client';
import { uuidv7 } from '../../common';
import { hashPassword } from '../common';

/**
 * Seed command for the FIRST superadmin (admin registry adminAuth.seed). Env-driven:
 * ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, ADMIN_SEED_NAME. REFUSES if any AdminUser
 * already exists; further admins are created via POST /admin/admin-users.
 *
 * Run: npx ts-node src/admin/auth/seed-admin.command.ts
 *
 * The seeded account keeps mustChangePassword=false: the password is owner-chosen
 * via env, not a server-generated temp password.
 */

const REQUIRED_VARS = ['ADMIN_SEED_EMAIL', 'ADMIN_SEED_PASSWORD', 'ADMIN_SEED_NAME'] as const;

export interface SeededAdmin {
  id: string;
  email: string;
  name: string;
  role: string;
}

export async function seedFirstAdmin(
  prisma: PrismaClient,
  env: Record<string, string | undefined> = process.env,
): Promise<SeededAdmin> {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const existing = await prisma.adminUser.count();
  if (existing > 0) {
    throw new Error(
      `Refusing to seed: ${existing} AdminUser row(s) already exist. Create further admins via POST /admin/admin-users.`,
    );
  }

  const admin = await prisma.adminUser.create({
    data: {
      id: uuidv7(),
      email: env.ADMIN_SEED_EMAIL as string,
      name: env.ADMIN_SEED_NAME as string,
      passwordHash: hashPassword(env.ADMIN_SEED_PASSWORD as string),
      role: 'superadmin',
      status: 'active',
      mustChangePassword: false,
    },
  });
  return { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
}

/* istanbul ignore next: CLI entrypoint, exercised manually */
if (require.main === module) {
  const prisma = new PrismaClient();
  seedFirstAdmin(prisma)
    .then((admin) => {
      console.log(`Seeded superadmin ${admin.email} (${admin.id})`);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
