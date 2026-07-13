import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/** Customers (debtor roster) feature module. Register in app.module: `CustomersModule`. */
@Module({
  imports: [PrismaModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
