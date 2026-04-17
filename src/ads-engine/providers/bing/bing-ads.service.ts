import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class BingAdsService {
  private readonly logger = new Logger(BingAdsService.name);

  async syncCampaigns(accountId: string, refreshToken: string) {
    this.logger.log(`Syncing Bing campaigns for ${accountId}...`);
    // TODO: Implement Bing Ads API fetching
    return [];
  }
}
