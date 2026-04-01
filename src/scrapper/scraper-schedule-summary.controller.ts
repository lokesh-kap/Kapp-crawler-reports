import { Controller, Post } from '@nestjs/common';
import { ScrapeSchedulerService } from './scrape-scheduler.service';

/**
 * Manual entry point for the same work as the `@Cron` summary job.
 */
@Controller('scraper/schedule/summary')
export class ScraperScheduleSummaryController {
  constructor(private readonly scrapeSchedulerService: ScrapeSchedulerService) {}

  @Post('run')
  async runSummaryNow() {
    await this.scrapeSchedulerService.triggerSummaryScrapeNow();
    return {
      ok: true,
      message: 'Summary scrape triggered for all active client-wise configs (same logic as daily cron).',
    };
  }
}
