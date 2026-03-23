import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormFillerService } from './form-filler.service';
import { HandlePaginationService } from './handle-pagination.service';
import { PlaywrightService } from './playwright.service';
import { ScrapingDataService } from './scraping-data.service';
import { ScrapperService } from './scrapper.service';

@Module({
  imports: [TypeOrmModule.forFeature([])],
  providers: [
    ScrapperService,
    PlaywrightService,
    FormFillerService,
    ScrapingDataService,
    HandlePaginationService,
  ],
  exports: [
    ScrapperService,
    PlaywrightService,
    FormFillerService,
    ScrapingDataService,
    HandlePaginationService,
  ],
})
export class ScrapperModule {}