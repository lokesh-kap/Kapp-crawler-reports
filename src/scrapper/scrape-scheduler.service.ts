import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ScrapperService } from './scrapper.service';
import { PlaywrightService } from './playwright.service';
import { OverallClientReportService } from '../reports/overall-client-report.service';
import type { NpfScrapeWarning } from './scrapper.service';

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

/** NPF Funnel defaults to early morning. */
export function buildNpfFunnelCronExpression(): string {
  const hour = Number(process.env.SCRAPER_NPF_CRON_HOUR ?? 7);
  const minute = Number(process.env.SCRAPER_NPF_CRON_MINUTE ?? 0);
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 7;
  const m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  return `0 ${m} ${h} * * *`;
}

@Injectable()
export class ScrapeSchedulerService {
  private readonly logger = new Logger(ScrapeSchedulerService.name);
  private lastLeadsDateKey: string | null = null;
  private lastSummaryDateKey: string | null = null;
  private lastNpfDateKey: string | null = null;
  private leadsRunning = false;
  private summaryRunning = false;
  private npfRunning = false;

  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ClientWiseLeadsConfigEntity)
    private readonly leadsConfigRepository: Repository<ClientWiseLeadsConfigEntity>,
    @InjectRepository(ClientWiseSummaryConfigEntity)
    private readonly summaryConfigRepository: Repository<ClientWiseSummaryConfigEntity>,
    private readonly scrapperService: ScrapperService,
    private readonly reportService: OverallClientReportService,
    private readonly playwrightService: PlaywrightService,
  ) { }

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

  private formatReadableDateTime(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
  }

  private escapeCsv(value: string | number): string {
    const raw = String(value ?? '');
    if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  }

  private async writeNpfWarningCsv(
    trigger: 'cron' | 'manual',
    warningRows: Array<{ client_id: number; client_wise_id: number; status: string; filter_applied: string; message: string; occurred_at: string }>,
  ): Promise<string | null> {
    if (!warningRows.length) return null;
    const outDir = path.join(process.cwd(), 'data', 'npf-retry');
    await fs.mkdir(outDir, { recursive: true });
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    const filePath = path.join(outDir, `npf-warning-${trigger}-${ts}.csv`);
    const header = 'client_id,client_wise_id,status,filter_applied,message,occurred_at\n';
    const lines = warningRows.map((row) =>
      [
        this.escapeCsv(row.client_id),
        this.escapeCsv(row.client_wise_id),
        this.escapeCsv(row.status),
        this.escapeCsv(row.filter_applied),
        this.escapeCsv(row.message),
        this.escapeCsv(row.occurred_at),
      ].join(','),
    );
    await fs.writeFile(filePath, header + lines.join('\n') + '\n', 'utf8');
    return filePath;
  }

  private async writeNpfRetryCsv(
    trigger: 'cron' | 'manual',
    retryRows: Array<{ client_id: number; client_wise_id: number; status: string; filter_applied: string; message: string; occurred_at: string }>,
  ): Promise<string | null> {
    if (!retryRows.length) return null;
    const outDir = path.join(process.cwd(), 'data', 'npf-retry');
    await fs.mkdir(outDir, { recursive: true });
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    const filePath = path.join(outDir, `npf-warning-retry-${trigger}-${ts}.csv`);
    const header = 'client_id,client_wise_id,status,filter_applied,message,occurred_at\n';
    const lines = retryRows.map((row) =>
      [
        this.escapeCsv(row.client_id),
        this.escapeCsv(row.client_wise_id),
        this.escapeCsv(row.status),
        this.escapeCsv(row.filter_applied),
        this.escapeCsv(row.message),
        this.escapeCsv(row.occurred_at),
      ].join(','),
    );
    await fs.writeFile(filePath, header + lines.join('\n') + '\n', 'utf8');
    return filePath;
  }

  @Cron(buildLeadsCronExpression(), { name: 'daily-leads-scrape' })
  async handleCronLeads(): Promise<void> {
    if (
      !this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true) ||
      !this.getEnvBool('SCRAPER_LEADS_SCHEDULE_ENABLED', true)
    ) {
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
    if (
      !this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true) ||
      !this.getEnvBool('SCRAPER_SUMMARY_SCHEDULE_ENABLED', true)
    ) {
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

  // Kept for optional direct cron usage; primary trigger is cron.service.ts.
  async handleCronNpfFunnel(): Promise<void> {
    this.logger.log('⏰ Cron triggered: NPF Funnel Scrape');
    if (
      !this.getEnvBool('SCRAPER_DAILY_SCHEDULE_ENABLED', true) ||
      !this.getEnvBool('SCRAPER_NPF_SCHEDULE_ENABLED', true)
    ) {
      return;
    }
    const now = new Date();
    const dateKey = this.getDateKey(now);
    if (this.lastNpfDateKey === dateKey || this.npfRunning) {
      return;
    }
    this.lastNpfDateKey = dateKey;
    this.npfRunning = true;
    try {
      await this.runDailyNpfFunnelScrape('cron');
    } catch (err) {
      this.logger.error(
        'Scheduled NPF Funnel scrape failed',
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.npfRunning = false;
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

  async triggerNpfFunnelScrapeNow(): Promise<void> {
    if (this.npfRunning) {
      this.logger.warn('Manual trigger ignored: NPF Funnel scrape is already running');
      return;
    }
    this.npfRunning = true;
    this.logger.log('Manual trigger: daily NPF Funnel scrape for all active client-wise configs');
    try {
      await this.runDailyNpfFunnelScrape('manual');
    } finally {
      this.npfRunning = false;
    }
  }

  async triggerNpfFunnelWarningRetryNow(): Promise<void> {
    if (this.npfRunning) {
      this.logger.warn('Manual trigger ignored: NPF Funnel scrape is already running');
      return;
    }
    this.npfRunning = true;
    this.logger.log('Manual trigger: NPF Funnel retry from latest warning CSV');
    try {
      // Retry flow is intentionally disabled for now.
      // await this.runNpfFunnelWarningRetry();
      this.logger.warn('NPF retry is currently disabled (manual trigger skipped).');
    } finally {
      this.npfRunning = false;
    }
  }

  private async runNpfFunnelWarningRetry(): Promise<void> {
    const outDir = path.join(process.cwd(), 'data', 'npf-retry');
    let files: string[] = [];
    try {
      files = await fs.readdir(outDir);
    } catch (err) {
      this.logger.warn('No npf-retry directory found.');
      return;
    }
    
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const retryCsvFiles = files
      .filter(
        (f) =>
          f.startsWith('npf-warning-retry-') &&
          f.endsWith('.csv') &&
          f.includes(`-${todayKey}_`),
      )
      .sort();
    const warningCsvFiles = files
      .filter(
        (f) =>
          f.startsWith('npf-warning-') &&
          f.endsWith('.csv') &&
          f.includes(`-${todayKey}_`),
      )
      .sort();
    const csvFiles = [...retryCsvFiles, ...warningCsvFiles];
    if (!csvFiles.length) {
      this.logger.warn(`No warning CSV files found for today (${todayKey}).`);
      return;
    }

    const latestFile = retryCsvFiles.length
      ? retryCsvFiles[retryCsvFiles.length - 1]
      : warningCsvFiles[warningCsvFiles.length - 1];
    const filePath = path.join(outDir, latestFile);
    this.logger.log(`Reading warning clients from: ${latestFile}`);
    
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n');
    const retryClientIds = new Set<number>();
    
    const retryableStatuses = new Set([
      'filter_not_found',
      'metrics_not_found',
      'dom_fallback_incomplete',
      'hard_error',
      'warning_retry_failed',
      'warning_retry_second_failed',
    ]);

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(',');
        if (parts.length > 2) {
            const status = String(parts[2] ?? '').replace(/"/g, '').trim();
            if (!retryableStatuses.has(status)) continue;
            const clientId = parseInt(parts[0].replace(/"/g, ''), 10);
            if (!isNaN(clientId)) {
              retryClientIds.add(clientId);
            }
        }
    }
    
    if (retryClientIds.size === 0) {
        this.logger.log('No client IDs to retry found in CSV.');
        return;
    }
    
    this.logger.log(`Found ${retryClientIds.size} unique client IDs to retry.`);
    
    const rows = await this.clientWiseRepository.find({
        where: {
            is_active: true,
            config_id: Not(IsNull()),
        },
        order: { id: 'ASC' },
    });
    
    const uniqueRowsMap = new Map<string, ClientWiseEntity>();
    for (const row of rows) {
      const key = String(row.client_id);
      if (uniqueRowsMap.has(key)) continue;
      uniqueRowsMap.set(key, row);
    }
    const dedupedRows = Array.from(uniqueRowsMap.values());
    const retryRows = dedupedRows.filter((row) => retryClientIds.has(row.client_id));
    
    this.logger.log(`Starting retry for ${retryRows.length} clients...`);
    const progress = {
      total: retryRows.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };
    const retrySuccessList: number[] = [];
    const retryFailedList: Array<{ client_id: number; error: string }> = [];
    const logProgress = (label: string, row?: ClientWiseEntity) => {
      this.logger.log(
        `📈 NPF retry progress: ${progress.processed}/${progress.total} processed | ` +
        `success=${progress.success} failed=${progress.failed} skipped=${progress.skipped}` +
        (row ? ` | client_id=${row.client_id} client_wise_id=${row.id} (${label})` : ` | ${label}`),
      );
    };
    logProgress('run started');

    // Group retry clients by shared NPF login credentials to reuse sessions.
    const groupedRows = new Map<string, ClientWiseEntity[]>();
    for (const row of retryRows) {
      if (!row.credentials?.login_url || !row.credentials?.login) {
        progress.processed += 1;
        progress.skipped += 1;
        logProgress('skipped: missing login credentials', row);
        continue;
      }
      const hash = `${row.credentials.login_url}|${row.credentials.login}`;
      if (!groupedRows.has(hash)) groupedRows.set(hash, []);
      groupedRows.get(hash)!.push(row);
    }

    const groupsArray = Array.from(groupedRows.entries());
    const envConcurrency = parseInt(
      process.env.SCRAPER_RETRY_GROUP_CONCURRENCY ||
      process.env.SCRAPER_GROUP_CONCURRENCY ||
      '',
      10,
    );
    const concurrency = isNaN(envConcurrency) ? 3 : envConcurrency;

    this.logger.log(
      `NPF retry: Processing ${groupsArray.length} CRM groups with a concurrency of ${concurrency}...`,
    );

    for (let i = 0; i < groupsArray.length; i += concurrency) {
      const chunk = groupsArray.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async ([hash, group]) => {
          this.logger.log(
            `\n\n--- 🚀 Processing RETRY CRM Group: [${group[0].credentials!.login}] with ${group.length} clients ---`,
          );
          let browserContext;
          try {
            browserContext = await this.playwrightService.createBrowser({ useProxy: false });
            const { page } = browserContext;
            let isFirstInGroup = true;

            for (const row of group) {
              const summaryConfig = await this.summaryConfigRepository.findOne({
                where: { client_wise_id: row.id, is_active: true },
              });
              if (!summaryConfig) {
                progress.processed += 1;
                progress.skipped += 1;
                logProgress('skipped: summary config not found', row);
                continue;
              }

              try {
                this.logger.log(
                  `=> Running grouped retry scrape for client_id=${row.client_id} (Skipping Login: ${!isFirstInGroup})`,
                );
                await this.scrapperService.scrapeNpfFunnelData(
                  { client_wise_id: row.id } as any,
                  { page, skipLogin: !isFirstInGroup },
                );
                isFirstInGroup = false;
                retrySuccessList.push(row.client_id);
                progress.processed += 1;
                progress.success += 1;
                logProgress('completed', row);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                retryFailedList.push({ client_id: row.client_id, error: msg });
                progress.processed += 1;
                progress.failed += 1;
                logProgress('failed', row);
                this.logger.error(
                  `Warning retry standalone failed for client_id=${row.client_id}`,
                  err instanceof Error ? err.stack : undefined,
                );
              }
            }
          } catch (err) {
            this.logger.error(
              `Critical error while processing RETRY CRM Group: ${hash}`,
              err instanceof Error ? err.stack : undefined,
            );
          } finally {
            if (browserContext) {
              this.logger.log(
                `Closing shared browser session for RETRY CRM Group: [${group[0].credentials!.login}]`,
              );
              await browserContext.page?.close().catch(() => null);
              await browserContext.context?.close().catch(() => null);
              await browserContext.browser?.close().catch(() => null);
            }
          }
        }),
      );
    }

    this.logger.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`📊 NPF RETRY RUN SUMMARY`);
    this.logger.log(
      `✅ Completed: success=${progress.success} failed=${progress.failed} skipped=${progress.skipped} total=${progress.total}`,
    );
    if (retrySuccessList.length > 0) {
      this.logger.log(`✅ Retry Success Clients: ${retrySuccessList.join(', ')}`);
    }
    if (retryFailedList.length > 0) {
      this.logger.error(`❌ Retry Failed Clients: ${retryFailedList.length}`);
      retryFailedList.forEach((f) =>
        this.logger.error(`   - Client ${f.client_id}: ${f.error}`),
      );
    }
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    this.logger.log(`NPF Funnel standalone retry finished. Now triggering report...`);
    try {
      await this.reportService.generateAndSendReport();
      this.logger.log(`NPF Funnel standalone retry report sent successfully`);
    } catch (err) {
      this.logger.error(
        `NPF Funnel standalone retry report generation failed`,
        err instanceof Error ? err.stack : undefined,
      );
    }
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

  private async runDailyNpfFunnelScrape(trigger: 'cron' | 'manual'): Promise<void> {
    this.logger.log(`Starting ${trigger} NPF Funnel scrape run`);

    const rows = await this.getActiveRows();
    this.logger.log(`NPF Funnel ${trigger}: checking ${rows.length} active client-wise rows`);

    // Dedupe by client_id to guarantee one scrape execution per client in a run.
    // Keep first row encountered (ordered by id ASC in getActiveRows()).
    const uniqueRowsMap = new Map<string, ClientWiseEntity>();
    let duplicateRows = 0;
    for (const row of rows) {
      const key = String(row.client_id);
      if (uniqueRowsMap.has(key)) {
        duplicateRows += 1;
        continue;
      }
      uniqueRowsMap.set(key, row);
    }
    const dedupedRows = Array.from(uniqueRowsMap.values());
    if (duplicateRows > 0) {
      this.logger.warn(
        `NPF Funnel ${trigger}: skipped ${duplicateRows} duplicate client-wise rows by client_id`,
      );
    }

    const successList: number[] = [];
    const failedList: { client_id: number; error: string }[] = [];
    const campaignSuccessList: number[] = [];
    const campaignFailedList: { client_id: number; error: string }[] = [];
    const warningRows: NpfScrapeWarning[] = [];
    const retryClientIds = new Set<number>();
    const warningClientIds = new Set<number>();
    const progress = {
      total: dedupedRows.length,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
    };
    const isLikelySessionLogoutError = (msg: string): boolean =>
      /(login|sign[\s-]?in|session|unauthori[sz]ed|forbidden|token|expired|401|403)/i.test(
        msg,
      );
    const logProgress = (label: string, row?: ClientWiseEntity) => {
      this.logger.log(
        `📈 NPF ${trigger} progress: ${progress.processed}/${progress.total} processed | ` +
        `success=${progress.success} failed=${progress.failed} skipped=${progress.skipped} ` +
        `warning_clients=${warningClientIds.size}` +
        (row ? ` | client_id=${row.client_id} client_wise_id=${row.id} (${label})` : ` | ${label}`),
      );
    };
    logProgress('run started');

    // Group clients by their shared NPF login credentials
    const groupedRows = new Map<string, ClientWiseEntity[]>();
    for (const row of dedupedRows) {
      if (!row.credentials?.login_url || !row.credentials?.login) continue;
      const hash = `${row.credentials.login_url}|${row.credentials.login}`;
      if (!groupedRows.has(hash)) groupedRows.set(hash, []);
      groupedRows.get(hash)!.push(row);
    }

    const groupsArray = Array.from(groupedRows.entries());
    const envConcurrency = parseInt(process.env.SCRAPER_GROUP_CONCURRENCY || '', 10);
    const concurrency = isNaN(envConcurrency) ? 3 : envConcurrency;

    this.logger.log(`NPF Funnel ${trigger}: Processing ${groupsArray.length} CRM groups with a concurrency of ${concurrency}...`);

    for (let i = 0; i < groupsArray.length; i += concurrency) {
      const chunk = groupsArray.slice(i, i + concurrency);

      await Promise.all(chunk.map(async ([hash, group]) => {
        this.logger.log(`\n\n--- 🚀 Processing CRM Group: [${group[0].credentials!.login}] with ${group.length} clients ---`);

        let browserContext;
        try {
          browserContext = await this.playwrightService.createBrowser({ useProxy: false });
          const { page } = browserContext;
          let isFirstInGroup = true;
          const leadCompletedRows: ClientWiseEntity[] = [];

          for (const row of group) {
            const summaryConfig = await this.summaryConfigRepository.findOne({
              where: { client_wise_id: row.id, is_active: true },
            });
            if (!summaryConfig) {
              progress.processed += 1;
              progress.skipped += 1;
              logProgress('skipped: summary config not found', row);
              continue;
            }

            const maxRetries = 3;
            let success = false;
            let lastError = '';
            let forceLoginForRetry = false;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              try {
                const skipLogin = !isFirstInGroup && !forceLoginForRetry;
                this.logger.log(`\n=> Scraping NPF Funnel for client_wise_id=${row.id} client_id=${row.client_id} (Attempt ${attempt}/${maxRetries}, Skipping Login: ${skipLogin})`);

                const npfResult = await this.scrapperService.scrapeNpfFunnelData(
                  { client_wise_id: row.id } as any,
                  { page, skipLogin }
                );
                if (npfResult?.warnings?.length) {
                  warningRows.push(...npfResult.warnings);
                  retryClientIds.add(row.client_id);
                  warningClientIds.add(row.client_id);
                }

                isFirstInGroup = false;
                success = true;
                successList.push(row.client_id);
                leadCompletedRows.push(row);
                progress.processed += 1;
                progress.success += 1;
                logProgress('completed', row);
                break; // If successful, immediately break out of the retry loop
              } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                if (isLikelySessionLogoutError(lastError)) {
                  forceLoginForRetry = true;
                  this.logger.warn(
                    `Detected possible session logout for client_id=${row.client_id}; next retry will force login.`,
                  );
                }
                this.logger.error(
                  `NPF Funnel failed for client_wise_id=${row.id} on attempt ${attempt}`,
                  err instanceof Error ? err.stack : undefined,
                );

                if (attempt < maxRetries) {
                  this.logger.warn(`Retrying client ${row.client_id} in 3 seconds...`);
                  await new Promise(r => setTimeout(r, 3000));
                }
              }
            }

            if (!success) {
              failedList.push({ client_id: row.client_id, error: lastError });
              progress.processed += 1;
              progress.failed += 1;
              logProgress('failed after max retries', row);
            }
          }

          if (leadCompletedRows.length) {
            this.logger.log(
              `\n--- 📊 Campaign summary phase for CRM Group [${group[0].credentials!.login}] (${leadCompletedRows.length} client(s), no filters) ---`,
            );
          }

          for (const row of leadCompletedRows) {
            const maxCampaignRetries = 2;
            let campaignDone = false;
            let campaignLastError = '';
            let forceCampaignLoginForRetry = false;

            for (let attempt = 1; attempt <= maxCampaignRetries; attempt += 1) {
              try {
                const skipLogin = !forceCampaignLoginForRetry;
                this.logger.log(
                  `=> Campaign scrape client_wise_id=${row.id} client_id=${row.client_id} (Attempt ${attempt}/${maxCampaignRetries}, skipLogin=${skipLogin})`,
                );
                await this.scrapperService.scrapeNpfCampaignDetailsViaApi(
                  { client_wise_id: row.id } as any,
                  { page, skipLogin },
                );
                campaignSuccessList.push(row.client_id);
                campaignDone = true;
                break;
              } catch (err) {
                campaignLastError = err instanceof Error ? err.message : String(err);
                if (isLikelySessionLogoutError(campaignLastError)) {
                  forceCampaignLoginForRetry = true;
                  this.logger.warn(
                    `Detected possible session logout during campaign phase for client_id=${row.client_id}; next retry will force login.`,
                  );
                }
                this.logger.error(
                  `Campaign summary scrape failed for client_wise_id=${row.id} on attempt ${attempt}`,
                  err instanceof Error ? err.stack : undefined,
                );
                if (attempt < maxCampaignRetries) {
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                }
              }
            }

            if (!campaignDone) {
              campaignFailedList.push({
                client_id: row.client_id,
                error: campaignLastError || 'campaign summary scrape failed',
              });
            }
          }
        } catch (err) {
          this.logger.error(`Critical error while processing CRM Group: ${hash}`, err instanceof Error ? err.stack : undefined);
        } finally {
          if (browserContext) {
            this.logger.log(`Closing shared browser session for CRM Group: [${group[0].credentials!.login}]`);
            await browserContext.page?.close().catch(() => null);
            await browserContext.context?.close().catch(() => null);
            await browserContext.browser?.close().catch(() => null);
          }
        }
      }));
    }

    this.logger.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.logger.log(`📊 NPF FUNNEL RUN SUMMARY`);
    this.logger.log(`✅ Success: ${successList.length} clients (${successList.join(', ')})`);
    this.logger.log(
      `📌 Campaign summary (client_wise_summary_data): success=${campaignSuccessList.length} failed=${campaignFailedList.length}`,
    );
    if (campaignFailedList.length > 0) {
      campaignFailedList.forEach((f) =>
        this.logger.error(`   - Campaign scrape failed for client ${f.client_id}: ${f.error}`),
      );
    }
    if (warningRows.length > 0) {
      this.logger.warn(`⚠️ Warnings: ${warningRows.length} entries`);
      warningRows.forEach((w) =>
        this.logger.warn(
          `   - Client ${w.client_id} (client_wise_id=${w.client_wise_id}) [${w.status}] [${w.filter_applied}] ${w.message}`,
        ),
      );
    }
    if (failedList.length > 0) {
      this.logger.error(`❌ Failed: ${failedList.length} clients`);
      failedList.forEach(f => this.logger.error(`   - Client ${f.client_id}: ${f.error}`));
    } else {
      this.logger.log(`🎉 All clients completely successfully!`);
    }
    this.logger.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const warningCsvRows = warningRows.map((w) => ({
      client_id: w.client_id,
      client_wise_id: w.client_wise_id,
      status: w.status,
      filter_applied: w.filter_applied,
      message: w.message,
      occurred_at: this.formatReadableDateTime(new Date(w.occurred_at)),
    }));
    const hardErrorCsvRows = failedList.map((f) => {
      const matchedRow = dedupedRows.find((r) => r.client_id === f.client_id);
      return {
        client_id: f.client_id,
        client_wise_id: matchedRow?.id ?? 0,
        status: 'hard_error',
        filter_applied: 'N/A',
        message: f.error || 'Unknown scrape error',
        occurred_at: this.formatReadableDateTime(new Date()),
      };
    });
    const combinedCsvRows = [...warningCsvRows, ...hardErrorCsvRows];
    const warningCsvPath = await this.writeNpfWarningCsv(trigger, combinedCsvRows);
    if (warningCsvPath) {
      this.logger.log(`⚠️ NPF warning CSV created: ${warningCsvPath}`);
    }

    // Retry flow intentionally disabled. First phase ends here.
    if (retryClientIds.size > 0) {
      this.logger.warn(
        `NPF ${trigger}: first phase completed; retry disabled, skipped ${retryClientIds.size} warning client(s).`,
      );
    }

    this.logger.log(`NPF Funnel ${trigger} scrape finished.`);
    // Auto report after scrape intentionally disabled.
    // Report will be sent by dedicated scheduler (e.g. 10AM cron).
    // try {
    //   await this.reportService.generateAndSendReport();
    //   this.logger.log(`NPF Funnel ${trigger} report sent successfully`);
    // } catch (err) {
    //   this.logger.error(
    //     `NPF Funnel ${trigger} report generation failed`,
    //     err instanceof Error ? err.stack : undefined,
    //   );
    // }
  }
}
