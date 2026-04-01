import { Module } from '@nestjs/common';
import { BulkUploadController } from './bulk-upload.controller';
import { BulkUploadService } from './bulk-upload.service';
import { ProviderConfigModule } from '../provider-config/provider-config.module';
import { ClientWiseModule } from '../client-wise/client-wise.module';

@Module({
  imports: [ProviderConfigModule, ClientWiseModule],
  controllers: [BulkUploadController],
  providers: [BulkUploadService],
})
export class BulkUploadModule {}
