import { Injectable, Logger } from '@nestjs/common';
import { GoogleAdsApi } from 'google-ads-api';

const CLIENT_ACCOUNTS_QUERY = `
  SELECT
    customer_client.id,
    customer_client.descriptive_name,
    customer_client.currency_code,
    customer_client.time_zone,
    customer_client.test_account,
    customer_client.resource_name,
    customer_client.manager,
    customer_client.status,
    customer_client.level
  FROM customer_client
  WHERE customer_client.level = 1
`;

const CAMPAIGN_QUERY_TEMPLATE = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.bidding_strategy_type,
    campaign.advertising_channel_type,
    campaign.optimization_score,
    campaign_budget.amount_micros,
    metrics.impressions,
    metrics.clicks,
    metrics.ctr,
    metrics.average_cpc,
    metrics.cost_micros,
    metrics.search_impression_share,
    metrics.search_top_impression_share,
    metrics.search_budget_lost_impression_share,
    metrics.search_rank_lost_impression_share,
    segments.date
  FROM campaign
  WHERE {DATE_FILTER}
  ORDER BY metrics.cost_micros DESC
`;

const CAMPAIGN_INFO_ONLY_QUERY = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.start_date_time,
    campaign.status,
    campaign.bidding_strategy_type,
    campaign.advertising_channel_type,
    campaign.optimization_score,
    campaign_budget.amount_micros
  FROM campaign
`;

const CAMPAIGN_INFO_ONLY_QUERY_FALLBACK = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.bidding_strategy_type,
    campaign.advertising_channel_type,
    campaign.optimization_score,
    campaign_budget.amount_micros
  FROM campaign
`;

const CUSTOMER_STATUS_QUERY = `
  SELECT customer.status
  FROM customer
  LIMIT 1
`;

const RETRYABLE_ERRORS = [
  'RESOURCE_EXHAUSTED',
  'rate limit',
  'Quota exceeded',
  'INTERNAL_ERROR',
  'TRANSIENT_ERROR',
  'socket hang up',
  'ECONNRESET',
  'ETIMEDOUT',
];

export interface GoogleAdsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken?: string;
}

@Injectable()
export class GoogleAdsService {
  private readonly logger = new Logger(GoogleAdsService.name);

  private getClient(config: GoogleAdsConfig) {
    return new GoogleAdsApi({
      client_id: config.clientId || process.env.GOOGLE_ADS_CLIENT_ID || '',
      client_secret: config.clientSecret || process.env.GOOGLE_ADS_CLIENT_SECRET || '',
      developer_token: config.developerToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    });
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    retries = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const message =
          err?.message ||
          err?.errors?.[0]?.message ||
          JSON.stringify(err);

        const isRetryable = RETRYABLE_ERRORS.some((e) =>
          message.includes(e),
        );

        if (isRetryable && attempt < retries) {
          const wait = 5000 * Math.pow(2, attempt - 1);
          this.logger.warn(
            `Retryable error for ${context} — attempt ${attempt}/${retries}, waiting ${wait / 1000}s: ${message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }

        throw new Error(`${context}: ${message}`);
      }
    }

    throw new Error(`${context}: max retries exceeded`);
  }

  async listAccessibleCustomers(config: GoogleAdsConfig) {
    if (!config.refreshToken) throw new Error('Refresh token is required');
    const client = this.getClient(config);

    return this.withRetry(
      () => client.listAccessibleCustomers(config.refreshToken),
      'listAccessibleCustomers',
    );
  }

  getCustomer(customerId: string, loginCustomerId: string | null, config: GoogleAdsConfig) {
    if (!config.refreshToken) throw new Error('Refresh token is required');
    const client = this.getClient(config);

    return client.Customer({
      customer_id: customerId,
      login_customer_id: loginCustomerId ?? customerId,
      refresh_token: config.refreshToken,
    });
  }

  async query(
    customerId: string,
    query: string,
    loginCustomerId: string | null,
    config: GoogleAdsConfig
  ): Promise<any[]> {
    return this.withRetry(
      () => {
        const customer = this.getCustomer(customerId, loginCustomerId, config);
        return customer.query(query);
      },
      `GAQL query for ${customerId}`,
    );
  }

  async getClientAccounts(mccCustomerId: string, loginCustomerId: string | null, config: GoogleAdsConfig): Promise<any[]> {
    return this.withRetry(
      () => this.query(mccCustomerId, CLIENT_ACCOUNTS_QUERY, loginCustomerId ?? mccCustomerId, config),
      `getClientAccounts for MCC ${mccCustomerId}`,
    );
  }

  async getCampaigns(
    customerCustomerId: string,
    loginCustomerId: string,
    config: GoogleAdsConfig,
    startDate: string = 'YESTERDAY',
    endDate: string = 'YESTERDAY',
  ): Promise<any[]> {
    const isPeriod = startDate !== 'YESTERDAY' || endDate !== 'YESTERDAY';
    const dateFilter = isPeriod
      ? `segments.date BETWEEN '${startDate}' AND '${endDate}'`
      : `segments.date DURING YESTERDAY`;

    const query = CAMPAIGN_QUERY_TEMPLATE.replace('{DATE_FILTER}', dateFilter);
    return this.withRetry(
      () => this.query(customerCustomerId, query, loginCustomerId, config),
      `getCampaigns for ${customerCustomerId}`,
    );
  }

  async getCampaignInfo(
    customerCustomerId: string,
    loginCustomerId: string,
    config: GoogleAdsConfig
  ): Promise<any[]> {
    try {
      return await this.withRetry(
        () => this.query(customerCustomerId, CAMPAIGN_INFO_ONLY_QUERY, loginCustomerId, config),
        `getCampaignInfo (Status Sync) for ${customerCustomerId}`,
      );
    } catch (err: any) {
      const msg = String(err?.message ?? '');
      if (
        msg.includes('UNRECOGNIZED_FIELD') &&
        (msg.includes('campaign.start_date') || msg.includes('campaign.start_date_time'))
      ) {
        this.logger.warn(
          `campaign start-date field not supported for customer ${customerCustomerId}; using fallback campaign info query without start date.`,
        );
        return this.withRetry(
          () =>
            this.query(
              customerCustomerId,
              CAMPAIGN_INFO_ONLY_QUERY_FALLBACK,
              loginCustomerId,
              config,
            ),
          `getCampaignInfo fallback (without start-date field) for ${customerCustomerId}`,
        );
      }
      throw err;
    }
  }

  /**
   * Account-level status for the client customer (ENABLED, CANCELED, SUSPENDED, etc.).
   * Returned value may be an enum name string or a numeric code depending on API serialization.
   */
  async getCustomerAccountStatus(
    customerCustomerId: string,
    loginCustomerId: string,
    config: GoogleAdsConfig,
  ): Promise<string | number | undefined> {
    const rows = await this.withRetry(
      () =>
        this.query(
          customerCustomerId,
          CUSTOMER_STATUS_QUERY,
          loginCustomerId,
          config,
        ),
      `getCustomerAccountStatus for ${customerCustomerId}`,
    );
    return rows[0]?.customer?.status;
  }
}

/** True when the API indicates the customer cannot be queried (deactivated, not enabled, etc.). */
export function isGoogleCustomerAccessLostError(err: unknown): boolean {
  const e = err as any;
  const parts: string[] = [];
  if (e?.message) parts.push(String(e.message));
  if (Array.isArray(e?.errors)) {
    for (const item of e.errors) {
      if (item?.message) parts.push(String(item.message));
    }
  }
  if (e?.failure?.errors?.length) {
    for (const item of e.failure.errors) {
      if (item?.message) parts.push(String(item.message));
    }
  }
  const blob = parts.join(' ').toLowerCase();
  const json = JSON.stringify(e ?? {}).toLowerCase();

  if (
    blob.includes('not yet enabled') &&
    (blob.includes('deactivated') || blob.includes('disabled'))
  ) {
    return true;
  }
  if (blob.includes("can't be accessed") || blob.includes('cannot be accessed')) {
    if (
      blob.includes('deactivated') ||
      blob.includes('cancelled') ||
      blob.includes('canceled') ||
      blob.includes('closed') ||
      blob.includes('not yet enabled')
    ) {
      return true;
    }
  }
  if (
    json.includes('customer_not_enabled') ||
    json.includes('customer_not_active') ||
    json.includes('not_serving_customer') ||
    json.includes('no_access_to_customer')
  ) {
    return true;
  }
  return false;
}
