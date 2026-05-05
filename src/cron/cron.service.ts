import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';

function buildReportCronExpression(): string {
  const hour = Number(process.env.REPORT_CRON_HOUR ?? 10);
  const minute = Number(process.env.REPORT_CRON_MINUTE ?? 0);
  const h = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 10;
  const m = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  return `${m} ${h} * * *`;
}

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  private readonly cronQueue: Array<{ name: string; task: () => Promise<void> }> = [];
  private isProcessingQueue = false;

  private get baseUrl() {
    return `http://localhost:${process.env.PORT ?? 9002}`;
  }

  private async callApi(endpoint: string, label: string) {
    try {
      this.logger.log(`⏰ Cron triggered: ${label}`);
      await axios.post(`${this.baseUrl}${endpoint}`, null, {
        timeout: Number(process.env.REPORT_CRON_API_TIMEOUT_MS ?? 300000),
      });
      this.logger.log(`✅ ${label} completed`);
    } catch (err: any) {
      this.logger.error(`❌ ${label} failed: ${err?.message ?? err}`);
    }
  }

  private enqueueCronTask(name: string, task: () => Promise<void>) {
    this.cronQueue.push({ name, task });
    this.logger.log(`📥 Queued cron task: ${name} (queue size: ${this.cronQueue.length})`);
    void this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    try {
      while (this.cronQueue.length > 0) {
        const next = this.cronQueue.shift();
        if (!next) continue;
        this.logger.log(`🚀 Running queued cron task: ${next.name}`);
        try {
          await next.task();
          this.logger.log(`✅ Queued cron task completed: ${next.name}`);
        } catch (err: any) {
          this.logger.error(`❌ Queued cron task failed: ${next.name} - ${err?.message ?? err}`);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  @Cron('05 00 * * *', { timeZone: 'Asia/Kolkata' })
  async adsAndNpfSync() {
    this.enqueueCronTask('Ads + NPF Sync', async () => {
      await this.callApi('/ads-engine/sync', 'Ads Sync');
      await this.callApi('/scraper/schedule/npf-funnel/run', 'NPF Funnel + Campaign Scrape');
    });
  }

  @Cron('00 10 * * *', { timeZone: 'Asia/Kolkata' })
  async reportEmailSchedule() {
    if (!(`${process.env.REPORT_CRON_ENABLED}` === 'true')) return;
    this.enqueueCronTask('Daily Report Emails', async () => {
      const reportCalls = [
        this.callApi('/reports/email', 'Daily Report Email (Overall + Zone-wise)'),
        this.callApi('/reports/google-ads-email', 'Google Ads Report Email'),
        this.callApi('/reports/vendor-email', 'Vendor Report Email'),
        this.callApi('/reports/database-email', 'Database Report Email'),
      ];
      await Promise.allSettled(reportCalls);
    });
  }
}
