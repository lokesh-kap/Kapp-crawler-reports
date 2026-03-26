import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProviderConfigService } from './provider-config.service';
import { ProviderConfigController } from './provider-config.controller';
import { ProviderConfigEntity } from './entitites/provider-config.entity';
import { ProviderLeadsConfigEntity } from './entitites/provider-leads-config.entity';
import { ProviderSummaryConfigEntity } from './entitites/provider-summary-config.entity';
import { ProviderStepEntity } from './entitites/provider-step.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ProviderConfigEntity,
      ProviderLeadsConfigEntity,
      ProviderSummaryConfigEntity,
      ProviderStepEntity,
    ]),
  ],
  providers: [ProviderConfigService],
  controllers: [ProviderConfigController],
  exports: [ProviderConfigService],
})
export class ProviderConfigModule {}