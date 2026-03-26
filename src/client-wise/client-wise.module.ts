import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientWiseController } from './client-wise.controller';
import { ClientWiseService } from './client-wise.service';
import { ClientWiseEntity } from './entities/client-wise.entity';
import { ProviderConfigEntity } from '../provider-config/entitites/provider-config.entity';
import { ClientWiseLeadsConfigEntity } from './entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from './entities/client-wise-summary-config.entity';
import { ClientWiseStepEntity } from './entities/client-wise-step.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ClientWiseEntity,
      ProviderConfigEntity,
      ClientWiseLeadsConfigEntity,
      ClientWiseSummaryConfigEntity,
      ClientWiseStepEntity,
    ]),
  ],
  controllers: [ClientWiseController],
  providers: [ClientWiseService],
  exports: [ClientWiseService],
})
export class ClientWiseModule {}
