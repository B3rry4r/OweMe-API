import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/** Staff (team members) feature module. Register in app.module: `StaffModule`. */
@Module({
  imports: [PrismaModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
