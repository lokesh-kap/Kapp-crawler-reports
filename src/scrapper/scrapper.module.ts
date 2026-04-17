import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormFillerService } from './form-filler.service';
import { HandlePaginationService } from './handle-pagination.service';
import { PlaywrightService } from './playwright.service';
import { ReportsModule } from '../reports/reports.module';
import { ScrapingDataService } from './scraping-data.service';
import { ScrapperService } from './scrapper.service';
import { ScrapperController } from './scrapper.controller';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseStepEntity } from '../client-wise/entities/client-wise-step.entity';
import { ClientWiseLeadsDataEntity } from './entities/client-wise-leads-data.entity';
import { ClientWiseSummaryDataEntity } from './entities/client-wise-summary-data.entity';
import { NpfFunnelSummaryEntity } from './entities/npf-funnel-summary.entity';
import { ExtractionConfigModule } from '../extraction-config/extraction-config.module';
import { DynamicExtractionService } from './dynamic-extraction.service';
import { ScrapeSchedulerService } from './scrape-scheduler.service';
import { ScraperScheduleLeadsController } from './scraper-schedule-leads.controller';
import { ScraperScheduleSummaryController } from './scraper-schedule-summary.controller';
import { ScraperScheduleNpfFunnelController } from './scraper-schedule-npf-funnel.controller';

@Module({
  imports: [
    ExtractionConfigModule,
    ReportsModule,
    TypeOrmModule.forFeature([
      ClientWiseEntity,
      ClientWiseLeadsConfigEntity,
      ClientWiseSummaryConfigEntity,
      ClientWiseStepEntity,
      ClientWiseLeadsDataEntity,
      ClientWiseSummaryDataEntity,
      NpfFunnelSummaryEntity,
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
  controllers: [
    ScrapperController,
    ScraperScheduleLeadsController,
    ScraperScheduleSummaryController,
    ScraperScheduleNpfFunnelController,
  ],
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