import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap(): Promise<void> {
  // rawBody: true so webhook signature verification (Paystack HMAC) can hash exact bytes.
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });

  // Global validation: strip unknown props, reject extras, transform payloads to DTO instances.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // The ONE error envelope filter.
  app.useGlobalFilters(new HttpExceptionFilter());

  // CORS exists for the admin dashboard, which is a browser client on its own
  // origin. The mobile app is a native HTTP client and is unaffected either way.
  // ADMIN_DASHBOARD_ORIGINS is a comma-separated allow-list; when unset only
  // local development origins are permitted, never a wildcard.
  const origins = (process.env.ADMIN_DASHBOARD_ORIGINS ?? 'http://localhost:3100')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'If-Match'],
    credentials: false,
    maxAge: 600,
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
