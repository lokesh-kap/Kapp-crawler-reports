import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProviderConfigService } from './provider-config.service';
import { ProviderConfigController } from './provider-config.controller';
import { ProviderConfigEntity } from './entitites/provider-config.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProviderConfigEntity])],
  providers: [ProviderConfigService],
  controllers: [ProviderConfigController],
  exports: [ProviderConfigService],
})
export class ProviderConfigModule {}