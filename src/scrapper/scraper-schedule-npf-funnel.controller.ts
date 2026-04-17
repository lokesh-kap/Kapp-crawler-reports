import { Controller, Logger, Post } from '@nestjs/common';
import { ScrapeSchedulerService } from './scrape-scheduler.service';

/**
 * Manual entry point for the same work as the `@Cron` npf funnel job.
 */
@Controller('scraper/schedule/npf-funnel')
export class ScraperScheduleNpfFunnelController {
  private readonly logger = new Logger(ScraperScheduleNpfFunnelController.name);

  constructor(private readonly scrapeSchedulerService: ScrapeSchedulerService) { }

  @Post('run')
  async runNpfFunnelNow() {
    // Fire-and-forget so API responds immediately instead of blocking until
    // full scrape + report generation completes.
    void this.scrapeSchedulerService.triggerNpfFunnelScrapeNow().catch((err) => {
      this.logger.error(
        'Manual NPF run failed after async trigger',
        err instanceof Error ? err.stack : String(err),
      );
    });
    return {
      ok: true,
      message:
        'NPF Funnel scrape started in background for all active client-wise configs (same logic as daily cron).',
    };
  }

  @Post('retry-warnings')
  async runNpfFunnelRetryNow() {
    await this.scrapeSchedulerService.triggerNpfFunnelWarningRetryNow();
    return {
      ok: true,
      message: 'NPF Funnel warning retry triggered for latest CSV.',
    };
  }
}
