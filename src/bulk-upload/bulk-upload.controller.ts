import { Body, Controller, Post } from '@nestjs/common';
import { BulkUploadService } from './bulk-upload.service';
import { BulkUploadRequestDto } from './dto/bulk-upload.dto';

@Controller('bulk-upload')
export class BulkUploadController {
  constructor(private readonly bulkUploadService: BulkUploadService) {}

  @Post('client-wise')
  upsertClientWise(@Body() body: any) {
    return this.bulkUploadService.upsertClientWiseFromBulk(
      body as BulkUploadRequestDto,
    );
  }
}
