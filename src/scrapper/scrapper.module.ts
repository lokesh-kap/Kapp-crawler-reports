import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormFillerService } from './form-filler.service';
import { HandlePaginationService } from './handle-pagination.service';
import { PlaywrightService } from './playwright.service';
import { ScrapingDataService } from './scraping-data.service';
import { ScrapperService } from './scrapper.service';
import { ScrapperController } from './scrapper.controller';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseStepEntity } from '../client-wise/entities/client-wise-step.entity';
import { ClientWiseLeadsDataEntity } from './entities/client-wise-leads-data.entity';
import { ClientWiseSummaryDataEntity } from './entities/client-wise-summary-data.entity';
import { ExtractionConfigModule } from '../extraction-config/extraction-config.module';
import { DynamicExtractionService } from './dynamic-extraction.service';
import { ScrapeSchedulerService } from './scrape-scheduler.service';

@Module({
  imports: [
    ExtractionConfigModule,
    TypeOrmModule.forFeature([
      ClientWiseEntity,
      ClientWiseLeadsConfigEntity,
      ClientWiseSummaryConfigEntity,
      ClientWiseStepEntity,
      ClientWiseLeadsDataEntity,
      ClientWiseSummaryDataEntity,
    ]),
  ],
  providers: [
    ScrapperService,
    PlaywrightService,
    FormFillerService,
    ScrapingDataService,
    HandlePaginationService,
    DynamicExtractionService,
    ScrapeSchedulerService,
  ],
  controllers: [ScrapperController],
  exports: [
    ScrapperService,
    PlaywrightService,
    FormFillerService,
    ScrapingDataService,
    HandlePaginationService,
    DynamicExtractionService,
  ],
})
export class ScrapperModule {}