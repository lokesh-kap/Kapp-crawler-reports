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

  @Cron('05 00 * * *', { timeZone: 'Asia/Kolkata' })
  async adsAndNpfSync() {
    await this.callApi('/ads-engine/sync', 'Ads Sync');
    await this.callApi('/scraper/schedule/npf-funnel/run', 'NPF Funnel + Campaign Scrape');
  }

  @Cron('00 11 * * *', { timeZone: 'Asia/Kolkata' })
  async reportEmailSchedule() {
    if (!(`${process.env.REPORT_CRON_ENABLED}` === 'true')) return;
    const reportCalls = [
      this.callApi('/reports/email', 'Daily Report Email (Overall + Zone-wise)'),
      this.callApi('/reports/google-ads-email', 'Google Ads Report Email'),
    ];
    await Promise.allSettled(reportCalls);
  }
}
