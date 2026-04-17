import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  private get baseUrl() {
    return `http://localhost:${process.env.PORT ?? 9002}`;
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
}
