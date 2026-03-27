import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ExtractionConfigService } from './extraction-config.service';
import { CreateConfigTableDto } from './dto/create-config-table.dto';
import { CreateConfigTableFieldDto } from './dto/create-config-table-field.dto';

@Controller('config')
export class ExtractionConfigController {
  constructor(private readonly extractionConfigService: ExtractionConfigService) {}

  @Post('table')
  createTable(@Body() payload: CreateConfigTableDto) {
    return this.extractionConfigService.createTable(payload);
  }

  @Patch('table/:id')
  updateTable(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: Partial<CreateConfigTableDto>,
  ) {
    return this.extractionConfigService.updateTable(id, payload);
  }

  @Post('table-fields')
  createTableField(@Body() payload: CreateConfigTableFieldDto) {
    return this.extractionConfigService.createTableField(payload);
  }

  @Post('table-fields/:tableId/bulk')
  upsertTableFields(
    @Param('tableId', ParseIntPipe) tableId: number,
    @Body() payload: { fields?: Array<Record<string, unknown>> },
  ) {
    const fields = Array.isArray(payload?.fields) ? payload.fields : [];
    return this.extractionConfigService.upsertTableFields(tableId, fields);
  }

  @Get('table/:configId')
  getTable(
    @Param('configId', ParseIntPipe) configId: number,
    @Query('config_type') configType?: 'leads' | 'summary',
  ) {
    return this.extractionConfigService.getTableByConfigId(configId, configType);
  }

  @Get('table-fields/:tableId')
  getTableFields(@Param('tableId', ParseIntPipe) tableId: number) {
    return this.extractionConfigService.getFieldsByTableId(tableId);
  }
}

