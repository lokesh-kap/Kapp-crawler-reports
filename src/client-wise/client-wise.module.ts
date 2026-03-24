import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientWiseController } from './client-wise.controller';
import { ClientWiseService } from './client-wise.service';
import { ClientWiseEntity } from './entities/client-wise.entity';
import { ProviderConfigEntity } from '../provider-config/entitites/provider-config.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ClientWiseEntity, ProviderConfigEntity])],
  controllers: [ClientWiseController],
  providers: [ClientWiseService],
  exports: [ClientWiseService],
})
export class ClientWiseModule {}
