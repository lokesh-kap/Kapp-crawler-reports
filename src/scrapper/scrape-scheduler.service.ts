import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ScrapperService } from './scrapper.service';

@Injectable()
export class ScrapeSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapeSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastRunDateKey: string | null = null;
  private isRunning = false;

  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ClientWiseLeadsConfigEntity)
    private readonly leadsConfigRepository: Repository<ClientWiseLeadsConfigEntity>,
    @InjectRepository(ClientWiseSummaryConfigEntity)
    private readonly summaryConfigRepository: Repository<ClientWiseSummaryConfigEntity>,
    private readonly scrapperService: ScrapperService,
  ) {}

  onModuleInit() {
    if (!this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true)) {
      this.logger.warn('Daily scraper scheduler is disabled by env');
      return;
    }

    // Poll every 30s and trigger once at configured hour/minute.
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.logger.log('Daily scraper scheduler initialized');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getEnvBool(name: string, defaultValue: boolean): boolean {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return defaultValue;
  }

  private getEnvInt(name: string, defaultValue: number): number {
    const raw = (process.env[name] ?? '').trim();
    if (!raw) return defaultValue;
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultValue;
  }

  private getDateKey(now: Date): string {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private async tick() {
    const now = new Date();
    const runHour = this.getEnvInt('SCRAPER_DAILY_CRON_HOUR', 1);
    const runMinute = this.getEnvInt('SCRAPER_DAILY_CRON_MINUTE', 0);
    const dateKey = this.getDateKey(now);

    if (now.getHours() !== runHour || now.getMinutes() !== runMinute) return;
    if (this.lastRunDateKey === dateKey || this.isRunning) return;

    this.lastRunDateKey = dateKey;
    this.isRunning = true;
    try {
      await this.runDailyScrapes();
    } catch (err) {
      this.logger.error(
        'Daily scheduled scraping failed',
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isRunning = false;
    }
  }

  private async runDailyScrapes() {
    this.logger.log('Starting daily scheduled scrape run (leads + summary)');

    const rows = await this.clientWiseRepository.find({
      where: {
        is_active: true,
        config_id: Not(IsNull()),
      },
      order: { id: 'ASC' },
    });

    this.logger.log(`Daily schedule: active client-wise rows=${rows.length}`);

    for (const row of rows) {
      const [leadsConfig, summaryConfig] = await Promise.all([
        this.leadsConfigRepository.findOne({
          where: { client_wise_id: row.id, is_active: true },
        }),
        this.summaryConfigRepository.findOne({
          where: { client_wise_id: row.id, is_active: true },
        }),
      ]);

      if (leadsConfig) {
        try {
          this.logger.log(
            `Daily schedule: scrape leads for client_wise_id=${row.id} client_id=${row.client_id} year=${row.year} config_id=${row.config_id}`,
          );
          await this.scrapperService.scrapeLeads({ client_wise_id: row.id } as any);
        } catch (err) {
          this.logger.error(
            `Daily schedule leads failed for client_wise_id=${row.id}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      }

      if (summaryConfig) {
        try {
          this.logger.log(
            `Daily schedule: scrape summary for client_wise_id=${row.id} client_id=${row.client_id} year=${row.year} config_id=${row.config_id}`,
          );
          await this.scrapperService.scrapeSummary({ client_wise_id: row.id } as any);
        } catch (err) {
          this.logger.error(
            `Daily schedule summary failed for client_wise_id=${row.id}`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      }
    }

    this.logger.log('Daily scheduled scrape run finished');
  }
}

