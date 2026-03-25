import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ProviderConfigService } from './provider-config.service';
import { CreateProviderConfigDto } from './dto/create-provider-config.dto';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';
import { UpsertProviderScraperConfigDto } from './dto/upsert-provider-scraper-config.dto';

@Controller('provider-config')
export class ProviderConfigController {
  constructor(private readonly providerConfigService: ProviderConfigService) {}

  @Post()
  create(@Body() createProviderConfigDto: CreateProviderConfigDto) {
    return this.providerConfigService.create(createProviderConfigDto);
  }

  @Get()
  findAll() {
    return this.providerConfigService.findAll();
  }

  @Get('options/list')
  providerOptions() {
    return this.providerConfigService.providerOptions();
  }

  @Get('config/:configId')
  findByConfigId(@Param('configId', ParseIntPipe) configId: number) {
    return this.providerConfigService.findByConfigId(configId);
  }

  @Get('leads-config/config/:configId')
  getLeadsConfigByConfigId(@Param('configId', ParseIntPipe) configId: number) {
    return this.providerConfigService.getLeadsConfigByConfigId(configId);
  }

  @Post('leads-config')
  upsertLeadsConfig(@Body() payload: UpsertProviderScraperConfigDto) {
    return this.providerConfigService.upsertLeadsConfig(payload);
  }

  @Get('summary-config/config/:configId')
  getSummaryConfigByConfigId(@Param('configId', ParseIntPipe) configId: number) {
    return this.providerConfigService.getSummaryConfigByConfigId(configId);
  }

  @Post('summary-config')
  upsertSummaryConfig(@Body() payload: UpsertProviderScraperConfigDto) {
    return this.providerConfigService.upsertSummaryConfig(payload);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.providerConfigService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateProviderConfigDto: UpdateProviderConfigDto,
  ) {
    return this.providerConfigService.update(id, updateProviderConfigDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.providerConfigService.remove(id);
  }
}