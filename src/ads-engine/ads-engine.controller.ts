import { Controller, Post, Body, UploadedFile, UseInterceptors, Get, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AdsEngineService } from './ads-engine.service';
import { AdsMappingService } from './ads-mapping.service';
import { AttributionService } from './attribution.service';
import { CreateAdsCredentialDto } from './dto/create-ads-credential.dto';
import { parse } from 'csv-parse/sync';

@Controller('ads-engine')
export class AdsEngineController {
  constructor(
    private readonly adsEngineService: AdsEngineService,
    private readonly adsMappingService: AdsMappingService,
    private readonly attributionService: AttributionService,
  ) {}

  @Post('credentials')
  async createCredential(@Body() dto: CreateAdsCredentialDto) {
    return this.adsEngineService.createCredential(dto);
  }

  @Post('sync')
  async sync(@Query('fullHistory') fullHistory: string) {
    const isFullHistory = fullHistory === 'true';
    
    // Run in background to prevent HTTP timeout
    this.adsEngineService.syncAll(isFullHistory);
    
    return { 
      message: 'Ads synchronization started in background', 
      fullHistory: isFullHistory 
    };
  }

  @Post('sync-attribution')
  async syncAttribution() {
    return this.attributionService.syncAttribution();
  }

  @Post('upload-mapping')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMapping(
    @UploadedFile() file: Express.Multer.File,
    @Body('clientId') clientId: number,
  ) {
    const records = parse(file.buffer, {
      columns: true,
      skip_empty_lines: true,
    });

    const mappings = records.map((r: any) => ({
      mediumCode: r.mediumCode,
      clientId: Number(clientId),
      campaignInfoId: r.campaignInfoId ? Number(r.campaignInfoId) : undefined,
      notes: r.notes,
    }));

    return this.adsMappingService.bulkUpsert(mappings);
  }

  @Get('resolve')
  async resolve(
    @Query('campaignCode') campaignCode: string,
    @Query('clientId') clientId: number,
  ) {
    return this.adsMappingService.resolveFromCampaignCode(campaignCode, Number(clientId));
  }
}
