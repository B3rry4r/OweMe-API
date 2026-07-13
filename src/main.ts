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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
