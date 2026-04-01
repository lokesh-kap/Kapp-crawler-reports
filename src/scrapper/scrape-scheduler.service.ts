import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ScrapperService } from './scrapper.service';

/**
 * Nest `@Cron` uses 6 fields: second minute hour day-of-month month day-of-week.
 * Evaluated when the module loads (after `dotenv.config()` in `app.module.ts`).
 */
export function buildLeadsCronExpression(): string {
  const hour = Number(process.env.SCRAPER_DAILY_CRON_HOUR ?? 1);
  const minute = Number(process.env.SCRAPER_DAILY_CRON_MINUTE ?? 0);
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 1;
  const m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  return `0 ${m} ${h} * * *`;
}

/** Summary run defaults to N minutes after leads (same hour rollover). Set `SCRAPER_DAILY_SUMMARY_OFFSET_MINUTES=0` to align with leads (both fire same minute). */
export function buildSummaryCronExpression(): string {
  const hour = Number(process.env.SCRAPER_DAILY_CRON_HOUR ?? 1);
  const minute = Number(process.env.SCRAPER_DAILY_CRON_MINUTE ?? 0);
  const offset = Number(process.env.SCRAPER_DAILY_SUMMARY_OFFSET_MINUTES ?? 5);
  const off = Number.isFinite(offset) ? Math.max(0, offset) : 5;
  let h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 1;
  let m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  m += off;
  while (m >= 60) {
    m -= 60;
    h = (h + 1) % 24;
  }
  return `0 ${m} ${h} * * *`;
}

@Injectable()
export class ScrapeSchedulerService {
  private readonly logger = new Logger(ScrapeSchedulerService.name);
  private lastLeadsDateKey: string | null = null;
  private lastSummaryDateKey: string | null = null;
  private leadsRunning = false;
  private summaryRunning = false;

  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ClientWiseLeadsConfigEntity)
    private readonly leadsConfigRepository: Repository<ClientWiseLeadsConfigEntity>,
    @InjectRepository(ClientWiseSummaryConfigEntity)
    private readonly summaryConfigRepository: Repository<ClientWiseSummaryConfigEntity>,
    private readonly scrapperService: ScrapperService,
  ) {}

  private getEnvBool(name: string, defaultValue: boolean): boolean {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return defaultValue;
  }

  private getDateKey(now: Date): string {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  @Cron(buildLeadsCronExpression(), { name: 'daily-leads-scrape' })
  async handleCronLeads(): Promise<void> {
    if (!this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true)) {
      return;
    }
    const now = new Date();
    const dateKey = this.getDateKey(now);
    if (this.lastLeadsDateKey === dateKey || this.leadsRunning) {
      return;
    }
    this.lastLeadsDateKey = dateKey;
    this.leadsRunning = true;
    try {
      await this.runDailyLeadsScrape('cron');
    } catch (err) {
      this.logger.error(
        'Scheduled leads scrape failed',
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.leadsRunning = false;
    }
  }

  @Cron(buildSummaryCronExpression(), { name: 'daily-summary-scrape' })
  async handleCronSummary(): Promise<void> {
    if (!this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true)) {
      return;
    }
    const now = new Date();
    const dateKey = this.getDateKey(now);
    if (this.lastSummaryDateKey === dateKey || this.summaryRunning) {
      return;
    }
    this.lastSummaryDateKey = dateKey;
    this.summaryRunning = true;
    try {
      await this.runDailySummaryScrape('cron');
    } catch (err) {
      this.logger.error(
        'Scheduled summary scrape failed',
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.summaryRunning = false;
    }
  }

  /** Manual / controller trigger — ignores once-per-day guard. */
  async triggerLeadsScrapeNow(): Promise<void> {
    this.logger.log('Manual trigger: daily leads scrape for all active client-wise configs');
    await this.runDailyLeadsScrape('manual');
  }

  async triggerSummaryScrapeNow(): Promise<void> {
    this.logger.log('Manual trigger: daily summary scrape for all active client-wise configs');
    await this.runDailySummaryScrape('manual');
  }

  private async getActiveRows(): Promise<ClientWiseEntity[]> {
    return this.clientWiseRepository.find({
      where: {
        is_active: true,
        config_id: Not(IsNull()),
      },
      order: { id: 'ASC' },
    });
  }

  private async runDailyLeadsScrape(trigger: 'cron' | 'manual'): Promise<void> {
    this.logger.log(`Starting ${trigger} leads scrape run`);

    const rows = await this.getActiveRows();
    this.logger.log(`Leads ${trigger}: active client-wise rows=${rows.length}`);

    for (const row of rows) {
      const leadsConfig = await this.leadsConfigRepository.findOne({
        where: { client_wise_id: row.id, is_active: true },
      });
      if (!leadsConfig) continue;

      try {
        this.logger.log(
          `Leads ${trigger}: client_wise_id=${row.id} client_id=${row.client_id} year=${row.year} config_id=${row.config_id}`,
        );
        await this.scrapperService.scrapeLeads({ client_wise_id: row.id } as any);
      } catch (err) {
        this.logger.error(
          `Leads ${trigger} failed for client_wise_id=${row.id}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    this.logger.log(`Leads ${trigger} run finished`);
  }

  private async runDailySummaryScrape(trigger: 'cron' | 'manual'): Promise<void> {
    this.logger.log(`Starting ${trigger} summary scrape run`);

    const rows = await this.getActiveRows();
    this.logger.log(`Summary ${trigger}: active client-wise rows=${rows.length}`);

    for (const row of rows) {
      const summaryConfig = await this.summaryConfigRepository.findOne({
        where: { client_wise_id: row.id, is_active: true },
      });
      if (!summaryConfig) continue;

      try {
        this.logger.log(
          `Summary ${trigger}: client_wise_id=${row.id} client_id=${row.client_id} year=${row.year} config_id=${row.config_id}`,
        );
        await this.scrapperService.scrapeSummary({ client_wise_id: row.id } as any);
      } catch (err) {
        this.logger.error(
          `Summary ${trigger} failed for client_wise_id=${row.id}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    this.logger.log(`Summary ${trigger} run finished`);
  }
}
