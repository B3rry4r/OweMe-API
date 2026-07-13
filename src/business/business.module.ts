import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BusinessController } from './business.controller';
import { BusinessService } from './business.service';

/** Business (tenant profile) feature module. Register in app.module: `BusinessModule`. */
@Module({
  imports: [PrismaModule],
  controllers: [BusinessController],
  providers: [BusinessService],
})
export class BusinessModule {}
