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

  private getEnvBool(name: string, defaultValue: boolean): boolean {
    const raw = (process.env[name] ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
    return defaultValue;
  }

  private async callApi(endpoint: string, label: string) {
    try {
      this.logger.log(`⏰ Cron triggered: ${label}`);
      const res = await axios.post(`${this.baseUrl}${endpoint}`);
      this.logger.log(`✅ ${label} completed`);
    } catch (err) {
      this.logger.error(`❌ ${label} failed: ${err.message}`);
    }
  }

  @Cron('0 8 * * *', { timeZone: 'Asia/Kolkata' })
  async adsSync() {
    await this.callApi('/ads-engine/sync', 'Ads Sync');
  }

  @Cron('30 8 * * *', { timeZone: 'Asia/Kolkata' })
  async adsAttributionSync() {
    await this.callApi('/ads-engine/sync-attribution', 'Ads Attribution Sync');
  }

  @Cron(buildReportCronExpression(), { timeZone: 'Asia/Kolkata' })
  async reportEmailSchedule() {
    if (!this.getEnvBool('REPORT_CRON_ENABLED', true)) return;
    await this.callApi('/reports/email', 'Daily Report Email');
  }
}
