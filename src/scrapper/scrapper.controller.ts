import { Body, Controller, Post } from '@nestjs/common';
import { ScrapperService } from './scrapper.service';
import { ScrapeTargetDto } from './dto/scrape-target.dto';

@Controller('scrapper')
export class ScrapperController {
  constructor(private readonly scrapperService: ScrapperService) {}

  @Post('leads')
  scrapeLeads(@Body() dto: ScrapeTargetDto) {
    return this.scrapperService.scrapeLeads(dto);
  }

  @Post('summary')
  scrapeSummary(@Body() dto: ScrapeTargetDto) {
    return this.scrapperService.scrapeSummary(dto);
  }
}

