import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);
  private readonly baseUrl = 'https://graph.facebook.com/v22.0';

  private async callApi(endpoint: string, accessToken: string, params: any = {}) {
    try {
      const response = await axios.get(`${this.baseUrl}/${endpoint}`, {
        params: {
          access_token: accessToken,
          ...params,
        },
      });
      return response.data;
    } catch (err: any) {
      const errorData = err.response?.data?.error;
      const message = errorData?.message || err.message;
      this.logger.error(`Meta API Error [${endpoint}]: ${message}`);
      throw new Error(`Meta API: ${message}`);
    }
  }

  async listAdAccounts(accessToken: string) {
    const data = await this.callApi('me/adaccounts', accessToken, {
      fields: 'id,name,currency,timezone_name,account_status',
    });
    return data.data || [];
  }

  async getCampaigns(adAccountId: string, accessToken: string) {
    // Note: adAccountId should be 'act_12345'
    const data = await this.callApi(`${adAccountId}/campaigns`, accessToken, {
      fields: 'id,name,status,objective,daily_budget,lifetime_budget',
      limit: 500,
    });
    return data.data || [];
  }

  async getInsights(adAccountId: string, accessToken: string, datePreset: string = 'yesterday') {
    const data = await this.callApi(`${adAccountId}/insights`, accessToken, {
      fields: 'campaign_id,campaign_name,impressions,clicks,spend,ctr,cpc',
      level: 'campaign',
      date_preset: datePreset,
      time_increment: 1, // Daily data
      limit: 1000,
    });
    return data.data || [];
  }

  async getInsightsForRange(adAccountId: string, accessToken: string, startDate: string, endDate: string) {
    const data = await this.callApi(`${adAccountId}/insights`, accessToken, {
      fields: 'campaign_id,campaign_name,impressions,clicks,spend,ctr,cpc',
      level: 'campaign',
      time_range: JSON.stringify({ since: startDate, until: endDate }),
      time_increment: 1, // Daily data
      limit: 1000,
    });
    return data.data || [];
  }
}
