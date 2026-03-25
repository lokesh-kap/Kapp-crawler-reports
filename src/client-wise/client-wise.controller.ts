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
import { ClientWiseService } from './client-wise.service';
import { CreateClientWiseDto } from './dto/create-client-wise.dto';
import { UpdateClientWiseDto } from './dto/update-client-wise.dto';
import { CreateClientWiseFromProviderDto } from './dto/create-from-provider.dto';
import { UpsertClientWiseScraperConfigDto } from './dto/upsert-client-wise-scraper-config.dto';

@Controller('client-wise')
export class ClientWiseController {
  constructor(private readonly clientWiseService: ClientWiseService) {}

  @Post()
  create(@Body() createClientWiseDto: CreateClientWiseDto) {
    return this.clientWiseService.create(createClientWiseDto);
  }

  @Post('from-provider')
  createFromProvider(
    @Body() createClientWiseFromProviderDto: CreateClientWiseFromProviderDto,
  ) {
    return this.clientWiseService.createFromProvider(
      createClientWiseFromProviderDto,
    );
  }

  @Get()
  findAll() {
    return this.clientWiseService.findAll();
  }

  @Get('client/:clientId/year/:year')
  findByClientAndYear(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.clientWiseService.findByClientAndYear(clientId, year);
  }

  @Get('client/:clientId/year/:year/config/:configId')
  findByClientYearAndConfigId(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('year', ParseIntPipe) year: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.clientWiseService.findByClientYearAndConfigId(
      clientId,
      year,
      configId,
    );
  }

  @Get('leads-config/client/:clientId/year/:year/config/:configId')
  getLeadsConfig(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('year', ParseIntPipe) year: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.clientWiseService.getLeadsConfig(clientId, year, configId);
  }

  @Post('leads-config')
  upsertLeadsConfig(@Body() payload: UpsertClientWiseScraperConfigDto) {
    return this.clientWiseService.upsertLeadsConfig(payload);
  }

  @Get('summary-config/client/:clientId/year/:year/config/:configId')
  getSummaryConfig(
    @Param('clientId', ParseIntPipe) clientId: number,
    @Param('year', ParseIntPipe) year: number,
    @Param('configId', ParseIntPipe) configId: number,
  ) {
    return this.clientWiseService.getSummaryConfig(clientId, year, configId);
  }

  @Post('summary-config')
  upsertSummaryConfig(@Body() payload: UpsertClientWiseScraperConfigDto) {
    return this.clientWiseService.upsertSummaryConfig(payload);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.clientWiseService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateClientWiseDto: UpdateClientWiseDto,
  ) {
    return this.clientWiseService.update(id, updateClientWiseDto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.clientWiseService.remove(id);
  }
}
