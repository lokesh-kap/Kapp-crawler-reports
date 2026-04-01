import { Controller, Post } from '@nestjs/common';
import { ScrapeSchedulerService } from './scrape-scheduler.service';

/**
 * Manual entry point for the same work as the `@Cron` leads job.
 * POST body not required; optional auth can be added later.
 */
@Controller('scraper/schedule/leads')
export class ScraperScheduleLeadsController {
  constructor(private readonly scrapeSchedulerService: ScrapeSchedulerService) {}

  @Post('run')
  async runLeadsNow() {
    await this.scrapeSchedulerService.triggerLeadsScrapeNow();
    return {
      ok: true,
      message: 'Leads scrape triggered for all active client-wise configs (same logic as daily cron).',
    };
  }
}
