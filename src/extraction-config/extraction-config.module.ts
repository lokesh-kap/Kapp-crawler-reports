import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigTableEntity } from './entities/config-table.entity';
import { ConfigTableFieldEntity } from './entities/config-table-field.entity';
import { ExtractionConfigController } from './extraction-config.controller';
import { ExtractionConfigService } from './extraction-config.service';

@Module({
  imports: [TypeOrmModule.forFeature([ConfigTableEntity, ConfigTableFieldEntity])],
  providers: [ExtractionConfigService],
  controllers: [ExtractionConfigController],
  exports: [ExtractionConfigService, TypeOrmModule],
})
export class ExtractionConfigModule {}

