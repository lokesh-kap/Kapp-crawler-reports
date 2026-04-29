import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DeepPartial } from 'typeorm';
import pLimit from 'p-limit';

import { AdsCredential } from './entities/ads-credential.entity';
import { AdsAccount } from './entities/ads-account.entity';
import { CampaignInfo } from './entities/campaign-info.entity';
import { CampaignMetrics } from './entities/campaign-metrics.entity';
import {
  GoogleAdsService,
  GoogleAdsConfig,
  isGoogleCustomerAccessLostError,
} from './providers/google/google-ads.service';
import { MetaAdsService } from './providers/meta/meta-ads.service';
import { AdsProvider, AccountStatus, CampaignStatus, CampaignType, BiddingStrategy } from './enums';

// Maps from Google numerical/string statuses to our Enums
const GOOGLE_STATUS_MAP: Record<any, CampaignStatus> = {
  2: CampaignStatus.ENABLED,
  3: CampaignStatus.PAUSED,
  4: CampaignStatus.REMOVED,
  'ENABLED': CampaignStatus.ENABLED,
  'PAUSED': CampaignStatus.PAUSED,
  'REMOVED': CampaignStatus.REMOVED,
};

const GOOGLE_TYPE_MAP: Record<any, CampaignType> = {
  2: CampaignType.SEARCH,
  3: CampaignType.DISPLAY,
  6: CampaignType.VIDEO,
  7: CampaignType.MULTI_CHANNEL,
  13: CampaignType.PERFORMANCE_MAX,
  'SEARCH': CampaignType.SEARCH,
  'DISPLAY': CampaignType.DISPLAY,
  'VIDEO': CampaignType.VIDEO,
  'PERFORMANCE_MAX': CampaignType.PERFORMANCE_MAX,
};

const GOOGLE_BIDDING_MAP: Record<any, BiddingStrategy> = {
  2: BiddingStrategy.MANUAL_CPC,
  8: BiddingStrategy.MAXIMIZE_CONVERSIONS,
  9: BiddingStrategy.MAXIMIZE_CONVERSION_VALUE,
  6: BiddingStrategy.TARGET_CPA,
  7: BiddingStrategy.TARGET_ROAS,
  'MANUAL_CPC': BiddingStrategy.MANUAL_CPC,
  'MAXIMIZE_CONVERSIONS': BiddingStrategy.MAXIMIZE_CONVERSIONS,
  'MAXIMIZE_CONVERSION_VALUE': BiddingStrategy.MAXIMIZE_CONVERSION_VALUE,
  'TARGET_CPA': BiddingStrategy.TARGET_CPA,
  'TARGET_ROAS': BiddingStrategy.TARGET_ROAS,
};

const META_STATUS_MAP: Record<string, CampaignStatus> = {
  'ACTIVE': CampaignStatus.ENABLED,
  'PAUSED': CampaignStatus.PAUSED,
  'ARCHIVED': CampaignStatus.REMOVED,
  'DELETED': CampaignStatus.REMOVED,
};

const toCampaignStartDate = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

/** Google `customer.status` / `customer_client.status` → our AccountStatus */
const GOOGLE_ACCOUNT_STATUS_MAP: Record<any, AccountStatus> = {
  0: AccountStatus.UNKNOWN,
  1: AccountStatus.UNKNOWN,
  2: AccountStatus.ENABLED,
  3: AccountStatus.DEACTIVATED,
  4: AccountStatus.PAUSED,
  5: AccountStatus.DEACTIVATED,
  UNKNOWN: AccountStatus.UNKNOWN,
  UNSPECIFIED: AccountStatus.UNKNOWN,
  ENABLED: AccountStatus.ENABLED,
  CANCELED: AccountStatus.DEACTIVATED,
  CANCELLED: AccountStatus.DEACTIVATED,
  CLOSED: AccountStatus.DEACTIVATED,
  SUSPENDED: AccountStatus.PAUSED,
};

function mapGoogleAccountStatus(raw: string | number | undefined | null): AccountStatus {
  if (raw === undefined || raw === null) return AccountStatus.UNKNOWN;
  return GOOGLE_ACCOUNT_STATUS_MAP[raw] ?? AccountStatus.UNKNOWN;
}

@Injectable()
export class AdsEngineService {
  private readonly logger = new Logger(AdsEngineService.name);

  constructor(
    @InjectRepository(AdsCredential)
    private credRepo: Repository<AdsCredential>,
    @InjectRepository(AdsAccount)
    private accountRepo: Repository<AdsAccount>,
    @InjectRepository(CampaignInfo)
    private infoRepo: Repository<CampaignInfo>,
    @InjectRepository(CampaignMetrics)
    private metricsRepo: Repository<CampaignMetrics>,
    private googleAdsService: GoogleAdsService,
    private metaAdsService: MetaAdsService,
  ) {}

  async createCredential(dto: any) {
    const cred = this.credRepo.create(dto);
    return this.credRepo.save(cred);
  }

  async syncAll(fullHistory = false) {
    this.logger.log(`Starting Ads Sync (Full History: ${fullHistory})`);
    const credentials = await this.credRepo.find({ where: { isActive: true } });

    for (const cred of credentials) {
      try {
        if (cred.provider === AdsProvider.GOOGLE) {
          const config: GoogleAdsConfig = {
            clientId: cred.clientId || '',
            clientSecret: cred.clientSecret || '',
            refreshToken: cred.refreshToken || '',
            developerToken: cred.developerToken || '',
          };
          await this.syncGoogleProvider(cred, config, fullHistory);
        } else if (cred.provider === AdsProvider.META) {
          await this.syncMetaProvider(cred, fullHistory);
        }
        // TODO: Bing
      } catch (err: any) {
        this.logger.error(`Failed to sync provider ${cred.name}: ${err.message}`);
      }
    }
  }

  private async syncGoogleProvider(cred: AdsCredential, config: GoogleAdsConfig, fullHistory: boolean) {
    this.logger.log(`Syncing Google Ads for credential: ${cred.name}`);
    
    // 1. Sync MCCs
    const accessible = await this.googleAdsService.listAccessibleCustomers(config) as any;
    if (!accessible?.resource_names?.length) return;

    for (const resource of accessible.resource_names) {
      const customerId = resource.split('/')[1];
      try {
        const rows = await this.googleAdsService.query(customerId, 'SELECT customer.id, customer.descriptive_name, customer.manager FROM customer', null, config);
        const c = rows[0]?.customer;
        if (c?.manager) {
          await this.accountRepo.upsert({
            externalCustomerId: c.id.toString(),
            name: c.descriptive_name || 'Unnamed MCC',
            provider: AdsProvider.GOOGLE,
            isManager: true,
            credentialId: cred.id,
            lastSyncedAt: new Date(),
          }, ['externalCustomerId']);
        }
      } catch (err: any) {
        this.logger.warn(`Skipping customer ${customerId} discovery: ${err.message}`);
      }
    }

    // 2. Sync Client Accounts
    const mccs = await this.accountRepo.find({ where: { isManager: true, provider: AdsProvider.GOOGLE, credentialId: cred.id } });
    for (const mcc of mccs) {
      try {
        const clients = await this.googleAdsService.getClientAccounts(mcc.externalCustomerId, mcc.externalCustomerId, config);
        for (const r of clients) {
          const c = r.customer_client;
          if (!c.manager) {
            await this.accountRepo.upsert({
              externalCustomerId: c.id.toString(),
              name: c.descriptive_name || 'Unnamed Client',
              provider: AdsProvider.GOOGLE,
              isManager: false,
              parentId: mcc.id,
              credentialId: cred.id,
              status: mapGoogleAccountStatus(c.status),
              providerRawStatus: c.status != null ? String(c.status) : null,
              lastSyncedAt: new Date(),
            }, ['externalCustomerId']);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Skipping MCC ${mcc.externalCustomerId} client discovery: ${err.message}`);
      }
    }

    // 3. Sync Campaigns
    const activeClients = await this.accountRepo.find({ 
      where: { isManager: false, provider: AdsProvider.GOOGLE, credentialId: cred.id },
      relations: ['parent']
    });

    const limit = pLimit(3); // Sync 3 clients at a time
    const tasks = activeClients.map(client => limit(() => this.syncGoogleCampaigns(client, config, fullHistory)));
    await Promise.all(tasks);
  }

  private async syncGoogleCampaigns(client: AdsAccount, config: GoogleAdsConfig, fullHistory: boolean) {
    const mccId = client.parent?.externalCustomerId;
    if (!mccId) return;

    try {
      const rawCustomerStatus = await this.googleAdsService.getCustomerAccountStatus(
        client.externalCustomerId,
        mccId,
        config,
      );
      const accountStatus = mapGoogleAccountStatus(rawCustomerStatus);

      const infoRows = await this.googleAdsService.getCampaignInfo(client.externalCustomerId, mccId, config);
      const campaignInfoRows: DeepPartial<CampaignInfo>[] = infoRows.map(r => ({
        externalCampaignId: r.campaign.id.toString(),
        name: r.campaign.name,
        provider: AdsProvider.GOOGLE,
        campaignStartDate: toCampaignStartDate(
          r.campaign.start_date_time ??
            r.campaign.startDateTime ??
            r.campaign.start_date ??
            r.campaign.startDate,
        ),
        status: GOOGLE_STATUS_MAP[r.campaign.status] || CampaignStatus.UNKNOWN,
        providerRawStatus: r.campaign.status != null ? String(r.campaign.status) : null,
        campaignType: GOOGLE_TYPE_MAP[r.campaign.advertising_channel_type] || CampaignType.UNKNOWN,
        biddingStrategy: GOOGLE_BIDDING_MAP[r.campaign.bidding_strategy_type] || BiddingStrategy.UNKNOWN,
        optimizationScore: r.campaign.optimization_score || 0,
        dailyBudget: r.campaign_budget?.amount_micros ? r.campaign_budget.amount_micros / 1000000 : 0,
        adsAccountId: client.id,
        lastSyncedAt: new Date(),
      }));
      await this.infoRepo.upsert(campaignInfoRows, ['externalCampaignId']);

      await this.accountRepo.update(client.id, {
        status: accountStatus,
        providerRawStatus: rawCustomerStatus != null ? String(rawCustomerStatus) : null,
        lastSyncedAt: new Date(),
      });

      let startDate = 'YESTERDAY';
      let endDate = 'YESTERDAY';
      if (fullHistory) {
         startDate = '2025-09-01';
         const yesterday = new Date();
         yesterday.setDate(yesterday.getDate() - 1);
         endDate = yesterday.toISOString().split('T')[0];
      }

      try {
        const metricRowsRaw = await this.googleAdsService.getCampaigns(client.externalCustomerId, mccId, config, startDate, endDate);
        const infos = await this.infoRepo.find({ where: { adsAccountId: client.id } });
        const idMap = new Map(infos.map(i => [i.externalCampaignId, i.id]));

        const metricRows = metricRowsRaw.map(r => {
          const infoId = idMap.get(r.campaign.id.toString());
          if (!infoId) return null;
          const averageCpcMicros = Number(r.metrics.average_cpc ?? 0);
          const costMicros = Number(r.metrics.cost_micros ?? 0);
          const ctr = Number(r.metrics.ctr ?? 0);
          const searchImpressionShare = Number(r.metrics.search_impression_share ?? 0);
          const impressions = Number(r.metrics.impressions ?? 0);
          const clicks = Number(r.metrics.clicks ?? 0);
          const spend = Number.isFinite(costMicros) ? costMicros / 1000000 : 0;
          const hasActivity = impressions > 0 || clicks > 0 || spend > 0;
          if (!hasActivity) return null;
          return {
            campaignInfoId: infoId,
            date: r.segments.date,
            impressions,
            clicks,
            ctr: Number.isFinite(ctr) ? ctr : 0,
            avgCpc: Number.isFinite(averageCpcMicros) ? averageCpcMicros / 1000000 : 0,
            spend,
            searchImpressionShare: Number.isFinite(searchImpressionShare) ? searchImpressionShare : 0,
            updatedAt: new Date(),
          };
        }).filter(m => m !== null) as any[];

        const CHUNK_SIZE = 500;
        for (let i = 0; i < metricRows.length; i += CHUNK_SIZE) {
          await this.metricsRepo.upsert(metricRows.slice(i, i + CHUNK_SIZE), ['campaignInfoId', 'date']);
        }
      } catch (metricErr: any) {
        this.logger.warn(
          `Metrics sync failed for client ${client.externalCustomerId} (campaign info saved): ${metricErr.message}`,
        );
      }
    } catch (err: any) {
      if (isGoogleCustomerAccessLostError(err)) {
        await this.accountRepo.update(client.id, {
          status: AccountStatus.DEACTIVATED,
          lastSyncedAt: new Date(),
        });
        await this.infoRepo.update(
          { adsAccountId: client.id, provider: AdsProvider.GOOGLE },
          { status: CampaignStatus.UNKNOWN, lastSyncedAt: new Date() },
        );
        this.logger.warn(
          `Marked Google account ${client.externalCustomerId} DEACTIVATED and campaigns UNKNOWN (access lost)`,
        );
      }
      this.logger.error(`Error syncing campaigns for client ${client.externalCustomerId}: ${err.message}`);
    }
  }

  private async syncMetaProvider(cred: AdsCredential, fullHistory: boolean) {
    this.logger.log(`Syncing Meta Ads for credential: ${cred.name}`);
    const accessToken = cred.refreshToken; // We store Meta Access Token in refreshToken column

    // 1. Sync Ad Accounts
    const accounts = await this.metaAdsService.listAdAccounts(accessToken);
    for (const acc of accounts) {
      await this.accountRepo.upsert({
        externalCustomerId: acc.id,
        name: acc.name,
        provider: AdsProvider.META,
        isManager: false,
        credentialId: cred.id,
        currencyCode: acc.currency,
        timeZone: acc.timezone_name,
        lastSyncedAt: new Date(),
      }, ['externalCustomerId']);
    }

    // 2. Sync Campaigns & Metrics
    const activeAccounts = await this.accountRepo.find({ 
      where: { provider: AdsProvider.META, credentialId: cred.id } 
    });

    const limit = pLimit(2); // Meta API is more restrictive
    const tasks = activeAccounts.map(acc => limit(() => this.syncMetaCampaigns(acc, accessToken, fullHistory)));
    await Promise.all(tasks);
  }

  private async syncMetaCampaigns(acc: AdsAccount, accessToken: string, fullHistory: boolean) {
    try {
      // Fetch Campaigns
      const metaCampaigns = await this.metaAdsService.getCampaigns(acc.externalCustomerId, accessToken);
      const campaignInfoRows: DeepPartial<CampaignInfo>[] = metaCampaigns.map(c => ({
        externalCampaignId: c.id,
        name: c.name,
        provider: AdsProvider.META,
        status: META_STATUS_MAP[c.status] || CampaignStatus.UNKNOWN,
        providerRawStatus: c.status != null ? String(c.status) : null,
        campaignType: CampaignType.DISPLAY, // Default for Meta
        dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : 0,
        adsAccountId: acc.id,
        lastSyncedAt: new Date(),
      }));
      await this.infoRepo.upsert(campaignInfoRows, ['externalCampaignId']);

      // Fetch Insights (Metrics)
      let startDate = 'yesterday';
      let endDate = 'yesterday';
      let insightRowsRaw: any[] = [];

      if (fullHistory) {
        startDate = '2025-09-01';
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        endDate = yesterday.toISOString().split('T')[0];
        insightRowsRaw = await this.metaAdsService.getInsightsForRange(acc.externalCustomerId, accessToken, startDate, endDate);
      } else {
        insightRowsRaw = await this.metaAdsService.getInsights(acc.externalCustomerId, accessToken, 'yesterday');
      }

      const infos = await this.infoRepo.find({ where: { adsAccountId: acc.id } });
      const idMap = new Map(infos.map(i => [i.externalCampaignId, i.id]));

      const metricRows = insightRowsRaw.map(r => {
        const infoId = idMap.get(r.campaign_id);
        if (!infoId) return null;
        return {
          campaignInfoId: infoId,
          date: r.date_start,
          impressions: Number(r.impressions),
          clicks: Number(r.clicks),
          ctr: Number(r.ctr),
          avgCpc: Number(r.cpc || 0),
          spend: Number(r.spend),
          updatedAt: new Date(),
        };
      }).filter(m => m !== null) as any[];

      const CHUNK_SIZE = 500;
      for (let i = 0; i < metricRows.length; i += CHUNK_SIZE) {
        await this.metricsRepo.upsert(metricRows.slice(i, i + CHUNK_SIZE), ['campaignInfoId', 'date']);
      }
    } catch (err: any) {
      this.logger.error(`Error syncing Meta campaigns for account ${acc.externalCustomerId}: ${err.message}`);
    }
  }
}
