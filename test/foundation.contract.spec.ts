import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Foundation smoke contract: proves the scaffold boots, the global error envelope
 * renders, and the seeded plan catalog is present on the fresh test DB. Build-agent
 * contract specs follow this same bootstrap pattern.
 */
describe('Foundation (contract)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('renders the ErrorEnvelope for an unknown route (NOT_FOUND)', async () => {
    const res = await request(app.getHttpServer()).get('/__does_not_exist__');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
  });

  it('seeded exactly the 4 canonical plans with kobo money + limits', async () => {
    const plans = await prisma.plan.findMany({ orderBy: { pricePerMonth: 'asc' } });
    expect(plans.map((p) => p.id).sort()).toEqual(['business', 'enterprise', 'market', 'starter']);

    const starter = plans.find((p) => p.id === 'starter')!;
    expect(starter.pricePerMonth).toBe(0);
    expect(starter.sendsPerMonth).toBe(10);
    expect(starter.aiCreditsPerMonth).toBe(10);
    expect(starter.staffSeats).toBe(0);
    expect(starter.bvumCeiling).toBe(200_000_000); // ₦2M in kobo

    const business = plans.find((p) => p.id === 'business')!;
    expect(business.pricePerMonth).toBe(600_000); // ₦6,000 in kobo
    expect(business.bvumCeiling).toBe(2_000_000_000); // ₦20M in kobo

    const enterprise = plans.find((p) => p.id === 'enterprise')!;
    expect(enterprise.talkToSales).toBe(true);
    expect(enterprise.bvumCeiling).toBeNull();
    expect(enterprise.sendsPerMonth).toBe(-1);
  });
});
