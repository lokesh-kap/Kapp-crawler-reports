import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Repository } from 'typeorm';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseLeadsDataEntity } from './entities/client-wise-leads-data.entity';
import { ClientWiseSummaryDataEntity } from './entities/client-wise-summary-data.entity';
import { NpfFunnelSummaryEntity } from './entities/npf-funnel-summary.entity';
import { ScrapingDataService, type ScrapeFieldConfig, type ScrapeListOptions, type ScrapeSchema, type ScrapeFieldConfig as ScrapeField } from './scraping-data.service';
import {
  FormFillerService,
  type DateFillStrategy,
  type FormFieldConfig,
  type FormFieldType,
} from './form-filler.service';
import { HandlePaginationService, type PaginationOptions } from './handle-pagination.service';
import { PlaywrightService } from './playwright.service';
import type { Page } from 'playwright';
import type { ScrapeTargetDto } from './dto/scrape-target.dto';
import { ClientWiseLeadsConfigEntity as LeadsCfg } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity as SummaryCfg } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseStepEntity } from '../client-wise/entities/client-wise-step.entity';
import { ExtractionConfigService } from '../extraction-config/extraction-config.service';
import { DynamicExtractionService } from './dynamic-extraction.service';
import { QueueManagerService } from '../common/providers/queue-service/queue-manager.service';
import { WorkerManagerService } from '../common/providers/queue-service/worker-manager.service';
import { Job } from 'bullmq';
import { createHash } from 'crypto';

type TargetKind = 'leads' | 'summary' | 'npf_funnel';
type StepGroup = 'normal' | 'advanced' | 'extra';
export type NpfScrapeWarning = {
  client_id: number;
  client_wise_id: number;
  status: 'filter_not_found' | 'metrics_not_found' | 'dom_fallback_incomplete';
  filter_applied: string;
  message: string;
  occurred_at: string;
};
type NpfFilterApplyResult =
  | { applied: true }
  | { applied: false; reason: 'filter_not_found' | 'dom_fallback_incomplete'; message: string };
type NpfApiSummaryState = {
  seq: number;
  latest: Record<string, unknown> | null;
  latestPayloadHash: string | null;
  latestPayloadSize: number;
  currentPassLabel: string | null;
  byPass: Map<
    string,
    {
      seq: number;
      latest: Record<string, unknown> | null;
      payloadHash: string | null;
      payloadSize: number;
    }
  >;
};
type ScrapeWriteJob = {
  target: TargetKind;
  rows: Record<string, unknown>[];
  meta: { client_id: number; year: number; user_id: number; config_id: number };
};
type ApplyFiltersOptions = {
  clientId?: number;
  throwOnFailure?: boolean;
  contextLabel?: string;
  /** When set, one reload of this URL per filter item if locator readiness fails (campaign summary view). */
  reloadSummaryUrl?: string;
};
type ApplyFiltersResult = {
  appliedCount: number;
  failedCount: number;
  failedItems: string[];
};
type ScrapeTargetRunOptions = {
  page?: Page;
  skipLogin?: boolean;
  skipAllFilters?: boolean;
};

@Injectable()
export class ScrapperService implements OnModuleInit {
  private readonly logger = new Logger(ScrapperService.name);
  private static readonly WRITE_QUEUE_NAME = 'scrape-db-write-queue';
  private readonly npfAdaptivePenaltyByClient = new Map<
    number,
    { refresh: number; metrics: number }
  >();

  constructor(
    @InjectRepository(ClientWiseEntity)
    private readonly clientWiseRepository: Repository<ClientWiseEntity>,
    @InjectRepository(ClientWiseLeadsConfigEntity)
    private readonly leadsConfigRepository: Repository<ClientWiseLeadsConfigEntity>,
    @InjectRepository(ClientWiseSummaryConfigEntity)
    private readonly summaryConfigRepository: Repository<ClientWiseSummaryConfigEntity>,
    @InjectRepository(ClientWiseLeadsDataEntity)
    private readonly leadsDataRepository: Repository<ClientWiseLeadsDataEntity>,
    @InjectRepository(ClientWiseSummaryDataEntity)
    private readonly summaryDataRepository: Repository<ClientWiseSummaryDataEntity>,
    @InjectRepository(ClientWiseStepEntity)
    private readonly stepRepository: Repository<ClientWiseStepEntity>,
    @InjectRepository(NpfFunnelSummaryEntity)
    private readonly npfFunnelRepository: Repository<NpfFunnelSummaryEntity>,
    private readonly playwrightService: PlaywrightService,
    private readonly formFillerService: FormFillerService,
    private readonly scrapingDataService: ScrapingDataService,
    private readonly paginationService: HandlePaginationService,
    private readonly extractionConfigService: ExtractionConfigService,
    private readonly dynamicExtractionService: DynamicExtractionService,
    private readonly queueManagerService: QueueManagerService,
    private readonly workerManagerService: WorkerManagerService,
  ) { }

  private getAdaptiveNpfWaitMs(
    kind: 'refresh' | 'metrics',
    baseMs: number,
    clientId?: number,
  ): number {
    if (!clientId) return baseMs;
    const penalty = this.npfAdaptivePenaltyByClient.get(clientId)?.[kind] ?? 0;
    const stepMs = this.getEnvInt('SCRAPER_NPF_ADAPTIVE_STEP_MS', 15000);
    const maxMs = this.getEnvInt('SCRAPER_NPF_ADAPTIVE_MAX_WAIT_MS', 180000);
    return Math.min(maxMs, baseMs + penalty * stepMs);
  }

  private updateAdaptiveNpfPenalty(
    kind: 'refresh' | 'metrics',
    timedOut: boolean,
    clientId?: number,
  ): void {
    if (!clientId) return;
    const current = this.npfAdaptivePenaltyByClient.get(clientId) ?? {
      refresh: 0,
      metrics: 0,
    };
    const next = { ...current };
    if (timedOut) {
      next[kind] = Math.min(5, next[kind] + 1);
    } else {
      next[kind] = Math.max(0, next[kind] - 1);
    }
    this.npfAdaptivePenaltyByClient.set(clientId, next);
  }

  private withClientContext(message: string, clientId?: number): string {
    return `[client_id=${clientId ?? 'n/a'}] ${message}`;
  }

  private npfWarn(message: string, clientId?: number): void {
    this.logger.warn(this.withClientContext(message, clientId));
  }

  private npfError(message: string, clientId?: number, stack?: string): void {
    this.logger.error(this.withClientContext(message, clientId), stack);
  }

  private async waitForFixedLoaderToClear(
    page: Page,
    timeoutMs: number,
    clientId?: number,
    context = 'unknown',
  ): Promise<boolean> {
    const pollMs = 400;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const loaderVisible = await page
        .evaluate(() => {
          return Array.from(
            document.querySelectorAll('.fixed-loader, .ng-spinner-loader'),
          ).some((n) => {
            const el = n as HTMLElement;
            return !!(el.offsetParent || el.getClientRects().length);
          });
        })
        .catch(() => false);
      if (!loaderVisible) return true;
      await page.waitForTimeout(pollMs);
    }

    this.npfWarn(
      `Loader remained visible for ${timeoutMs}ms (${context}); interactions may be blocked.`,
      clientId,
    );
    return false;
  }

  private async isLikelyLoginPage(page: Page): Promise<boolean> {
    const url = (page.url() || '').toLowerCase();
    if (url.includes('login') || url.includes('signin') || url.includes('sign-in')) {
      return true;
    }
    const passwordInputs = await page
      .locator("input[type='password']")
      .count()
      .catch(() => 0);
    return passwordInputs > 0;
  }

  private async ensureNpfLeadViewReady(
    page: Page,
    dto: ScrapeTargetDto,
    clientWise: ClientWiseEntity,
    leadUrl: string,
  ): Promise<void> {
    await page.goto(leadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (await this.isLikelyLoginPage(page)) {
      this.npfWarn(
        'Detected logged-out state after reload; re-authenticating before continuing.',
        clientWise.client_id,
      );
      await this.login(page, dto, clientWise);
      await page.goto(leadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page
      .waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 20000 })
      .catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await this.waitForFixedLoaderToClear(
      page,
      this.getEnvInt('SCRAPER_NPF_LOADER_WAIT_MS', 15000),
      clientWise.client_id,
      'ensureNpfLeadViewReady',
    );
  }

  private async waitForNpfFilterPanelReady(
    page: Page,
    clientId: number,
    contextLabel: string,
    timeoutMs = 12000,
  ): Promise<boolean> {
    const panel = page.locator('app-fieldsearch form').first();
    const college = page
      .locator("xpath=//app-fieldsearch//ng-select[@formcontrolname='college_id']")
      .first();
    const source = page
      .locator("xpath=//app-fieldsearch//ng-select[@formcontrolname='publisher_id']")
      .first();

    const ready = await (async () => {
      try {
        await panel.waitFor({ state: 'visible', timeout: timeoutMs });
      } catch {
        return false;
      }
      const collegeCount = await college.count().catch(() => 0);
      const sourceCount = await source.count().catch(() => 0);
      return collegeCount > 0 || sourceCount > 0;
    })();

    if (!ready) {
      this.npfWarn(
        `Filter panel not ready (${contextLabel}); app-fieldsearch/filters missing in DOM.`,
        clientId,
      );
    }
    return ready;
  }

  private async applyNpfBaseFiltersWithRecovery(
    page: Page,
    dto: ScrapeTargetDto,
    clientWise: ClientWiseEntity,
    leadsConfig: ClientWiseLeadsConfigEntity,
  ): Promise<void> {
    const maxReloadRetries = this.getEnvInt('SCRAPER_NPF_FILTER_RELOAD_RETRIES', 1);
    let forcedReloginTried = false;
    for (let attempt = 0; attempt <= maxReloadRetries; attempt += 1) {
      try {
        const panelReady = await this.waitForNpfFilterPanelReady(
          page,
          clientWise.client_id,
          `npf_base_filters_attempt_${attempt + 1}-precheck`,
        );
        if (!panelReady) {
          throw new Error('dom_not_ready: filter panel not present');
        }

        await this.applyFilters(page, leadsConfig.filters ?? [], {
          clientId: clientWise.client_id,
          throwOnFailure: true,
          contextLabel: `npf_base_filters_attempt_${attempt + 1}`,
        });
        await page.click('body', { force: true }).catch(() => null);
        const searchBtn = page
          .locator("//button[contains(., 'Search')] | //a[contains(., 'Search')]")
          .first();
        if (await searchBtn.isVisible()) {
          await searchBtn.click({ force: true });
          await page
            .waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 20000 })
            .catch(() => null);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
        }
        return;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.npfWarn(
          `Base filters failed on attempt ${attempt + 1}/${maxReloadRetries + 1}: ${errorMessage}`,
          clientWise.client_id,
        );
        if (attempt >= maxReloadRetries) {
          throw err;
        }
        this.npfWarn(
          `Reloading lead view and retrying base filters (attempt ${attempt + 2}/${maxReloadRetries + 1})`,
          clientWise.client_id,
        );
        await this.ensureNpfLeadViewReady(page, dto, clientWise, leadsConfig.url);

        const panelReadyAfterReload = await this.waitForNpfFilterPanelReady(
          page,
          clientWise.client_id,
          `npf_base_filters_attempt_${attempt + 1}-after-reload`,
        );
        if (!panelReadyAfterReload && !forcedReloginTried) {
          forcedReloginTried = true;
          this.npfWarn(
            'Filter panel still missing after reload; forcing fresh login once before next retry.',
            clientWise.client_id,
          );
          await this.login(page, dto, clientWise);
          await this.ensureNpfLeadViewReady(page, dto, clientWise, leadsConfig.url);
        }
      }
    }
  }

  /** Same settle sequence used after navigating to NPF summary (campaign API) URL. */
  private async ensureNpfCampaignSummaryPageReady(page: Page, summaryUrl: string): Promise<void> {
    await page.goto(summaryUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(1500);
  }

  private async applyNpfCampaignBaseFiltersWithRecovery(
    page: Page,
    summaryFilters: Array<any>,
    clientId: number,
    summaryUrl: string,
  ): Promise<void> {
    const rawCampaign = process.env.SCRAPER_NPF_CAMPAIGN_FILTER_RELOAD_RETRIES;
    const maxReloadRetries =
      rawCampaign !== undefined && String(rawCampaign).trim() !== ''
        ? this.getEnvInt('SCRAPER_NPF_CAMPAIGN_FILTER_RELOAD_RETRIES', 1)
        : this.getEnvInt('SCRAPER_NPF_FILTER_RELOAD_RETRIES', 1);

    for (let attempt = 0; attempt <= maxReloadRetries; attempt += 1) {
      try {
        await this.applyFilters(page, summaryFilters, {
          clientId,
          throwOnFailure: true,
          contextLabel: `npf_campaign_api_base_filters_attempt_${attempt + 1}`,
          reloadSummaryUrl: summaryUrl,
        });
        return;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Campaign API base filters failed on attempt ${attempt + 1}/${maxReloadRetries + 1} client_id=${clientId}: ${errorMessage}`,
        );
        if (attempt >= maxReloadRetries) {
          throw err;
        }
        this.logger.warn(
          `Reloading NPF summary view and retrying campaign base filters (attempt ${attempt + 2}/${maxReloadRetries + 1}) client_id=${clientId}`,
        );
        await this.ensureNpfCampaignSummaryPageReady(page, summaryUrl);
      }
    }
  }

  onModuleInit() {
    this.queueManagerService.getQueue(ScrapperService.WRITE_QUEUE_NAME);
    if (!this.workerManagerService.hasWorker(ScrapperService.WRITE_QUEUE_NAME)) {
      this.workerManagerService.registerWorker<ScrapeWriteJob>({
        queueName: ScrapperService.WRITE_QUEUE_NAME,
        concurrency: 3,
        processor: async (job: Job<ScrapeWriteJob>) => {
          return this.saveScrapedDataDirectly(job.data);
        },
      });
    }
  }

  private async saveScrapedDataDirectly(payload: ScrapeWriteJob) {
    try {
      const entities = payload.rows.map((row) =>
        this.mapLeadOrSummaryRowToEntity(payload.target, row, payload.meta),
      );
      if (!entities.length) return { saved: 0 };
      if (payload.target === 'leads') {
        await this.leadsDataRepository.save(entities as ClientWiseLeadsDataEntity[]);
      } else if (payload.target === 'summary') {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setDate(tomorrowStart.getDate() + 1);

        // Keep summary writes idempotent for a client/day.
        await this.summaryDataRepository.delete({
          client_id: payload.meta.client_id,
          created_at: Between(todayStart, tomorrowStart),
        });
        await this.summaryDataRepository.save(entities as ClientWiseSummaryDataEntity[]);
      } else if (payload.target === 'npf_funnel') {
        const npfEntities = entities as NpfFunnelSummaryEntity[];
        let savedCount = 0;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        for (const entity of npfEntities) {
          const latest = await this.npfFunnelRepository.findOne({
            where: {
              client_id: entity.client_id,
              year: entity.year,
              filter_applied: entity.filter_applied,
              funnel_source: entity.funnel_source,
              instance_filter: entity.instance_filter,
              created_at: MoreThanOrEqual(todayStart),
            },
            // Use insertion sequence to get the true previous row.
            order: { id: 'DESC' },
          });

          const isDuplicate =
            !!latest &&
            latest.source === entity.source &&
            latest.primary_leads === entity.primary_leads &&
            latest.secondary_leads === entity.secondary_leads &&
            latest.tertiary_leads === entity.tertiary_leads &&
            latest.total_instances === entity.total_instances &&
            latest.verified_leads === entity.verified_leads &&
            latest.unverified_leads === entity.unverified_leads &&
            latest.form_initiated === entity.form_initiated &&
            latest.paid_applications === entity.paid_applications &&
            latest.submit_applications === entity.submit_applications &&
            latest.enrolments === entity.enrolments;

          if (isDuplicate) {
            this.logger.log(
              `Skipping duplicate npf_funnel row client_id=${entity.client_id} filter=${entity.filter_applied} source=${entity.funnel_source}`,
            );
            continue;
          }

          await this.npfFunnelRepository.save(entity);
          savedCount += 1;
        }
        this.logger.log(`✅ Directly saved ${savedCount} rows for target: ${payload.target}`);
        return { saved: savedCount };
      }
      this.logger.log(`✅ Directly saved ${entities.length} rows for target: ${payload.target}`);
      return { saved: entities.length };
    } catch (error) {
      this.logger.error(`Failed to save data directly for ${payload.target}: ${error.message}`, error.stack);
      return { saved: 0, error: error.message };
    }
  }

  /** NPF API/UI metric: missing or N/A → null; literal zero stays "0". */
  private normalizeNpfMetricValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Number.isNaN(value)) return null;
      if (value === 0) return '0';
      return Number.isInteger(value) ? String(value) : String(value);
    }
    const raw = String(value).trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (
      /^n\/?a$/i.test(raw) ||
      lower === 'n.a.' ||
      lower === 'not available' ||
      lower === 'null' ||
      lower === 'undefined' ||
      lower === '-' ||
      lower === '--' ||
      raw === '—' ||
      raw === '–' ||
      lower === 'nil'
    ) {
      return null;
    }
    const cleaned = raw.replace(/,/g, '').replace(/\s+/g, '');
    if (!cleaned) return null;
    const num = Number(cleaned);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return num === 0 ? '0' : Number.isInteger(num) ? String(num) : String(num);
    }
    return null;
  }

  private mapNpfApiSummaryToTotals(
    payload: Record<string, unknown> | null,
  ): Record<string, string | null> | null {
    if (!payload) return null;
    const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
    if (!data || typeof data !== 'object') return null;

    return {
      primary_leads: this.normalizeNpfMetricValue(data.primaryLeads),
      secondary_leads: this.normalizeNpfMetricValue(data.secondaryLeads),
      tertiary_leads: this.normalizeNpfMetricValue(data.tertiaryLeads),
      total_instances: this.normalizeNpfMetricValue(data.totalLeads),
      verified_leads: this.normalizeNpfMetricValue(data.verifiedLeads),
      unverified_leads: this.normalizeNpfMetricValue(data.unverifiedLeads),
      form_initiated: this.normalizeNpfMetricValue(data.formInitiated),
      paid_applications: this.normalizeNpfMetricValue(data.applications),
      submit_applications: this.normalizeNpfMetricValue(
        data.submittedApplications ?? data.submittedApplication,
      ),
      enrolments: this.normalizeNpfMetricValue(data.enrolments),
    };
  }

  private hashPayload(payload: string): string {
    return createHash('sha1').update(payload).digest('hex').slice(0, 12);
  }

  private async isNpfNoDataVisible(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const bodyText = (document.body?.innerText ?? '').toLowerCase();
        return bodyText.includes('no record found') || bodyText.includes('no data found');
      })
      .catch(() => false);
  }

  private async saveNpfNullNoneRowAndStop(
    clientWise: ClientWiseEntity,
    instanceVal: string,
    reason: string,
  ): Promise<void> {
    const nullTotals: Record<string, string | null> = {
      primary_leads: null,
      secondary_leads: null,
      tertiary_leads: null,
      total_instances: null,
      verified_leads: null,
      unverified_leads: null,
      form_initiated: null,
      paid_applications: null,
      submit_applications: null,
      enrolments: null,
    };
    await this.saveScrapedDataDirectly({
      target: 'npf_funnel' as TargetKind,
      rows: [
        {
          ...nullTotals,
          data_source: 'npf_api',
          source: 'GLOBAL',
          filter_applied: 'None',
          funnel_source: 'lead_view',
          instance_filter: String(instanceVal),
        },
      ],
      meta: {
        client_id: clientWise.client_id,
        year: clientWise.year,
        user_id: clientWise.user_id,
        config_id: clientWise.config_id!,
      },
    });
    this.logger.log(
      `[LEAD VIEW] No data for None filter. Saved null totals and stopped client_id=${clientWise.client_id}. Reason=${reason}`,
    );
  }

  private async waitForNpfApiSummaryAdvance(
    getApiSeq: () => number,
    baselineSeq: number,
    reason: string,
    clientId?: number,
  ): Promise<boolean> {
    const maxWaitMs = this.getEnvInt('SCRAPER_NPF_API_WAIT_MS', 30000);
    const pollMs = this.getEnvInt('SCRAPER_NPF_API_POLL_MS', 500);
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      if (getApiSeq() > baselineSeq) return true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.npfWarn(
      `NPF API summary did not update within ${maxWaitMs}ms for ${reason} (baseline_seq=${baselineSeq}, current_seq=${getApiSeq()})`,
      clientId,
    );
    return false;
  }

  async scrapeNpfFunnelData(dto: ScrapeTargetDto, opts?: { page?: import('playwright').Page; skipLogin?: boolean }) {
    this.logger.log(`Starting optimized NPF Funnel scrape for client_id=${dto.client_id}`);

    let clientWise: ClientWiseEntity | null = null;
    if (dto.client_wise_id) {
      clientWise = await this.clientWiseRepository.findOne({ where: { id: dto.client_wise_id } });
    } else {
      clientWise = await this.clientWiseRepository.findOne({
        where: { client_id: dto.client_id, year: dto.year },
        order: { id: 'DESC' },
      });
    }
    if (!clientWise) throw new NotFoundException('Client config not found');

    const leadsConfig = await this.leadsConfigRepository.findOne({ where: { client_wise_id: clientWise.id } });
    if (!leadsConfig) throw new NotFoundException('No NPF lead_view config found');

    const browser = opts?.page ? null : await this.playwrightService.createBrowser({ useProxy: dto.use_proxy ?? false });
    const page = opts?.page || browser!.page;
    const warnings: NpfScrapeWarning[] = [];
    const apiSummaryState: NpfApiSummaryState = {
      seq: 0,
      latest: null,
      latestPayloadHash: null,
      latestPayloadSize: 0,
      currentPassLabel: null,
      byPass: new Map(),
    };
    const apiSummaryListener = async (response: any) => {
      try {
        const req = response.request?.();
        const method = req?.method?.();
        const url = response.url?.() ?? '';
        if (
          method === 'POST' &&
          url.includes('/publishers/v1/getLeadDetailsSummary') &&
          response.status?.() === 200
        ) {
          const payload = req?.postData?.() ?? '';
          const body = (await response.json().catch(() => null)) as
            | Record<string, unknown>
            | null;
          if (body) {
            apiSummaryState.latest = body;
            apiSummaryState.seq += 1;
            apiSummaryState.latestPayloadSize = payload.length;
            apiSummaryState.latestPayloadHash = payload
              ? this.hashPayload(payload)
              : null;
            const passLabel = apiSummaryState.currentPassLabel;
            if (passLabel) {
              apiSummaryState.byPass.set(passLabel, {
                seq: apiSummaryState.seq,
                latest: body,
                payloadHash: apiSummaryState.latestPayloadHash,
                payloadSize: apiSummaryState.latestPayloadSize,
              });
            }
            this.logger.log(
              `Captured NPF summary API response (seq=${apiSummaryState.seq}, pass=${passLabel ?? 'unbound'}, payload_size=${apiSummaryState.latestPayloadSize}, payload_hash=${apiSummaryState.latestPayloadHash ?? 'none'})`,
            );
          }
        }
      } catch {
        // best effort; keep DOM fallback path
      }
    };
    page.on('response', apiSummaryListener);

    try {
      if (!opts?.skipLogin) {
        await this.login(page, dto, clientWise);
        await page.locator("//button[contains(text(), 'Close')] | //button[contains(text(), 'Got it')] | //a[@id='dismiss-modal']").first().click({ timeout: 5000 }).catch(() => null);
      } else {
        this.logger.log(`Skipping login, reusing existing session for ${clientWise.client_id}`);
      }

      const filterPasses = [
        { label: 'None', filterValue: null },
        { label: 'Form Initiated', filterValue: 'Form Initiated' },
        { label: 'Paid Apps', filterValue: 'Paid Applications' },
        { label: 'Enrolment Status', filterValue: 'Enrolment Status' },
      ];

      // --- PART 1: LEAD VIEW (FINISH ALL PASSES HERE FIRST) ---
      if (leadsConfig) {
        this.logger.log('🚀 [PART 1] STARTING ALL LEAD VIEW PASSES...');
        const currentUrl = page.url();
        const normalizeUrl = (u: string) => u.split('?')[0].replace(/\/+$/, '').toLowerCase();
        const alreadyOnLeadView =
          !!currentUrl &&
          normalizeUrl(currentUrl) === normalizeUrl(leadsConfig.url);
        if (alreadyOnLeadView) {
          this.logger.log(`Lead view already open after login, skipping reload: ${currentUrl}`);
        } else {
          await page.goto(leadsConfig.url, { waitUntil: 'load', timeout: 60000 });
        }
        await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => { });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
        await page.waitForTimeout(2000);

        this.logger.log('Applying Base Filters to Lead View (Once)...');
        if (leadsConfig.filters?.length) {
          try {
            await this.applyNpfBaseFiltersWithRecovery(page, dto, clientWise, leadsConfig);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const isClientDropdownMiss =
              /NPF dropdown option not found/i.test(errorMessage) ||
              /client_not_in_dropdown/i.test(errorMessage);
            if (isClientDropdownMiss) {
              warnings.push({
                client_id: clientWise.client_id,
                client_wise_id: clientWise.id,
                status: 'filter_not_found',
                filter_applied: 'None',
                message: `client_not_in_dropdown: ${errorMessage}`,
                occurred_at: new Date().toISOString(),
              });
              this.npfWarn(
                `[LEAD VIEW] Client option missing in dropdown; skipping save for client_id=${clientWise.client_id}`,
                clientWise.client_id,
              );
              return { status: 'success', warnings };
            }
            throw err;
          }
        }

        const instanceVal = leadsConfig.filters?.find(f => f.name?.toLowerCase() === 'instance')?.value_to_apply || 'Instance';

        let previousFilter: string | null = null;
        for (const pass of filterPasses) {
          const passLabel = pass.label;
          apiSummaryState.currentPassLabel = passLabel;
          const apiSeqBeforePass = apiSummaryState.byPass.get(passLabel)?.seq ?? 0;
          this.logger.log(`\n\n📝 [LEAD VIEW] - Step: ${pass.label}`);
          let filterApplied = true;
          if (pass.filterValue) {
            const filterResult = await this.applyNpfFilter(
              page,
              pass.filterValue,
              previousFilter,
              clientWise.client_id,
              () => apiSummaryState.seq,
            );
            filterApplied = filterResult.applied;
            if (!filterResult.applied) {
              warnings.push({
                client_id: clientWise.client_id,
                client_wise_id: clientWise.id,
                status: filterResult.reason,
                filter_applied: pass.label,
                message: filterResult.message,
                occurred_at: new Date().toISOString(),
              });
              this.npfWarn(
                `[LEAD VIEW] Skipping save for "${pass.label}" because filter was not available/applied.`,
                clientWise.client_id,
              );
              continue;
            }
            previousFilter = pass.filterValue;
          } else {
            // 🔥 THIS IS THE FIX → ONLY FOR "None"
            this.logger.log('⏳ Waiting for initial (None) data to load...');
        
            await page.waitForFunction(() => {
              const hasBoxes = document.querySelectorAll('.info-box-number').length > 0;
              const noData = document.body.innerText.includes('No Record Found');
              return hasBoxes || noData;
            }, { timeout: 20000 }).catch(() => null);
        
            await page.waitForTimeout(1000);
          }

          await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => { });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
          const noDataVisible = pass.label === 'None' ? await this.isNpfNoDataVisible(page) : false;
          const apiUpdated = await this.waitForNpfApiSummaryAdvance(
            () => apiSummaryState.byPass.get(passLabel)?.seq ?? 0,
            apiSeqBeforePass,
            `lead_view:${pass.label}`,
            clientWise.client_id,
          );
          if (!apiUpdated) {
            if (pass.label === 'None' && noDataVisible) {
              await this.saveNpfNullNoneRowAndStop(
                clientWise,
                String(instanceVal),
                'no_record_found_without_api_update',
              );
              return { status: 'success', warnings };
            }
            warnings.push({
              client_id: clientWise.client_id,
              client_wise_id: clientWise.id,
              status: 'metrics_not_found',
              filter_applied: pass.label,
              message: `[LEAD VIEW] NPF summary API response not captured for "${pass.label}"`,
              occurred_at: new Date().toISOString(),
            });
            this.logger.warn(
              `[LEAD VIEW] API summary not available for "${pass.label}" (client_id=${clientWise.client_id}).`,
            );
            continue;
          }

          let globalTotals: Record<string, string | null> | null = null;
          const passApi = apiSummaryState.byPass.get(passLabel);
          if (passApi && passApi.seq > apiSeqBeforePass) {
            globalTotals = this.mapNpfApiSummaryToTotals(passApi.latest);
            if (globalTotals) {
              this.logger.log(
                `[LEAD VIEW] Using API totals for "${pass.label}" (seq=${passApi.seq}, payload_hash=${passApi.payloadHash ?? 'none'})`,
              );
            }
          }

          if (!globalTotals) {
            if (pass.label === 'None' && noDataVisible) {
              await this.saveNpfNullNoneRowAndStop(
                clientWise,
                String(instanceVal),
                'no_record_found_with_unmapped_api_payload',
              );
              return { status: 'success', warnings };
            }
            // HTML summary-box scraping intentionally disabled for API-only testing.
            // Keep old DOM extraction block commented for easy rollback.
            //
            // globalTotals = await page.evaluate(() => {
            //   const data: any = { primary_leads: '0', secondary_leads: '0', tertiary_leads: '0', total_instances: '0', verified_leads: '0', unverified_leads: '0', form_initiated: '0', paid_applications: '0', submit_applications: '0', enrolments: '0' };
            //   const boxes = Array.from(document.querySelectorAll('.info-box, .summary-card, [class*="info-box"]'));
            //   boxes.forEach(box => {
            //     const label = (box.querySelector('.info-box-text, .summary-label, label')?.textContent || '').trim().toLowerCase();
            //     const num = (box.querySelector('.info-box-number, .summary-count, .count')?.textContent || '').trim().replace(/,/g, '') || '0';
            //     if (label.includes('unverified leads')) data.unverified_leads = num;
            //     else if (label.includes('verified leads')) data.verified_leads = num;
            //     else if (label.includes('primary leads')) data.primary_leads = num;
            //     else if (label.includes('secondary leads')) data.secondary_leads = num;
            //     else if (label.includes('tertiary leads')) data.tertiary_leads = num;
            //     else if (label.includes('total instances')) data.total_instances = num;
            //     else if (label.includes('form initiated')) data.form_initiated = num;
            //     else if (label.includes('paid application')) data.paid_applications = num;
            //     else if (label.includes('submitted application')) data.submit_applications = num;
            //     else if (label.includes('enrolment')) data.enrolments = num;
            //   });
            //   return data;
            // });
            // this.logger.log(`[LEAD VIEW] API totals unavailable; used DOM totals for "${pass.label}"`);
            warnings.push({
              client_id: clientWise.client_id,
              client_wise_id: clientWise.id,
              status: 'metrics_not_found',
              filter_applied: pass.label,
              message: `[LEAD VIEW] API totals mapping failed for "${pass.label}"`,
              occurred_at: new Date().toISOString(),
            });
            this.logger.warn(
              `[LEAD VIEW] API totals mapping failed for "${pass.label}" (client_id=${clientWise.client_id}); skipping save.`,
            );
            continue;
          }

          if (
            pass.label === 'None' &&
            Object.values(globalTotals).every((v) => v === null)
          ) {
            await this.saveNpfNullNoneRowAndStop(
              clientWise,
              String(instanceVal),
              'api_totals_all_null_for_none_filter',
            );
            return { status: 'success', warnings };
          }

          this.logger.log(`   📊 Result (${pass.label}): ${JSON.stringify(globalTotals)}`);
          const jobData = {
            target: 'npf_funnel' as TargetKind,
            rows: [{
              ...globalTotals,
              data_source: 'npf_api',
              source: 'GLOBAL',
              filter_applied: pass.label,
              funnel_source: 'lead_view',
              instance_filter: String(instanceVal),
            }],
            meta: { client_id: clientWise.client_id, year: clientWise.year, user_id: clientWise.user_id, config_id: clientWise.config_id! },
          };
          
          // NPF Funnel data is tiny (1 row), so we save directly to DB without using the Redis queue
          await this.saveScrapedDataDirectly(jobData);
        }
        apiSummaryState.currentPassLabel = null;
      }

      // --- PART 2: CAMPAIGN VIEW ---
      // Intentionally disabled for now. We only scrape/store lead_view funnel rows.
      // Kept old campaign_view implementation commented (as requested).
      //
      // if (summaryConfig) {
      //   this.logger.log('🚀 [PART 2] STARTING ALL CAMPAIGN VIEW PASSES...');
      //   await page.goto(summaryConfig.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      //   await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => { });
      //   await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
      //   await page.waitForTimeout(2000);
      //
      //   this.logger.log('Applying Base Filters to Campaign View (Once)...');
      //   if (summaryConfig.filters?.length) {
      //     await this.applyFilters(page, summaryConfig.filters);
      //     const searchBtn = page.locator("//button[contains(., 'Search')] | //a[contains(., 'Search')]").first();
      //     if (await searchBtn.isVisible()) {
      //       await searchBtn.click({ force: true });
      //       await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 20000 }).catch(() => { });
      //       await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
      //     }
      //   }
      //
      //   const instanceVal = summaryConfig.filters?.find(f => f.name?.toLowerCase() === 'instance')?.value_to_apply || 'Instance';
      //   let previousFilter: string | null = null;
      //
      //   for (const pass of filterPasses) {
      //     this.logger.log(`\n\n📝 [CAMPAIGN VIEW] - Step: ${pass.label}`);
      //     let filterApplied = true;
      //     if (pass.filterValue) {
      //       filterApplied = await this.applyNpfFilter(page, pass.filterValue, previousFilter);
      //       if (!filterApplied) {
      //         this.logger.warn(`[CAMPAIGN VIEW] Skipping save for "${pass.label}" because filter was not available/applied.`);
      //         continue;
      //       }
      //       previousFilter = pass.filterValue;
      //     }
      //
      //     await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => { });
      //     await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
      //     await page.waitForFunction(
      //       () => (document.querySelectorAll('.info-box, .summary-card, [class*="info-box"]').length > 0) || (document.body.innerText.includes('No Record Found')),
      //       { timeout: 15000 }
      //     ).catch(() => null);
      //     await page.waitForTimeout(1000);
      //
      //     const globalTotals = await page.evaluate(() => {
      //       const data: any = {
      //         primary_leads: '0',
      //         secondary_leads: '0',
      //         tertiary_leads: '0',
      //         total_instances: '0',
      //         verified_leads: '0',
      //         unverified_leads: '0',
      //         form_initiated: '0',
      //         paid_applications: '0',
      //         submit_applications: '0',
      //         enrolments: '0'
      //       };
      //       const boxes = Array.from(document.querySelectorAll('.info-box, .summary-card, [class*="info-box"]'));
      //       boxes.forEach(box => {
      //         const label = (box.querySelector('.info-box-text, .summary-label, label')?.textContent || '').trim().toLowerCase();
      //         const num = (box.querySelector('.info-box-number, .summary-count, .count')?.textContent || '').trim().replace(/,/g, '') || '0';
      //         if (label.includes('unverified leads')) data.unverified_leads = num;
      //         else if (label.includes('verified leads')) data.verified_leads = num;
      //         else if (label.includes('secondary leads')) data.secondary_leads = num;
      //         else if (label.includes('tertiary leads')) data.tertiary_leads = num;
      //         else if (label.includes('total instances')) data.total_instances = num;
      //         else if (label.includes('primary leads')) data.primary_leads = num;
      //         else if (label.includes('form initiated')) data.form_initiated = num;
      //         else if (label.includes('paid application')) data.paid_applications = num;
      //         else if (label.includes('submitted application')) data.submit_applications = num;
      //         else if (label.includes('enrolment')) data.enrolments = num;
      //       });
      //       return data;
      //     });
      //
      //     this.logger.log(`   📊 Result (${pass.label}): ${JSON.stringify(globalTotals)}`);
      //     const jobData = {
      //       target: 'npf_funnel' as TargetKind,
      //       rows: [{
      //         ...globalTotals,
      //         source: 'GLOBAL',
      //         filter_applied: pass.label,
      //         funnel_source: 'campaign_view',
      //         instance_filter: String(instanceVal),
      //       }],
      //       meta: { client_id: clientWise.client_id, year: clientWise.year, user_id: clientWise.user_id, config_id: clientWise.config_id! },
      //     };
      //
      //     await this.saveScrapedDataDirectly(jobData);
      //   }
      // }
      return { status: 'success', warnings };
    } catch (err) {
      this.npfError(
        'NPF Funnel Scrape Failed',
        clientWise?.client_id ?? dto.client_id,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    } finally {
      page.off('response', apiSummaryListener);
      if (!opts?.page) {
        const closeTask = async () => {
          await browser?.page?.close().catch(() => null);
          await browser?.context?.close().catch(() => null);
          await browser?.browser?.close().catch(() => null);
        };
        await Promise.race([
          closeTask(),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
      }
    }
  }

  private async applyNpfFilter(
    page: Page,
    filterValue: string | null,
    previousFilter: string | null = null,
    clientId?: number,
    getApiSeq?: () => number,
  ): Promise<NpfFilterApplyResult> {
    if (!filterValue) return { applied: true };

    const clickApplyButton = async (
      buttonLocator: import('playwright').Locator,
      contextLabel: string,
    ): Promise<boolean> => {
      // Some NPF layouts render duplicate Apply buttons; first visible one wins.
      for (let i = 0; i < 3; i += 1) {
        const btn = buttonLocator.nth(i);
        const exists = await btn.count().catch(() => 0);
        if (!exists) continue;
        const clicked = await btn
          .click({ force: true })
          .then(() => true)
          .catch(() => false);
        if (clicked) return true;

        const jsClicked = await btn
          .evaluate((el) => {
            const h = el as HTMLElement;
            h.click();
            return true;
          })
          .catch(() => false);
        if (jsClicked) return true;
      }
      this.npfWarn(`Unable to click Apply button (${contextLabel})`, clientId);
      return false;
    };

    this.logger.log(`Starting applyNpfFilter for: ${filterValue}` + (previousFilter ? ` (removing previous: ${previousFilter})` : ''));

    // Dismiss any notification banners
    await page.locator("//button[@aria-label='Close']").first().click({ timeout: 1000 }).catch(() => null);

    // Map filter label → checkbox ID (matches the actual HTML ids in the popup)
    const filterIdMap: Record<string, string> = {
      'Form Initiated': 'u_form_initiated',
      'Paid Applications': 'u_payment_approved',
      'Enrolment Status': 'u_enrollment_status',
    };

    const newCheckboxId = filterIdMap[filterValue];
    if (!newCheckboxId) {
      this.npfError(
        `❌ No checkbox ID mapped for filter: "${filterValue}". Add it to filterIdMap.`,
        clientId,
      );
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `No checkbox ID mapped for filter "${filterValue}"`,
      };
    }

    // STEP 1: If there's a previous filter, open popup → uncheck it → Apply
    if (previousFilter) {
      const prevCheckboxId = filterIdMap[previousFilter];
      if (prevCheckboxId) {
        this.logger.log(`Removing previous filter: "${previousFilter}" (#${prevCheckboxId})`);

        const advBtnPrev = page.locator("//button[contains(., 'Advance Filter')]").first();
        await advBtnPrev.click({ force: true });
        await page.waitForTimeout(800);

        const prevCheckbox = page.locator(`#${prevCheckboxId}`);
        if (await prevCheckbox.isChecked().catch(() => false)) {
          let unchecked = false;
          try {
            await prevCheckbox.uncheck({ force: true });
            unchecked = true;
          } catch {
            // Some NPF variants keep the checkbox input hidden; fallback to JS state update.
            unchecked = await prevCheckbox
              .evaluate((el) => {
                const input = el as HTMLInputElement;
                if (!input) return false;
                input.checked = false;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              })
              .catch(() => false);
          }

          if (!unchecked) {
            this.npfWarn(`Unable to uncheck previous filter #${prevCheckboxId}`, clientId);
            return {
              applied: false,
              reason: 'filter_not_found',
              message: `Previous filter "${previousFilter}" could not be unchecked`,
            };
          }
          this.logger.log(`Unchecked #${prevCheckboxId}`);
        } else {
          this.npfWarn(`#${prevCheckboxId} was already unchecked`, clientId);
        }
        await page.waitForTimeout(300);

        // Click Apply to remove the previous ng-select field from main page
        // Uses rounded-0 to distinguish from other hidden Apply buttons on the page
        const applyBtnPrev = page.locator("//button[contains(@class,'btn-success') and contains(@class,'rounded-0') and normalize-space(.)='Apply']").first();
        const prevApplyClicked = await clickApplyButton(
          page.locator("//button[contains(@class,'btn-success') and contains(@class,'rounded-0') and normalize-space(.)='Apply']"),
          `remove previous filter "${previousFilter}"`,
        );
        if (!prevApplyClicked) {
          return {
            applied: false,
            reason: 'filter_not_found',
            message: `Apply button not clickable while removing previous filter "${previousFilter}"`,
          };
        }
        this.logger.log(`Clicked Apply to remove previous filter`);
        // UI refresh can be delayed/flaky; do a light settle and rely on API refresh after final Search.
        await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 10000 }).catch(() => null);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => null);

        // Strict guard: do not continue to next filter unless previous one is really cleared.
        await advBtnPrev.click({ force: true }).catch(() => null);
        await page.waitForTimeout(400);
        const stillChecked = await page
          .locator(`#${prevCheckboxId}`)
          .isChecked()
          .catch(() => false);
        await page.keyboard.press('Escape').catch(() => null);
        if (stillChecked) {
          return {
            applied: false,
            reason: 'filter_not_found',
            message: `Previous filter "${previousFilter}" is still checked after Apply`,
          };
        }
      }
    }

    // STEP 2: Open Advance Filter popup → check new filter → Apply
    this.logger.log(`Opening Advance Filter to select: "${filterValue}" (#${newCheckboxId})`);
    const advBtn = page.locator("//button[contains(., 'Advance Filter')]").first();
    if (!(await advBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      this.npfWarn(`Advance Filter button not found or not visible.`, clientId);
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `Advance Filter button not found/visible for "${filterValue}"`,
      };
    }

    await advBtn.click({ force: true });
    await page.waitForTimeout(800);

    const newCheckbox = page.locator(`#${newCheckboxId}`);
    if (!(await newCheckbox.isVisible({ timeout: 3000 }).catch(() => false))) {
      this.npfError(`❌ Checkbox #${newCheckboxId} not found in popup`, clientId);
      await page.keyboard.press('Escape');
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `Checkbox #${newCheckboxId} not visible for "${filterValue}"`,
      };
    }

    if (!(await newCheckbox.isChecked())) {
      await newCheckbox.check({ force: true });
      this.logger.log(`Checked #${newCheckboxId}`);
    }
    await page.waitForTimeout(300);

    // Click Apply to add the new ng-select field on the main page
    // Uses rounded-0 to distinguish from other hidden Apply buttons on the page
    const applyBtn = page.locator("//button[contains(@class,'btn-success') and contains(@class,'rounded-0') and normalize-space(.)='Apply']").first();
    const newApplyClicked = await clickApplyButton(
      page.locator("//button[contains(@class,'btn-success') and contains(@class,'rounded-0') and normalize-space(.)='Apply']"),
      `apply new filter "${filterValue}"`,
    );
    if (!newApplyClicked) {
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `Apply button not clickable for filter "${filterValue}"`,
      };
    }
    this.logger.log(`Clicked Apply for new filter`);
    // UI refresh can be delayed/flaky; do a light settle and rely on API refresh after final Search.
    await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 10000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => null);

    // STEP 3: Find the ng-select by its placeholder text and click the .ng-input input
    // IMPORTANT: Must click .ng-input input — clicking the container/placeholder closes the dropdown immediately
    this.logger.log(`Finding ng-select for "${filterValue}" on main page...`);
    const ngSelectInput = page
      .locator(`.ng-select-container:has(.ng-placeholder:text("${filterValue}")) .ng-input input`)
      .first();

    if (!(await ngSelectInput.isVisible({ timeout: 5000 }).catch(() => false))) {
      this.npfError(
        `❌ ng-select input for "${filterValue}" not found on main page after Apply`,
        clientId,
      );
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `ng-select input not found for "${filterValue}" after applying filter`,
      };
    }

    await ngSelectInput.click({ force: true });
    this.logger.log(`Clicked ng-input input, waiting for .ng-dropdown-panel...`);

    // STEP 4: Wait for the floating dropdown panel and select "Yes"
    const dropdownPanel = page.locator('.ng-dropdown-panel');
    await dropdownPanel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
      this.npfWarn(`.ng-dropdown-panel did not appear after clicking input`, clientId);
    });

    const yesOption = dropdownPanel.locator('.ng-option', { hasText: 'Yes' }).first();
    if (!(await yesOption.isVisible({ timeout: 3000 }).catch(() => false))) {
      this.npfError(
        `❌ "Yes" option not found in .ng-dropdown-panel for "${filterValue}"`,
        clientId,
      );
      await page.keyboard.press('Escape');
      return {
        applied: false,
        reason: 'filter_not_found',
        message: `"Yes" option not visible for "${filterValue}" dropdown`,
      };
    }

    await yesOption.click({ force: true });
    this.logger.log(`Selected "Yes" for "${filterValue}"`);
    await page.waitForTimeout(500);

    // STEP 5: Click the global Search button to execute the filtered query
    const searchBtn = page.locator("//button[normalize-space(.)='Search']").first();
    if (await searchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      this.logger.log(`Clicking global Search button...`);
      await searchBtn.click({ force: true });
      // For API-only mode, we don't require UI metric/card refresh here.
      // Per-pass API wait is handled in caller (waitForNpfApiSummaryAdvance).
      await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => null);
    } else {
      this.npfWarn(`Global Search button not found after selecting filter`, clientId);
    }
    return { applied: true };
  }

  private async waitForNpfReload(
    page: Page,
    reason: string,
    clientId?: number,
    getApiSeq?: () => number,
  ): Promise<{ metricChanged: boolean; domChanged: boolean; cardsPresent: boolean; usedDomFallback: boolean }> {
    this.logger.log(`⏳ Waiting for NPF data refresh (${reason})...`);
    const apiSeqBefore = getApiSeq ? getApiSeq() : -1;

    const baseMaxWaitMs = this.getEnvInt('SCRAPER_NPF_REFRESH_MAX_WAIT_MS', 60000);
    const maxWaitMs = this.getAdaptiveNpfWaitMs('refresh', baseMaxWaitMs, clientId);
    const pollMs = this.getEnvInt('SCRAPER_NPF_REFRESH_POLL_MS', 1000);
    const stablePollsNeeded = Math.max(
      2,
      this.getEnvInt('SCRAPER_NPF_REFRESH_STABLE_POLLS', 2),
    );
    this.logger.log(
      `NPF refresh wait window=${maxWaitMs}ms (base=${baseMaxWaitMs}ms, client_id=${clientId ?? 'n/a'})`,
    );

    const baseline = await page
      .evaluate(() => {
        const firstMetric = document.querySelector('.info-box-number')?.textContent?.trim() ?? '';
        const boxes = document.querySelectorAll('.info-box, .summary-card, [class*="info-box"]').length;
        const firstRow = Array.from(document.querySelectorAll('table tbody tr td'))
          .slice(0, 3)
          .map((n) => (n.textContent ?? '').trim())
          .join('|');
        const syncText =
          Array.from(document.querySelectorAll('body *'))
            .map((n) => (n.textContent ?? '').trim())
            .find((t) => t.toLowerCase().includes('last sync')) ?? '';
        const signature = `${firstMetric}::${boxes}::${firstRow}::${syncText}`;
        return { firstMetric, signature };
      })
      .catch(() => ({ firstMetric: '', signature: '' }));

    this.logger.log(`Previous metric value: ${baseline.firstMetric}`);

    const deadline = Date.now() + maxWaitMs;
    let metricChanged = false;
    let domChanged = false;
    let cardsPresent = false;
    let sawLoader = false;
    let stablePolls = 0;

    while (Date.now() < deadline) {
      const state = await page
        .evaluate(() => {
          const firstMetric = document.querySelector('.info-box-number')?.textContent?.trim() ?? '';
          const boxes = document.querySelectorAll('.info-box, .summary-card, [class*="info-box"]').length;
          const firstRow = Array.from(document.querySelectorAll('table tbody tr td'))
            .slice(0, 3)
            .map((n) => (n.textContent ?? '').trim())
            .join('|');
          const syncText =
            Array.from(document.querySelectorAll('body *'))
              .map((n) => (n.textContent ?? '').trim())
              .find((t) => t.toLowerCase().includes('last sync')) ?? '';
          const signature = `${firstMetric}::${boxes}::${firstRow}::${syncText}`;
          const loaderVisible = Array.from(
            document.querySelectorAll('.ng-spinner-loader, .fixed-loader'),
          ).some((n) => {
            const el = n as HTMLElement;
            return !!(el.offsetParent || el.getClientRects().length);
          });
          return { firstMetric, signature, cardsCount: boxes, loaderVisible };
        })
        .catch(() => ({
          firstMetric: '',
          signature: '',
          cardsCount: 0,
          loaderVisible: false,
        }));

      if (state.loaderVisible) {
        sawLoader = true;
        stablePolls = 0;
        await page.waitForTimeout(pollMs);
        continue;
      }

      cardsPresent = state.cardsCount > 0;
      metricChanged = state.firstMetric !== baseline.firstMetric;
      domChanged = state.signature !== baseline.signature;

      const refreshedOrSettled = cardsPresent && (domChanged || metricChanged || sawLoader);
      if (refreshedOrSettled) {
        stablePolls += 1;
        if (stablePolls >= stablePollsNeeded) {
          break;
        }
      } else {
        stablePolls = 0;
      }

      await page.waitForTimeout(pollMs);
    }

    const timedOut = stablePolls < stablePollsNeeded;
    this.updateAdaptiveNpfPenalty('refresh', timedOut, clientId);
    const apiSeqAfter = getApiSeq ? getApiSeq() : -1;
    const apiAdvanced = apiSeqBefore >= 0 && apiSeqAfter > apiSeqBefore;
    if (!metricChanged && !apiAdvanced) {
      this.npfWarn('⚠️ Metric did not change; relying on DOM/settled-state signals.', clientId);
    }
    this.logger.log(`✅ NPF data refresh completed (${reason})`);
    return {
      metricChanged,
      domChanged,
      cardsPresent,
      usedDomFallback: !metricChanged,
    };
  }

  private async waitForNpfMetricsCardsReady(
    page: Page,
    reason: string,
    clientId?: number,
  ): Promise<boolean> {
    const baseMaxWaitMs = this.getEnvInt('SCRAPER_NPF_METRICS_WAIT_MS', 60000);
    const maxWaitMs = this.getAdaptiveNpfWaitMs('metrics', baseMaxWaitMs, clientId);
    const pollMs = this.getEnvInt('SCRAPER_NPF_METRICS_POLL_MS', 1000);
    const deadline = Date.now() + maxWaitMs;
    this.logger.log(
      `NPF metrics wait window=${maxWaitMs}ms (base=${baseMaxWaitMs}ms, client_id=${clientId ?? 'n/a'}, reason=${reason})`,
    );

    while (Date.now() < deadline) {
      const state = await page
        .evaluate(() => {
          const cardsCount = document.querySelectorAll(
            '.info-box, .summary-card, [class*="info-box"]',
          ).length;
          const noData = document.body.innerText.includes('No Record Found');
          const loaderVisible = Array.from(
            document.querySelectorAll('.ng-spinner-loader, .fixed-loader'),
          ).some((n) => {
            const el = n as HTMLElement;
            return !!(el.offsetParent || el.getClientRects().length);
          });
          return { cardsCount, noData, loaderVisible };
        })
        .catch(() => ({ cardsCount: 0, noData: false, loaderVisible: false }));

      if (!state.loaderVisible && state.cardsCount > 0) {
        this.updateAdaptiveNpfPenalty('metrics', false, clientId);
        return true;
      }
      if (!state.loaderVisible && state.noData) {
        this.npfWarn(
          `NPF metrics cards not shown (${reason}): page shows "No Record Found"`,
          clientId,
        );
        this.updateAdaptiveNpfPenalty('metrics', true, clientId);
        return false;
      }
      await page.waitForTimeout(pollMs);
    }

    this.npfWarn(
      `NPF metrics wait timeout (${reason}) after ${maxWaitMs}ms; cards did not appear.`,
      clientId,
    );
    this.updateAdaptiveNpfPenalty('metrics', true, clientId);
    return false;
  }

  async scrapeLeads(dto: ScrapeTargetDto) {
    const res = await this.scrapeTarget(dto, 'leads');
    // Auto-trigger funnel scrape after leads if applicable
    if (this.isNpfClient(dto)) {
      this.scrapeNpfFunnelData(dto).catch((e) =>
        this.npfError('Auto funnel scrape failed', dto.client_id, e?.stack),
      );
    }
    return res;
  }

  private isNpfClient(dto: any): boolean {
    return true; // Simple heuristic: run for all for now or check URL in config
  }

  async scrapeSummary(dto: ScrapeTargetDto) {
    return this.scrapeTarget(dto, 'summary');
  }

  async scrapeSummaryInSession(dto: ScrapeTargetDto, opts: ScrapeTargetRunOptions) {
    return this.scrapeTarget(dto, 'summary', opts);
  }

  async scrapeNpfCampaignDetailsViaApi(
    dto: ScrapeTargetDto,
    opts?: { page?: import('playwright').Page; skipLogin?: boolean },
  ) {
    this.logger.log(`Starting NPF campaign details API scrape for client_id=${dto.client_id ?? 'n/a'}`);

    let clientWise: ClientWiseEntity | null = null;
    if (dto.client_wise_id) {
      clientWise = await this.clientWiseRepository.findOne({ where: { id: dto.client_wise_id } });
    } else if (dto.client_id && dto.year) {
      clientWise = await this.clientWiseRepository.findOne({
        where: { client_id: dto.client_id, year: dto.year },
        order: { id: 'DESC' },
      });
    }
    if (!clientWise) throw new NotFoundException('Client config not found');

    const summaryConfig = await this.summaryConfigRepository.findOne({
      where: { client_wise_id: clientWise.id, is_active: true },
    });
    if (!summaryConfig) throw new NotFoundException('No active NPF summary config found');

    const browser = opts?.page
      ? null
      : await this.playwrightService.createBrowser({ useProxy: dto.use_proxy ?? false });
    const page = opts?.page ?? browser!.page;
    const apiPageLimit = this.getEnvInt('SCRAPER_NPF_CAMPAIGN_API_LIMIT', 3000);

    const apiRows: Record<string, unknown>[] = [];
    const seenCampaigns = new Set<string>();
    let apiSeq = 0;
    let apiTotal = 0;
    let firstApiPage = 0;
    let sawNonJsonCampaignPayload = false;
    let rewroteCampaignPayload = false;
    const campaignApiState: {
      requestTemplate: {
        url: string;
        headers: Record<string, string>;
        payload: Record<string, unknown>;
      } | null;
    } = { requestTemplate: null };
    let activeCampaignFilter = 'None';
    const appendCampaignRows = (
      list: Array<Record<string, unknown>>,
      pageNo: number,
      filterApplied: string,
    ) => {
      for (const item of list) {
        const source = String(item.source ?? '').trim();
        const medium = String(item.medium ?? '').trim();
        const campaignName = String(item.name ?? '').trim();
        const rowKey = `${filterApplied}|${pageNo}|${source}|${medium}|${campaignName}`;
        if (seenCampaigns.has(rowKey)) continue;
        seenCampaigns.add(rowKey);
        apiRows.push({
          source: source || null,
          medium: medium || null,
          campaign_name: campaignName || null,
          primary_leads: this.normalizeNpfMetricValue(item.primary),
          secondary_leads: this.normalizeNpfMetricValue(item.secondary),
          tertiary_leads: this.normalizeNpfMetricValue(item.tertiary),
          total_instances: this.normalizeNpfMetricValue(item.total),
          verified_leads: this.normalizeNpfMetricValue(item.verified),
          unverified_leads: this.normalizeNpfMetricValue(item.unverified),
          form_initiated: this.normalizeNpfMetricValue(item.form_initiated),
          payment_approved: this.normalizeNpfMetricValue(item.payment_approved),
          enrolments: this.normalizeNpfMetricValue(item.enrolment_count),
          data_source: 'npf_campaign_api',
          filter_applied: filterApplied,
        });
      }
    };
    const rewriteCampaignPayloadLimit = (raw: string): string | null => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const keys = [
          'limit',
          'pageSize',
          'page_size',
          'per_page',
          'perPage',
          'size',
          'rows',
        ];
        let touched = false;
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            parsed[key] = apiPageLimit;
            touched = true;
          }
        }
        if (!touched) {
          parsed.limit = apiPageLimit;
        }
        return JSON.stringify(parsed);
      } catch {
        return null;
      }
    };
    const campaignRouteHandler = async (route: import('playwright').Route) => {
      const req = route.request();
      const postData = req.postData() ?? '';
      if (!postData) {
        await route.continue();
        return;
      }
      const rewrittenPostData = rewriteCampaignPayloadLimit(postData);
      if (!rewrittenPostData) {
        sawNonJsonCampaignPayload = true;
        await route.continue();
        return;
      }

      const headers = { ...req.headers() } as Record<string, string>;
      delete headers['content-length'];
      delete headers['Content-Length'];
      rewroteCampaignPayload = true;
      await route.continue({ headers, postData: rewrittenPostData });
    };
    const campaignApiListener = async (response: any) => {
      try {
        const req = response.request?.();
        const method = req?.method?.();
        const url = response.url?.() ?? '';
        if (
          method === 'POST' &&
          url.includes('/publishers/v1/getCampaignDetailsViewList') &&
          response.status?.() === 200
        ) {
          const payloadRaw = req?.postData?.() ?? '';
          if (!campaignApiState.requestTemplate && payloadRaw) {
            try {
              const payloadObj = JSON.parse(payloadRaw) as Record<string, unknown>;
              campaignApiState.requestTemplate = {
                url,
                headers: { ...(req?.headers?.() ?? {}) } as Record<string, string>,
                payload: payloadObj,
              };
            } catch {
              // ignore: encrypted/non-json payload
            }
          }
          const body = (await response.json().catch(() => null)) as
            | Record<string, unknown>
            | null;
          const data = (body?.data as Record<string, unknown> | undefined) ?? {};
          const list = Array.isArray(data.list)
            ? (data.list as Array<Record<string, unknown>>)
            : [];
          const total = Number(data.total ?? 0);
          if (Number.isFinite(total) && total > 0) {
            apiTotal = total;
          }
          const pageNo = Number(data.page ?? 0);
          firstApiPage = pageNo;
          appendCampaignRows(list, pageNo, activeCampaignFilter);
          apiSeq += 1;
          this.logger.log(
            `Captured campaign API response (seq=${apiSeq}, page=${pageNo}, rows=${list.length}, unique_total=${apiRows.length})`,
          );
        }
      } catch {
        // best effort only
      }
    };

    page.on('response', campaignApiListener);
    try {
      await page.route('**/publishers/v1/getCampaignDetailsViewList', campaignRouteHandler);
      if (!opts?.skipLogin) {
        await this.login(page, dto, clientWise);
      } else {
        this.logger.log(`Skipping login, reusing existing session for ${clientWise.client_id}`);
      }

      await this.ensureNpfCampaignSummaryPageReady(page, summaryConfig.url);

      // Apply summary config steps (institute/source/etc.) before Search.
      const summaryFilters = [...(summaryConfig.filters ?? [])];
      const instanceFilterValue =
        summaryFilters.find((f) => String(f?.name ?? '').trim().toLowerCase() === 'instance')
          ?.value_to_apply || 'Instance';
      if (summaryFilters.length > 0) {
        this.logger.log(
          `Applying summary config filters before campaign API fetch: count=${summaryFilters.length}`,
        );
        await this.applyNpfCampaignBaseFiltersWithRecovery(
          page,
          summaryFilters,
          clientWise.client_id,
          summaryConfig.url,
        );
        await this.waitBetweenStepPhases(page, 'after npf campaign base filters');
      } else {
        this.logger.warn(
          `No filters found in client_wise_summary_config for client_wise_id=${clientWise.id}; proceeding without filter apply.`,
        );
      }

      const filterPasses = [
        { label: 'None', filterValue: null },
        { label: 'Form Initiated', filterValue: 'Form Initiated' },
        { label: 'Paid Applications', filterValue: 'Paid Applications' },
        { label: 'Enrolment Status', filterValue: 'Enrolment Status' },
      ] as const;
      let previousFilter: string | null = null;
      for (const pass of filterPasses) {
        activeCampaignFilter = pass.label;
        if (pass.filterValue) {
          const filterResult = await this.applyNpfFilter(
            page,
            pass.filterValue,
            previousFilter,
            clientWise.client_id,
          );
          if (!filterResult.applied) {
            this.logger.warn(
              `[CAMPAIGN API] Skipping "${pass.label}" because filter could not be applied: ${filterResult.message}`,
            );
            continue;
          }
          previousFilter = pass.filterValue;
        }

        const rowsBeforePass = apiRows.length;
        const seqBeforePass = apiSeq;

        // Trigger Search, then collect paginated API calls for current filter pass.
        const searchBtn = page
          .locator("//button[contains(., 'Search')] | //a[contains(., 'Search')]")
          .first();
        if (await searchBtn.isVisible().catch(() => false)) {
          await searchBtn.click({ force: true }).catch(() => null);
        }

        // Wait for first API response.
        const firstSeq = apiSeq;
        const waitStart = Date.now();
        while (Date.now() - waitStart < 12000 && apiSeq <= firstSeq) {
          await page.waitForTimeout(400);
        }

        // After first Search response, force rows-per-page as high as possible.
        const beforeRppSeq = apiSeq;
        const rppResult = await this.setNpfCampaignRowsPerPage(page, apiPageLimit);
        if (rppResult.applied) {
          await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => null);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
          const started = Date.now();
          while (Date.now() - started < 8000 && apiSeq <= beforeRppSeq) {
            await page.waitForTimeout(300);
          }
        }

        // API-first pagination with direct authenticated requests.
        if (
          campaignApiState.requestTemplate &&
          apiTotal > 0 &&
          apiRows.length - rowsBeforePass < apiTotal
        ) {
          const template = campaignApiState.requestTemplate;
          const expectedPages = Math.max(1, Math.ceil(apiTotal / apiPageLimit));
          const pageKey =
            ['page', 'pageNo', 'page_no', 'page_number'].find((k) =>
              Object.prototype.hasOwnProperty.call(template.payload, k),
            ) ?? 'page';
          const limitKey =
            ['limit', 'pageSize', 'page_size', 'per_page', 'perPage', 'size', 'rows'].find((k) =>
              Object.prototype.hasOwnProperty.call(template.payload, k),
            ) ?? 'limit';
          const requestHeaders = Object.entries(template.headers).reduce(
            (acc, [k, v]) => {
              const key = String(k).toLowerCase();
              if (
                key === 'content-type' ||
                key === 'authorization' ||
                key.startsWith('x-') ||
                key === 'accept' ||
                key === 'origin' ||
                key === 'referer'
              ) {
                acc[k] = String(v);
              }
              return acc;
            },
            {} as Record<string, string>,
          );
          if (!requestHeaders['content-type']) {
            requestHeaders['content-type'] = 'application/json;charset=UTF-8';
          }

          const pagesToFetch = Array.from({ length: expectedPages }, (_, idx) => idx).filter(
            (p) => p !== firstApiPage,
          );
          for (const p of pagesToFetch) {
            if (apiRows.length - rowsBeforePass >= apiTotal) break;
            const payload = { ...template.payload };
            payload[limitKey] = apiPageLimit;
            payload[pageKey] = p;
            const apiResponse = await page.context().request
              .post(template.url, {
                headers: requestHeaders,
                data: payload,
              })
              .catch(() => null);
            if (!apiResponse || !apiResponse.ok()) {
              this.logger.warn(`Direct API page fetch failed for page=${p} (${pass.label})`);
              continue;
            }
            const body = (await apiResponse.json().catch(() => null)) as Record<string, unknown> | null;
            const data = (body?.data as Record<string, unknown> | undefined) ?? {};
            const list = Array.isArray(data.list) ? (data.list as Array<Record<string, unknown>>) : [];
            appendCampaignRows(list, p, activeCampaignFilter);
          }
        }

        const nextButtonXpath = this.computeNextButtonXpath(dto);
        const maxPages = this.getEnvInt('SCRAPER_NPF_CAMPAIGN_MAX_PAGES', 40);
        for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
          if (apiTotal > 0) {
            const expectedPages = Math.max(1, Math.ceil(apiTotal / apiPageLimit));
            if (apiSeq - seqBeforePass >= expectedPages) {
              break;
            }
          }

          const pagerStatus = await page
            .locator('ul.pagination li.pt-1')
            .first()
            .textContent()
            .catch(() => null);
          if (pagerStatus) {
            const m = pagerStatus.replace(/\s+/g, ' ').match(/(\d+)\s*-\s*(\d+)\s*of\s*(\d+)/i);
            if (m) {
              const end = Number(m[2]);
              const total = Number(m[3]);
              if (Number.isFinite(end) && Number.isFinite(total) && end >= total) {
                break;
              }
            }
          }

          const nextBtn = page
            .locator("ul.pagination li.page-item:not(.disabled) a.page-link:has(i.fa-angle-right)")
            .first();
          const nextBtnFallback = page.locator(`xpath=${nextButtonXpath}`).first();
          const isVisible = await nextBtn.isVisible().catch(() => false);
          const targetNextBtn = isVisible ? nextBtn : nextBtnFallback;
          const targetVisible = isVisible || (await nextBtnFallback.isVisible().catch(() => false));
          if (!targetVisible) break;
          const isDisabled = await targetNextBtn
            .evaluate((el) => {
              const h = el as HTMLElement;
              const ariaDisabled = h.getAttribute('aria-disabled');
              const cls = h.className || '';
              return (
                (h as HTMLButtonElement).disabled === true ||
                ariaDisabled === 'true' ||
                /\bdisabled\b/i.test(cls)
              );
            })
            .catch(() => false);
          if (isDisabled) break;

          const beforeSeq = apiSeq;
          const clicked = await targetNextBtn.click({ force: true }).then(() => true).catch(() => false);
          if (!clicked) break;
          await page.waitForSelector('.ng-spinner-loader', { state: 'hidden', timeout: 15000 }).catch(() => null);
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);

          const started = Date.now();
          while (Date.now() - started < 8000 && apiSeq <= beforeSeq) {
            await page.waitForTimeout(350);
          }
          if (apiSeq <= beforeSeq) {
            break;
          }
        }

        this.logger.log(
          `[CAMPAIGN API] Pass "${pass.label}" captured ${apiRows.length - rowsBeforePass} row(s).`,
        );
      }

      if (!apiRows.length) {
        this.logger.warn(`No campaign rows captured from API for client_id=${clientWise.client_id}`);
        return { saved: 0, captured: 0 };
      }

      const saveResult = await this.saveScrapedDataDirectly({
        target: 'summary',
        rows: apiRows,
        meta: {
          client_id: clientWise.client_id,
          year: clientWise.year,
          user_id: clientWise.user_id,
          config_id: clientWise.config_id!,
        },
      });

      this.logger.log(
        `Campaign API scrape completed for client_id=${clientWise.client_id}: captured=${apiRows.length}, saved=${saveResult?.saved ?? 0}`,
      );
      return { saved: saveResult?.saved ?? 0, captured: apiRows.length, api_calls: apiSeq };
    } catch (err) {
      this.npfError(
        'NPF Campaign API scrape failed',
        clientWise.client_id,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    } finally {
      page.off('response', campaignApiListener);
      await page.unroute('**/publishers/v1/getCampaignDetailsViewList', campaignRouteHandler).catch(() => null);
      if (!opts?.page) {
        const closeTask = async () => {
          await browser?.page?.close().catch(() => null);
          await browser?.context?.close().catch(() => null);
          await browser?.browser?.close().catch(() => null);
        };
        await Promise.race([closeTask(), new Promise((resolve) => setTimeout(resolve, 5000))]);
      }
    }
  }

  private async setNpfCampaignRowsPerPage(
    page: Page,
    desiredLimit: number,
  ): Promise<{ applied: boolean; selected: number | null; injected: boolean }> {
    const result = await page
      .evaluate((desired) => {
        const select = document.querySelector(
          'select.custom-select.custom-select-sm.rounded-0.rpp',
        ) as HTMLSelectElement | null;
        if (!select) return { applied: false, selected: null, injected: false };

        const options = Array.from(select.options).map((opt) => ({
          value: String(opt.value ?? '').trim(),
          num: Number(String(opt.value ?? '').trim()),
        }));
        const validNumbers = options
          .map((o) => o.num)
          .filter((n) => Number.isFinite(n) && n > 0);
        const hasDesired = validNumbers.includes(desired);
        let selected = hasDesired
          ? desired
          : validNumbers.length
            ? Math.max(...validNumbers)
            : null;
        let injected = false;

        if (!hasDesired && desired > 0) {
          // Some pages only render 10/20/50/100; inject desired option and select it.
          const opt = document.createElement('option');
          opt.value = String(desired);
          opt.textContent = ` ${desired} `;
          select.appendChild(opt);
          selected = desired;
          injected = true;
        }

        if (!selected) return { applied: false, selected: null, injected };
        select.value = String(selected);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { applied: true, selected, injected };
      }, desiredLimit)
      .catch(() => ({ applied: false, selected: null, injected: false }));
    return result;
  }

  private normalizeKey(key: string): string {
    return key
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  private mapSelectorTypeToFormFieldType(selectorType: string | undefined): FormFieldType {
    switch ((selectorType ?? '').toLowerCase()) {
      case 'text':
        return 'text';
      case 'select':
        return 'select';
      case 'searchable_dropdown':
        return 'select';
      case 'button':
        return 'click';
      case 'search':
        // Treat "search" as a text input (user provides value_to_apply),
        // and use a separate "button"/"click" filter item to submit the search.
        return 'text';
      case 'fill_text':
        return 'text';
      case 'checkbox':
        return 'checkbox';
      case 'click':
        return 'click';
      case 'radio':
        return 'radio';
      case 'file':
        return 'file';
      case 'date':
      case 'datetime-local':
      case 'datetime':
        return 'date';
      case 'date_range':
        return 'date_range';
      default:
        return 'text';
    }
  }

  private parseItemDateStrategy(item: { date_strategy?: string } | undefined): DateFillStrategy | undefined {
    const raw = typeof item?.date_strategy === 'string' ? item.date_strategy.trim().toLowerCase() : '';
    if (raw === 'auto' || raw === 'fill' || raw === 'js') return raw;
    return undefined;
  }

  private mapSelectorTypeToScrapeSource(selectorType: string | undefined): 'text' | 'html' | 'value' | 'attr' {
    const t = (selectorType ?? '').toLowerCase();
    if (t === 'select' || t === 'searchable_dropdown') return 'value';
    return 'text';
  }

  private buildPaginationOptions(dto: ScrapeTargetDto): PaginationOptions {
    throw new Error('buildPaginationOptions(dto) is no longer used');
  }

  private buildSchemaFromConfig(items: Array<{ name?: string; xpath?: string; selector_type?: string }>): ScrapeSchema {
    const schema: ScrapeSchema = {};
    for (const item of items) {
      const key = item.name?.trim();
      const xpath = item.xpath?.trim();
      if (!key || !xpath) continue;
      schema[key] = {
        xpath,
        source: this.mapSelectorTypeToScrapeSource(item.selector_type),
        trim: true,
        required: false,
      };
    }
    return schema;
  }

  private async navigateWithRetry(
    page: Page,
    url: string,
    maxRetries: number,
    waitForXPaths: string[],
    opts?: {
      gotoTimeoutMs?: number;
      locatorTimeoutMs?: number;
      /** After commit, wait for domcontentloaded (helps slow proxy + Angular bootstrap). */
      waitDomContentLoaded?: boolean;
    },
  ) {
    const gotoTimeoutMs = opts?.gotoTimeoutMs ?? this.getEnvInt('SCRAPER_NAV_GOTO_TIMEOUT_MS', 45000);
    const locatorTimeoutMs = opts?.locatorTimeoutMs ?? this.getEnvInt('SCRAPER_POST_GOTO_LOCATOR_TIMEOUT_MS', 15000);
    const waitDom =
      opts?.waitDomContentLoaded ??
      this.getEnvBool('SCRAPER_NAV_WAIT_DOMCONTENTLOADED', false);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        this.logger.log(
          `Navigation attempt ${attempt}/${maxRetries} => ${url} (goto_timeout_ms=${gotoTimeoutMs} locator_timeout_ms=${locatorTimeoutMs} domcontentloaded=${waitDom})`,
        );
        // Use "commit" like PunchService: more reliable when DOM/load events are flaky via proxy.
        await page.goto(url, { waitUntil: 'commit', timeout: gotoTimeoutMs });

        if (waitDom) {
          await page.waitForLoadState('domcontentloaded', { timeout: gotoTimeoutMs }).catch(() => null);
        }

        for (const xpath of waitForXPaths) {
          if (!xpath) continue;
          await this.waitForLoginOrNavLocator(page, xpath, locatorTimeoutMs);
        }

        return;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`Navigation failed (attempt ${attempt})`, err instanceof Error ? err.stack : undefined);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Navigation failed');
  }

  /**
   * Wait for xpath to become visible; on slow proxy / SPA paint, retry after a short pause if attached only.
   */
  private async waitForLoginOrNavLocator(page: Page, xpath: string, locatorTimeoutMs: number): Promise<void> {
    const loc = page.locator(`xpath=${xpath}`).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: locatorTimeoutMs });
      return;
    } catch (firstErr) {
      const attached = await loc.count().catch(() => 0);
      if (attached > 0) {
        this.logger.warn(
          `Locator visible timeout (${locatorTimeoutMs}ms) but element exists; waiting for paint xpath=${xpath.slice(0, 120)}`,
        );
        await page.waitForTimeout(2000);
        await loc.scrollIntoViewIfNeeded().catch(() => null);
        await loc.waitFor({ state: 'visible', timeout: locatorTimeoutMs });
        return;
      }
      throw firstErr;
    }
  }

  private buildPaginationOptionsFromComputed(dto: ScrapeTargetDto, nextButtonXpath: string): PaginationOptions {
    return {
      nextButtonXpath,
      disabledAttribute: dto.disabled_attribute ?? 'disabled',
      // "Full pagination" behavior by default:
      // - stop when Next is disabled/not found (HandlePaginationService)
      // - very high safety cap to prevent infinite loops on buggy UIs
      maxPages: dto.max_pages ?? this.getEnvInt('SCRAPER_MAX_PAGES', 10000),
      delayMsBetweenPages: dto.delay_ms_between_pages ?? this.getEnvInt('SCRAPER_DELAY_MS_BETWEEN_PAGES', 0),
      minWaitAfterNextClickMs: this.getEnvInt('SCRAPER_MIN_WAIT_AFTER_NEXT_CLICK_MS', 5000),
      paginationChangeTimeoutMs: this.getEnvInt('SCRAPER_PAGINATION_CHANGE_TIMEOUT_MS', 12000),
      stopWhenNextDisabled: dto.stop_when_next_disabled ?? this.getEnvBool('SCRAPER_STOP_WHEN_NEXT_DISABLED', true),
    };
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

  /**
   * Wait until row locator count is stable (and optionally >= expected_rows_per_page)
   * so large page sizes (e.g. 1000) finish rendering before extract / next pagination click.
   */
  private async waitForTableRowsReady(page: Page, rowXpath: string, dto: ScrapeTargetDto): Promise<void> {
    const trimmed = (rowXpath ?? '').trim();
    if (!trimmed) return;

    const envMin = this.getEnvInt('SCRAPER_EXPECTED_ROWS_PER_PAGE', 0);
    const minCount =
      dto.expected_rows_per_page ?? (envMin > 0 ? envMin : undefined);
    const timeoutMs = this.getEnvInt('SCRAPER_ROW_COUNT_SETTLE_TIMEOUT_MS', 60000);
    const stableRounds = Math.max(2, this.getEnvInt('SCRAPER_ROW_COUNT_STABLE_POLLS', 3));
    const pollMs = this.getEnvInt('SCRAPER_ROW_COUNT_POLL_MS', 500);

    const locator = page.locator(`xpath=${trimmed}`);
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    let stable = 0;

    while (Date.now() < deadline) {
      const n = await locator.count().catch(() => 0);
      const meetsMin = minCount == null || n >= minCount;
      if (n > 0 && n === last) {
        stable += 1;
        if (stable >= stableRounds && meetsMin) {
          this.logger.log(
            `Table rows ready: count=${n} stable_polls=${stableRounds} min_expected=${minCount ?? 'off'}`,
          );
          return;
        }
      } else {
        stable = 0;
      }
      last = n;
      await page.waitForTimeout(pollMs);
    }

    this.logger.warn(
      `Row count settle timeout (${timeoutMs}ms): last_count=${last} min_expected=${minCount ?? 'off'} — continuing`,
    );
  }

  /** Stable JSON for comparing “first row” across pagination pages. */
  private fingerprintFirstRowForPagination(row: Record<string, unknown>): string {
    const keys = Object.keys(row).sort();
    const sorted: Record<string, unknown> = {};
    for (const k of keys) {
      sorted[k] = row[k];
    }
    return JSON.stringify(sorted);
  }

  private computeNextButtonXpath(dto: ScrapeTargetDto): string {
    if (dto.next_button_xpath && dto.next_button_xpath.trim().length > 0) {
      return dto.next_button_xpath.trim();
    }

    // Default heuristic: common "Next" anchors/buttons + typical next CSS class.
    // Note: This is an XPath union, so it must evaluate to a node-set.
    return `
      //a[normalize-space(.)='Next' or @aria-label='Next' or @rel='next']
      | //button[normalize-space(.)='Next' or @aria-label='Next']
      | //*[contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'next')
           and not(contains(translate(@class,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'disabled'))
        ]
    `.trim().replace(/\s+/g, ' ');
  }

  private deriveRootXpathFromFieldXpath(fieldXpath: string): string | undefined {
    const s = (fieldXpath ?? '').trim();
    if (!s) return undefined;

    // Try to derive a "row root" xpath by cutting to the last "/" outside of any predicates.
    let bracketDepth = 0;
    for (let i = s.length - 1; i >= 0; i -= 1) {
      const ch = s[i];
      if (ch === ']') bracketDepth += 1;
      if (ch === '[') bracketDepth = Math.max(0, bracketDepth - 1);

      if (bracketDepth === 0 && ch === '/') {
        const root = s.substring(0, i).replace(/\/+$/g, '').trim();
        if (root.length > 0) return root;
      }
    }

    // Fallback: if we can't cut, just use the original field xpath.
    return s;
  }

  private computeItemXpath(dto: ScrapeTargetDto, targetConfig: LeadsCfg | SummaryCfg): string {
    if (dto.item_xpath && dto.item_xpath.trim().length > 0) return dto.item_xpath.trim();

    // Heuristic: derive item/root xpath from the first field xpath.
    const preferred = (targetConfig.filters ?? [])?.find((x) => x?.xpath?.trim?.());

    const firstXpath = preferred?.xpath?.trim?.();
    if (!firstXpath) {
      throw new BadRequestException(
        `Cannot derive item_xpath: target config has no filter/advance_filter xpaths`,
      );
    }

    const derived = this.deriveRootXpathFromFieldXpath(firstXpath);
    if (!derived) {
      throw new BadRequestException(`Cannot derive item_xpath from xpath: ${firstXpath}`);
    }

    return derived;
  }

  private async openAdvancedFiltersIfNeeded(page: Page, dto: ScrapeTargetDto, targetConfig: LeadsCfg | SummaryCfg) {
    if (!targetConfig.is_advance_filters) return;

    this.logger.log('Advanced filters enabled; attempting to open advanced filter UI...');

    // Prefer stable structure-based locators first. Keep XPath heuristic as fallback.
    const explicitToggleXpath =
      dto.advanced_filters_toggle_xpath && dto.advanced_filters_toggle_xpath.trim().length > 0
        ? dto.advanced_filters_toggle_xpath.trim()
        : null;
    const fallbackHeuristicXpath = `
      //app-advancefilter//button[contains(normalize-space(.), 'Advance Filter')]
      | //button[contains(normalize-space(.), 'Advance Filter')]
      | //button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced filter')]
      | //a[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced filter')]
      | //*[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced filters')]
    `.trim().replace(/\s+/g, ' ');

    const candidates: Array<{ label: string; locator: ReturnType<Page['locator']> }> = [];
    if (explicitToggleXpath) {
      candidates.push({
        label: 'dto.advanced_filters_toggle_xpath',
        locator: page.locator(`xpath=${explicitToggleXpath}`).first(),
      });
    }
    candidates.push(
      {
        label: 'app-advancefilter button',
        locator: page.locator('app-advancefilter button').first(),
      },
      {
        label: 'button text "Advance Filter"',
        locator: page.getByRole('button', { name: /advance filter/i }).first(),
      },
      {
        label: 'heuristic xpath fallback',
        locator: page.locator(`xpath=${fallbackHeuristicXpath}`).first(),
      },
    );

    let clicked = false;
    for (const candidate of candidates) {
      try {
        await candidate.locator.waitFor({ state: 'visible', timeout: 2500 });
        await candidate.locator.click({ timeout: 5000 });
        this.logger.log(`Advanced filter toggle clicked via ${candidate.label}.`);
        clicked = true;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!clicked) {
      this.logger.warn(
        'Could not click advanced filter toggle using known locators; continuing to attempt to fill advanced filters.',
      );
    }

    // We don't have advance_filters array anymore; advanced actions live in steps.
  }

  private async login(page: Page, dto: ScrapeTargetDto, clientWise: ClientWiseEntity) {
    const creds = clientWise.credentials;
    if (!creds) throw new BadRequestException('Client wise credentials are missing');
    if (!creds.login_url) throw new BadRequestException('login_url is required in client wise credentials');
    if (!creds.login_xpath || !creds.password_xpath) {
      throw new BadRequestException('login_xpath and password_xpath are required in client wise credentials');
    }
    const maxRetries = dto.max_retries ?? 3;
    const loginGotoMs = this.getEnvInt('SCRAPER_LOGIN_GOTO_TIMEOUT_MS', 90000);
    const loginLocatorMs = this.getEnvInt('SCRAPER_LOGIN_FORM_LOCATOR_TIMEOUT_MS', 120000);
    const loginFillMs = this.getEnvInt('SCRAPER_LOGIN_FIELD_FILL_TIMEOUT_MS', 120000);
    const loginWaitDom = this.getEnvBool('SCRAPER_LOGIN_WAIT_DOMCONTENTLOADED', true);

    await this.navigateWithRetry(page, creds.login_url, maxRetries, [creds.login_xpath, creds.password_xpath], {
      gotoTimeoutMs: loginGotoMs,
      locatorTimeoutMs: loginLocatorMs,
      waitDomContentLoaded: loginWaitDom,
    });
    this.logger.log(`After login page navigation: url=${page.url()}`);

    // Fill login + password.
    const loginField: FormFieldConfig = {
      xpath: creds.login_xpath,
      type: this.mapSelectorTypeToFormFieldType(creds.login_selector_type),
      value: creds.login,
      timeoutMs: loginFillMs,
    };
    const passwordField: FormFieldConfig = {
      xpath: creds.password_xpath,
      type: this.mapSelectorTypeToFormFieldType(creds.password_selector_type),
      value: creds.password,
      timeoutMs: loginFillMs,
    };

    await this.formFillerService.fillForm(page, [loginField], { stopOnError: true });
    if (typeof creds.delay === 'number' && creds.delay > 0) {
      await page.waitForTimeout(creds.delay);
    }
    await this.formFillerService.fillForm(page, [passwordField], { stopOnError: true });
    // Some NPF login forms only enable/handle submit after true input+blur/change.
    try {
      const pwdLoc = page.locator(`xpath=${creds.password_xpath}`).first();
      await pwdLoc.focus({ timeout: 3000 }).catch(() => null);
      await pwdLoc.dispatchEvent('input').catch(() => null);
      await pwdLoc.dispatchEvent('change').catch(() => null);
      await pwdLoc.dispatchEvent('blur').catch(() => null);
      await page.waitForTimeout(250);
    } catch {
      // best-effort only
    }

    // Submit login: try configured xpath, then common button patterns, then Enter on password field.
    this.logger.log('Submitting login...');
    try {
      let submitClicked = false;
      // 1) Preferred: click configured submit xpath.
      const submitXpath = (creds as any)?.login_submit_xpath?.trim?.();
      const submitClickMs = this.getEnvInt('SCRAPER_LOGIN_SUBMIT_CLICK_TIMEOUT_MS', 30000);
      if (submitXpath) {
        await page.locator(`xpath=${submitXpath}`).first().click({ timeout: submitClickMs });
        submitClicked = true;
      } else {
        // 2) Heuristic: common submit/login buttons seen across NPF variants.
        const submitCandidates = [
          `xpath=//button[@type="submit"]`,
          `xpath=//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'login')]`,
          `xpath=//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'log in')]`,
          `xpath=//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'sign in')]`,
          `xpath=//input[@type='submit']`,
        ];
        for (const candidate of submitCandidates) {
          const loc = page.locator(candidate).first();
          const count = await loc.count().catch(() => 0);
          if (!count) continue;

          // Prefer a real mouse click first (closer to manual interaction).
          let clicked = false;
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            await page.mouse
              .click(box.x + box.width / 2, box.y + box.height / 2)
              .then(() => {
                clicked = true;
              })
              .catch(() => null);
          }
          if (!clicked) {
            await loc.click({ timeout: submitClickMs, force: true }).catch(() => null);
          }
          if (!clicked) {
            await loc.evaluate((el: Element) => (el as HTMLElement).click()).catch(() => null);
          }
          submitClicked = true;
          this.logger.log(`Login submit clicked using candidate: ${candidate}`);
          break;
        }
      }

      // 3) Some login forms bind Enter on password field only.
      if (!submitClicked) {
        const passwordLoc = page.locator(`xpath=${creds.password_xpath}`).first();
        await passwordLoc.press('Enter', { timeout: submitClickMs }).catch(() => null);
      }
    } catch {
      try {
        await page.keyboard.press('Enter');
      } catch (err) {
        // ignore
        this.logger.warn('Unable to press Enter after login fill');
      }
    }

    // Wait for login to actually establish session/redirect.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null),
      page.waitForLoadState('domcontentloaded', { timeout: 45000 }).catch(() => null),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    // Some portals set auth/session tokens asynchronously after redirect.
    // Keep a hard buffer so next navigation can reuse the established session.
    await page.waitForTimeout(10000);
    this.logger.log(`After login submit: url=${page.url()}`);

    // Log quick session signals to help debug sites that require session carry-over.
    const [cookies, storageSignals] = await Promise.all([
      page.context().cookies().catch(() => []),
      page
        .evaluate(() => ({
          localStorageKeys: window.localStorage?.length ?? 0,
          sessionStorageKeys: window.sessionStorage?.length ?? 0,
        }))
        .catch(() => ({ localStorageKeys: 0, sessionStorageKeys: 0 })),
    ]);
    this.logger.log(
      `Post-login session check: cookies=${cookies.length}, localStorageKeys=${storageSignals.localStorageKeys}, ` +
      `sessionStorageKeys=${storageSignals.sessionStorageKeys}`,
    );

    // If we're still on a login-like page, log a warning (often means submit xpath wrong or login failed).
    const u = (page.url() || '').toLowerCase();
    if (u.includes('login') || u.includes('signin') || u.includes('sign-in')) {
      this.logger.warn(`Login may not have completed (still on url=${page.url()}).`);
    }
  }

  private async applyFilters(
    page: Page,
    items: Array<any>,
    options: ApplyFiltersOptions = {},
  ): Promise<ApplyFiltersResult> {
    this.logger.log(
      `Applying filters: total_items=${items.length}` +
        (options.contextLabel ? ` context=${options.contextLabel}` : ''),
    );
    const isCampaignSummaryFilters = Boolean(options.reloadSummaryUrl);
    const maxFilterAttempts = isCampaignSummaryFilters
      ? this.getEnvInt('SCRAPER_NPF_CAMPAIGN_FILTER_MAX_ATTEMPTS', 2)
      : 3;
    const locatorReadinessMs = isCampaignSummaryFilters
      ? this.getEnvInt('SCRAPER_NPF_CAMPAIGN_LOCATOR_WAIT_MS', 6000)
      : 12000;
    const campaignFieldFillTimeoutMs = isCampaignSummaryFilters
      ? this.getEnvInt('SCRAPER_NPF_CAMPAIGN_FIELD_FILL_TIMEOUT_MS', 12000)
      : 30000;
    const filterRetryBackoffMs = isCampaignSummaryFilters
      ? this.getEnvInt('SCRAPER_NPF_CAMPAIGN_FILTER_RETRY_BACKOFF_MS', 600)
      : 1500;

    let appliedCount = 0;
    let failedCount = 0;
    const failedItems: string[] = [];
    let didTriggerSearchOrClick = false;
    const interFilterDelayMs = this.getEnvInt('SCRAPER_DELAY_MS_BETWEEN_FILTERS', 1200);
    const loaderWaitMs = this.getEnvInt('SCRAPER_NPF_LOADER_WAIT_MS', 15000);

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const xpath = item?.xpath?.trim?.();
      const itemName = item?.name ?? `index_${idx}`;

      await this.waitForFixedLoaderToClear(
        page,
        loaderWaitMs,
        options.clientId,
        `${options.contextLabel ?? 'applyFilters'}-pre-item-${idx + 1}`,
      );

      if (!xpath) {
        this.logger.warn(`Filter[${idx + 1}/${items.length}] skipped: empty xpath`);
        continue;
      }

      const selectorType: string | undefined = item?.selector_type;
      const formType = this.mapSelectorTypeToFormFieldType(selectorType);

      const valueToApply: string | undefined = item?.value_to_apply;
      const effectiveValueToApply =
        formType === 'checkbox' &&
        (valueToApply === undefined ||
          valueToApply === null ||
          String(valueToApply).trim().length === 0)
          ? 'true'
          : valueToApply;
      const shouldApply =
        formType === 'click' || formType === 'radio'
          ? true
          : formType === 'checkbox'
            ? true
            : formType === 'select' &&
                (selectorType ?? '').toLowerCase() === 'searchable_dropdown'
              // Allow searchable dropdown "open/select panel" actions even when value is empty.
              ? true
              : valueToApply !== undefined &&
                valueToApply !== null &&
                String(valueToApply).trim().length > 0;

      if (!shouldApply) {
        this.logger.warn(
          `Filter[${idx + 1}/${items.length}] skipped: shouldApply=false ` +
            `(selector_type=${selectorType ?? ''}, formType=${formType}, value_to_apply=${valueToApply ?? ''})`,
        );
        continue;
      }

      const matchCount = await page.locator(`xpath=${xpath}`).count().catch(() => 0);
      this.logger.log(
        `Filter[${idx + 1}/${items.length}] apply: selector_type=${selectorType ?? ''} formType=${formType} name=${itemName} ` +
          `value_to_apply=${effectiveValueToApply ?? ''} match_count=${matchCount} xpath=${xpath}`,
      );

      const secondaryXpath =
        typeof (item as any)?.xpath_end === 'string' ? String((item as any).xpath_end).trim() : '';
      const dateStrategy = this.parseItemDateStrategy(item as { date_strategy?: string });
      const field: FormFieldConfig = {
        xpath,
        type: formType,
        value: effectiveValueToApply,
        optional: true,
        timeoutMs: campaignFieldFillTimeoutMs,
        ...(secondaryXpath ? { secondaryXpath } : {}),
        ...(dateStrategy ? { dateStrategy } : {}),
      };

      let itemApplied = false;
      let lastErr: unknown;
      let locatorStaleReloadedThisItem = false;
      for (let attempt = 1; attempt <= maxFilterAttempts; attempt += 1) {
        try {
          await this.waitForFixedLoaderToClear(
            page,
            loaderWaitMs,
            options.clientId,
            `${options.contextLabel ?? 'applyFilters'}-item-${idx + 1}-attempt-${attempt}`,
          );

          const waitReady = await this.waitForLocatorToReappear(page, xpath, locatorReadinessMs);
          this.logger.log(
            `Filter[${idx + 1}/${items.length}] pre-attempt ${attempt}/${maxFilterAttempts} locator_ready=${waitReady}`,
          );

          if (
            !waitReady &&
            options.reloadSummaryUrl &&
            !locatorStaleReloadedThisItem
          ) {
            locatorStaleReloadedThisItem = true;
            this.logger.warn(
              `Filter[${idx + 1}/${items.length}] locator not ready; reloading summary page once before retry (name=${itemName})`,
            );
            await this.ensureNpfCampaignSummaryPageReady(page, options.reloadSummaryUrl);
            attempt -= 1;
            continue;
          }

          if (!waitReady && options.reloadSummaryUrl && locatorStaleReloadedThisItem) {
            this.logger.warn(
              `Filter[${idx + 1}/${items.length}] locator still not ready after summary reload; ` +
                `failing fast (name=${itemName})`,
            );
            lastErr = new BadRequestException(
              `NPF campaign filter locator not available for "${itemName}" after page reload`,
            );
            break;
          }

          const isNpfDropdown = await page
            .locator(`xpath=${xpath}`)
            .evaluate(
              (el) =>
                el.textContent?.includes('Select') ||
                el.classList.contains('select-institute'),
            )
            .catch(() => false);

          if (isNpfDropdown && formType === 'select') {
            await page.locator(`xpath=${xpath}`).first().click();
            await page.waitForTimeout(1000);
            const desiredValue = String(effectiveValueToApply ?? '');
            const matchedOptionText = await page.evaluate((target) => {
              const normalize = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '');
              const targetNorm = normalize(target);
              const panels = Array.from(
                document.querySelectorAll('.ng-dropdown-panel'),
              ) as HTMLElement[];
              const visiblePanel = panels.find(
                (p) => !!(p.offsetParent || p.getClientRects().length),
              );
              if (!visiblePanel) return '';

              const options = Array.from(
                visiblePanel.querySelectorAll(
                  '.ng-option, .ng-dropdown-panel-items .ng-option, li, div.option',
                ),
              ) as HTMLElement[];

              const visibleOptions = options.filter((el) => {
                const text = (el.textContent ?? '').trim();
                if (!text) return false;
                return !!(el.offsetParent || el.getClientRects().length);
              });

              const exact = visibleOptions.find((el) => {
                const text = (el.textContent ?? '').trim();
                const norm = normalize(text);
                return norm === targetNorm;
              });
              if (exact) {
                exact.click();
                return (exact.textContent ?? '').trim();
              }

              const partial = visibleOptions.find((el) => {
                const text = (el.textContent ?? '').trim();
                const norm = normalize(text);
                if (!norm || !targetNorm) return false;
                return norm.includes(targetNorm) || targetNorm.includes(norm);
              });

              if (!partial) return '';
              partial.click();
              return (partial.textContent ?? '').trim();
            }, desiredValue);

            if (matchedOptionText) {
              this.logger.log(
                `NPF-specific dropdown select successful: requested="${desiredValue}" matched="${matchedOptionText}"`,
              );
              itemApplied = true;
              break;
            }

            // IMPORTANT: For NPF dropdowns we must not proceed when requested option
            // is missing; otherwise old/default selection can be scraped under wrong client.
            throw new BadRequestException(
              `NPF dropdown option not found for "${desiredValue}" (name=${itemName})`,
            );
          }

          await this.formFillerService.fillForm(page, [field], { stopOnError: true });
          await page.waitForTimeout(250);
          itemApplied = true;
          break;
        } catch (err) {
          lastErr = err;
          this.logger.warn(
            `Filter[${idx + 1}/${items.length}] apply failed (attempt ${attempt}/${maxFilterAttempts}) name=${itemName} xpath=${xpath}`,
            err instanceof Error ? err.stack : undefined,
          );

          const errorMessage = err instanceof Error ? err.message : String(err);
          if (
            errorMessage.includes('intercepts pointer events') ||
            errorMessage.includes('fixed-loader')
          ) {
            await this.waitForFixedLoaderToClear(
              page,
              loaderWaitMs,
              options.clientId,
              `${options.contextLabel ?? 'applyFilters'}-after-intercept-${idx + 1}`,
            );
          }
          await page.waitForTimeout(filterRetryBackoffMs);
        }
      }

      if (!itemApplied) {
        failedCount += 1;
        failedItems.push(String(itemName));
        const baseError = `Filter[${idx + 1}/${items.length}] giving up (name=${itemName})`;
        this.logger.warn(baseError);
        if (options.throwOnFailure) {
          const suffix =
            lastErr instanceof Error
              ? `: ${lastErr.message}`
              : lastErr
                ? `: ${String(lastErr)}`
                : '';
          throw new BadRequestException(`${baseError}${suffix}`);
        }
      } else {
        if (formType === 'click' || formType === 'radio') {
          didTriggerSearchOrClick = true;
        }
        appliedCount += 1;
      }

      const itemDelay = typeof item?.delay === 'number' ? item.delay : 0;
      const effectiveDelay = Math.max(itemDelay, interFilterDelayMs);
      if (effectiveDelay > 0) {
        this.logger.log(
          `Filter settle wait: ${effectiveDelay}ms (item_delay=${itemDelay}ms, global_delay=${interFilterDelayMs}ms)`,
        );
        await page.waitForTimeout(effectiveDelay);
      }
    }

    this.logger.log(
      `Filters applied: count=${appliedCount}, failed=${failedCount}` +
        (failedItems.length ? ` failed_items=${failedItems.join(',')}` : ''),
    );
    if (didTriggerSearchOrClick) {
      this.logger.log('Search/click filter detected; waiting for results to load...');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    }

    return { appliedCount, failedCount, failedItems };
  }

  private async waitForLocatorToReappear(page: Page, xpath: string, timeoutMs = 12000): Promise<boolean> {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt += 1;
      const count = await page.locator(`xpath=${xpath}`).count().catch(() => 0);
      this.logger.log(`Locator readiness check attempt=${attempt} count=${count} xpath=${xpath}`);
      if (count > 0) return true;
      await page.waitForTimeout(400);
    }
    this.logger.warn(`Locator did not reappear in ${timeoutMs}ms xpath=${xpath}`);
    return false;
  }

  private async executeStepGroup(
    page: Page,
    clientWiseId: number,
    target: TargetKind,
    group: StepGroup,
  ) {
    const steps = await this.stepRepository.find({
      where: {
        client_wise_id: clientWiseId,
        config_type: target,
        step_group: group,
        is_active: true,
      },
      order: { sequence: 'ASC', id: 'ASC' },
    });
    if (!steps.length) return;

    this.logger.log(`Executing step group "${group}" with ${steps.length} step(s)`);
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i];
      this.logger.log(
        `Step[${i + 1}/${steps.length}] group=${group} id=${s.id} sequence=${s.sequence} type=${s.step_type} ` +
        `name=${s.name ?? ''} xpath=${s.xpath}`,
      );
    }
    const mapped = steps.map((s) => {
      const meta = (s.meta_data ?? {}) as Record<string, unknown>;
      const stepType = (s.step_type ?? '').toLowerCase();
      const value = meta['value_to_apply'] as string | boolean | undefined;
      // IMPORTANT: step_type is the source of truth for execution behavior.
      // meta_data.selector_type may be stale ("click") from earlier UI defaults.
      const selectorType = String(stepType || meta['selector_type'] || 'click');
      const delay = Number(meta['delay_ms'] ?? 0);
      const xpathEnd =
        typeof meta['xpath_end'] === 'string' ? String(meta['xpath_end']).trim() : '';
      const dateStrategyRaw =
        typeof meta['date_strategy'] === 'string' ? String(meta['date_strategy']).trim().toLowerCase() : '';
      const date_strategy =
        dateStrategyRaw === 'auto' || dateStrategyRaw === 'fill' || dateStrategyRaw === 'js'
          ? dateStrategyRaw
          : undefined;
      return {
        xpath: s.xpath,
        name: s.name ?? '',
        selector_type: selectorType,
        value_to_apply: value,
        delay: Number.isFinite(delay) ? delay : 0,
        ...(xpathEnd ? { xpath_end: xpathEnd } : {}),
        ...(date_strategy ? { date_strategy } : {}),
      };
    });
    await this.applyFilters(page, mapped);
  }

  private async waitForResults(page: Page, itemXpath: string): Promise<void> {
    // After clicking Search, results might take time to render via XHR.
    // Wait until at least one row exists.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const count = await page.locator(`xpath=${itemXpath}`).count().catch(() => 0);
      this.logger.log(`Results wait: attempt ${attempt}/5 item_count=${count}`);
      if (count > 0) return;
      await page.waitForTimeout(2000);
    }
    throw new BadRequestException(
      `No results rendered after applying filters. Check/override item_xpath (current: ${itemXpath}).`,
    );
  }

  private async waitBetweenStepPhases(page: Page, label: string): Promise<void> {
    const delayMs = this.getEnvInt('SCRAPER_DELAY_MS_BETWEEN_STEP_GROUPS', 2000);
    this.logger.log(`Phase settle (${label}): waiting ${delayMs}ms for DOM stabilization`);
    if (delayMs > 0) {
      await page.waitForTimeout(delayMs);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
  }

  private mapLeadOrSummaryRowToEntity(
    target: TargetKind,
    row: Record<string, unknown>,
    meta: { client_id: number; year: number; user_id: number; config_id: number },
  ): ClientWiseLeadsDataEntity | ClientWiseSummaryDataEntity | NpfFunnelSummaryEntity {
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      normalized[this.normalizeKey(k)] = v;
    }

    if (target === 'leads') {
      const e = new ClientWiseLeadsDataEntity();
      e.client_id = meta.client_id;
      e.year = meta.year;
      e.user_id = meta.user_id;
      e.config_id = meta.config_id;
      e.raw_data = row;

      e.name = (normalized['name'] ?? null) as string;
      e.email = (normalized['email'] ?? null) as string;
      e.mobile = (normalized['mobile'] ?? null) as string;
      e.lead_origin = (normalized['lead_origin'] ?? null) as string;
      e.country = (normalized['country'] ?? null) as string;
      e.state = (normalized['state'] ?? null) as string;
      e.city = (normalized['city'] ?? null) as string;
      e.instance = (normalized['instance'] ?? null) as string;
      e.instance_date = (normalized['instance_date'] ?? null) as string;
      e.campaign = (normalized['campaign'] ?? null) as string;
      e.lead_stage = (normalized['lead_stage'] ?? null) as string;
      e.lead_status = (normalized['lead_status'] ?? null) as string;
      e.email_verification_status = (normalized['email_verification_status'] ?? null) as string;
      e.mobile_verification_status = (normalized['mobile_verification_status'] ?? null) as string;
      e.lead_score = (normalized['lead_score'] ?? null) as string;
      e.registration_device = (normalized['registration_device'] ?? null) as string;
      e.course = (normalized['course'] ?? null) as string;
      e.specialization = (normalized['specialization'] ?? null) as string;
      e.campus = (normalized['campus'] ?? null) as string;
      e.last_lead_activity_date = (normalized['last_lead_activity_date'] ?? null) as string;
      e.form_initiated = (normalized['form_initiated'] ?? null) as string;
      e.paid_applications = (normalized['paid_applications'] ?? null) as string;
      e.submitted_applications = (normalized['submitted_applications'] ?? null) as string;
      e.enrolment_status = (normalized['enrolment_status'] ?? null) as string;
      e.qualification_level = (normalized['qualification_level'] ?? null) as string;
      e.program = (normalized['program'] ?? null) as string;
      e.degree = (normalized['degree'] ?? null) as string;
      e.discipline = (normalized['discipline'] ?? null) as string;

      return e;
    }

    if (target === 'npf_funnel') {
      const e = new NpfFunnelSummaryEntity();
      e.client_id = meta.client_id;
      e.year = meta.year;
      e.raw_data = row;

      e.source = (normalized['source'] ?? null) as string | null;
      e.primary_leads = (normalized['primary_leads'] ?? null) as string | null;
      e.secondary_leads = (normalized['secondary_leads'] ?? null) as string | null;
      e.tertiary_leads = (normalized['tertiary_leads'] ?? null) as string | null;
      e.total_instances = (normalized['total_instances'] ?? null) as string | null;
      e.verified_leads = (normalized['verified_leads'] ?? null) as string | null;
      e.unverified_leads = (normalized['unverified_leads'] ?? null) as string | null;
      e.form_initiated = (normalized['form_initiated'] ?? normalized['form_status'] ?? null) as string | null;
      e.paid_applications = (normalized['paid_applications'] ?? normalized['payment_approved'] ?? null) as string | null;
      e.submit_applications = (normalized['submit_applications'] ?? normalized['submitted_applications'] ?? null) as string | null;
      e.enrolments = (normalized['enrolments'] ?? normalized['enrolment_status'] ?? null) as string | null;

      e.instance_filter = (row['instance_filter'] ?? 'Instance') as string;
      e.filter_applied = (row['filter_applied'] ?? 'None') as string;
      e.funnel_source = (row['funnel_source'] ?? 'campaign_view') as string;

      return e;
    }

    const e = new ClientWiseSummaryDataEntity();
    e.client_id = meta.client_id;
    e.year = meta.year;
    e.user_id = meta.user_id;
    e.config_id = meta.config_id;
    e.raw_data = row;

    e.source = (normalized['source'] ?? null) as string;
    e.medium = (normalized['medium'] ?? null) as string;
    e.campaign_name = (normalized['campaign_name'] ?? null) as string;
    e.primary_leads = (normalized['primary_leads'] ?? null) as string;
    e.secondary_leads = (normalized['secondary_leads'] ?? null) as string;
    e.tertiary_leads = (normalized['tertiary_leads'] ?? null) as string;
    e.total_instances = (normalized['total_instances'] ?? null) as string;
    e.verified_leads = (normalized['verified_leads'] ?? null) as string;
    e.unverified_leads = (normalized['unverified_leads'] ?? null) as string;
    e.form_initiated = (normalized['form_initiated'] ?? null) as string;
    e.payment_approved = (normalized['payment_approved'] ?? null) as string;
    e.enrolments = (normalized['enrolments'] ?? null) as string;
    e.filter_applied = (normalized['filter_applied'] ?? 'None') as string;

    return e;
  }

  private async scrapeTarget(
    dto: ScrapeTargetDto,
    target: TargetKind,
    opts: ScrapeTargetRunOptions = {},
  ) {
    this.logger.log(
      `Scrape request received: target=${target}, client_wise_id=${dto.client_wise_id ?? 'n/a'}, ` +
      `client_id=${dto.client_id ?? 'n/a'}, year=${dto.year ?? 'n/a'}, config_id=${dto.config_id ?? 'n/a'}`,
    );

    const resolvedUseProxy = dto.use_proxy ?? this.getEnvBool('SCRAPER_USE_PROXY', false);
    const resolvedMaxRetries = dto.max_retries ?? this.getEnvInt('SCRAPER_MAX_RETRIES', 3);

    let clientWise: ClientWiseEntity | null = null;
    if (dto.client_wise_id) {
      clientWise = await this.clientWiseRepository.findOne({ where: { id: dto.client_wise_id } });
    } else {
      if (!dto.client_id || !dto.year) {
        throw new BadRequestException('Provide client_wise_id OR (client_id and year).');
      }

      // If config_id is not provided (testing), pick the latest client_wise row for this client/year.
      if (dto.config_id) {
        clientWise = await this.clientWiseRepository.findOne({
          where: { client_id: dto.client_id, year: dto.year, config_id: dto.config_id },
        });
      } else {
        clientWise = await this.clientWiseRepository.findOne({
          where: { client_id: dto.client_id, year: dto.year },
          order: { id: 'DESC' },
        });
      }
    }

    if (!clientWise) {
      throw new NotFoundException(
        dto.client_wise_id
          ? `client_wise row not found for id=${dto.client_wise_id}`
          : `client_wise row not found for client_id=${dto.client_id}, year=${dto.year}, config_id=${dto.config_id ?? 'latest'}`,
      );
    }

    this.logger.log(
      `Using client_wise row: id=${clientWise.id}, client_id=${clientWise.client_id}, year=${clientWise.year}, ` +
      `user_id=${clientWise.user_id}, config_id=${clientWise.config_id}`,
    );

    if (clientWise.config_id === null || clientWise.config_id === undefined) {
      throw new BadRequestException(`client_wise.config_id is missing for client_wise_id=${clientWise.id}`);
    }
    const resolvedConfigId = clientWise.config_id;

    const targetConfig =
      target === 'leads'
        ? await this.leadsConfigRepository.findOne({
            where: { client_wise_id: clientWise.id, is_active: true },
          })
        : await this.summaryConfigRepository.findOne({
            where: { client_wise_id: clientWise.id, is_active: true },
          });

    if (!targetConfig) {
      throw new NotFoundException(
        `${target} config not found for client_wise_id=${clientWise.id}`,
      );
    }

    this.logger.log(
      `Found ${target} config: url=${(targetConfig as any).url}, filters=${(targetConfig as any).filters?.length ?? 0}, ` +
      `is_advance_filters=${(targetConfig as any).is_advance_filters}, has_extra_steps=${(targetConfig as any).has_extra_steps}`,
    );

    const browser = opts.page
      ? null
      : await this.playwrightService.createBrowser({
          useProxy: resolvedUseProxy,
        });

    const page = opts.page ?? browser!.page;
    try {
      // 1) Login unless we're explicitly reusing an authenticated session.
      if (!opts.skipLogin) {
        await this.login(page, dto, clientWise);
      } else {
        this.logger.log(
          `Skipping login for ${target}; reusing session for client_id=${clientWise.client_id}`,
        );
      }

      const itemXpath = this.computeItemXpath(dto, targetConfig);
      let nextButtonXpath = this.computeNextButtonXpath(dto);
      const paginationOptions = this.buildPaginationOptionsFromComputed(dto, nextButtonXpath);

      this.logger.log(`Derived item_xpath=${itemXpath}`);
      this.logger.log(`Using next_button_xpath=${nextButtonXpath}`);

      // 2) Navigate to target page with retries
      // Don't use itemXpath as a navigation-ready marker, because rows usually render only AFTER filters/search.
      // Use a stable marker that exists on almost every page.
      await this.navigateWithRetry(page, (targetConfig as any).url, resolvedMaxRetries, ['//body']);
      this.logger.log(`After target navigation (${target}): url=${page.url()}`);

      // 3) If advanced filters are enabled, open the advanced UI before filling.
      // 3) Step executor flow (preferred). Fallback to existing filter arrays for backward compatibility.
      // For summary scraping, use client_wise_summary_config as the source of steps/filters.
      // Keep client_wise_step execution for leads only.
      const useLegacyStepTable = target !== 'summary';
      const stepCount = useLegacyStepTable
        ? await this.stepRepository.count({
            where: { client_wise_id: clientWise.id, config_type: target, is_active: true },
          })
        : 0;
      if (!useLegacyStepTable) {
        this.logger.log(
          'Summary flow: using client_wise_summary_config filters/steps (client_wise_step bypassed).',
        );
      }

      if (opts.skipAllFilters) {
        this.logger.log(
          `Skipping all filters/steps for ${target} (campaign fetch without filters requested)`,
        );
      } else {
        // Always apply base filters JSON first.
        const normalItems = [...(targetConfig.filters ?? [])];
        await this.applyFilters(page, normalItems);
        await this.waitBetweenStepPhases(page, 'after base filters');

        // Then advanced phase.
        if ((targetConfig as any).is_advance_filters) {
          await this.openAdvancedFiltersIfNeeded(page, dto, targetConfig);
          if (useLegacyStepTable && stepCount > 0) {
            await this.executeStepGroup(page, clientWise.id, target, 'advanced');
            await this.waitBetweenStepPhases(page, 'after advanced steps');
          }
        }

        // Then normal step group (if configured).
      if (useLegacyStepTable && stepCount > 0) {
          await this.executeStepGroup(page, clientWise.id, target, 'normal');
          await this.waitBetweenStepPhases(page, 'after normal steps');
        }

        // Extra steps: run whenever the step executor is used (same as normal). Rows are loaded
        // from DB by group; executeStepGroup no-ops if there are none. Do not gate on
        // has_extra_steps — that flag can drift false while extra rows still exist, which
        // skipped date/limit follow-up steps after normal steps.
      if (useLegacyStepTable && stepCount > 0) {
          await this.executeStepGroup(page, clientWise.id, target, 'extra');
          await this.waitBetweenStepPhases(page, 'after extra steps');
        }
      }
      await this.waitForResults(page, itemXpath);

      // 5) Build schema for list extraction using config items
      const schemaItems = [...(targetConfig.filters ?? [])];
      this.logger.log(`Building scraping schema from schema_items=${schemaItems.length}`);
      const schema = this.buildSchemaFromConfig(schemaItems);
      const listOptions: ScrapeListOptions = {
        itemXpath,
      };

      // Optional dynamic extraction config for this config_id + target.
      const tableConfig = await this.extractionConfigService.getActiveTableByConfig(
        target,
        resolvedConfigId,
      );
      const fieldConfigs = tableConfig
        ? await this.extractionConfigService.getActiveFieldsByTableId(tableConfig.id)
        : [];
      const useDynamicExtraction = !!tableConfig && fieldConfigs.length > 0;

      if (tableConfig?.next_selector?.trim()) {
        nextButtonXpath = tableConfig.next_selector.trim();
        this.logger.log(`Using next selector from config_tables: ${nextButtonXpath}`);
        Object.assign(paginationOptions, { nextButtonXpath });
      }
      if (useDynamicExtraction) {
        this.logger.log(
          `Dynamic extraction enabled: table_id=${tableConfig!.id} row_selector=${tableConfig!.row_selector} fields=${fieldConfigs.length}`,
        );
      } else {
        this.logger.log('Dynamic extraction not configured; using legacy filter schema extraction');
      }

      const rowXpathForPagination =
        useDynamicExtraction && tableConfig
          ? this.dynamicExtractionService.normalizeRowSelectorForCount(tableConfig.row_selector)
          : itemXpath;
      Object.assign(paginationOptions, { stabilityCheckXpath: rowXpathForPagination });
      this.logger.log(`Pagination stabilityCheckXpath (first row text must change after Next): ${rowXpathForPagination}`);

      // 6) Paginate + scrape + save per page (streaming) to avoid huge memory/DB writes.
      let totalRows = 0;
      let totalSaved = 0;
      let previousFirstRowFingerprint: string | null = null;

      const perPageCounts = await this.paginationService.paginate<number>(
        page,
        paginationOptions,
        async (page, pageNumber) => {
          this.logger.log(`Scrape page ${pageNumber}: waiting for rows...`);
          await page
            .locator(`xpath=${itemXpath}`)
            .first()
            .waitFor({ state: 'attached', timeout: 30000 })
            .catch(() => null);

          const rowXpathForSettle = rowXpathForPagination;
          await this.waitForTableRowsReady(page, rowXpathForSettle, dto);

          const extractedRows = useDynamicExtraction
            ? await this.dynamicExtractionService.extract(page, tableConfig!, fieldConfigs)
            : await this.scrapingDataService.scrapeList(page, schema, listOptions);
          const rows = useDynamicExtraction
            ? this.dynamicExtractionService.mapFieldKeysToDbColumns(extractedRows, fieldConfigs)
            : extractedRows;

          let stopPagination = false;
          if (rows.length > 0) {
            const fp = this.fingerprintFirstRowForPagination(rows[0] as Record<string, unknown>);
            if (pageNumber >= 2 && previousFirstRowFingerprint !== null && fp === previousFirstRowFingerprint) {
              this.logger.warn(
                `Page ${pageNumber} first row matches previous page (table did not advance after Next). ` +
                `Not queuing duplicate rows. Stop pagination.`,
              );
              stopPagination = true;
            } else {
              previousFirstRowFingerprint = fp;
            }
          }

          if (!stopPagination) {
            totalRows += rows.length;
          }

          const queuedRows = stopPagination ? 0 : rows.length;
          if (queuedRows > 0) {
            await this.queueManagerService.addJob<ScrapeWriteJob>(
              ScrapperService.WRITE_QUEUE_NAME,
              `write-${target}`,
              {
                target,
                rows,
                meta: {
                  client_id: clientWise.client_id,
                  year: clientWise.year,
                  user_id: clientWise.user_id,
                  config_id: resolvedConfigId,
                },
              },
              {
                attempts: 3,
                removeOnComplete: 1000,
                removeOnFail: 1000,
                backoff: { type: 'exponential', delay: 500 },
              },
            );
            totalSaved += queuedRows;
          }

          this.logger.log(`Scrape page ${pageNumber}: rows=${rows.length} queued=${queuedRows}`);
          if (stopPagination) {
            return { value: 0, stopPagination: true };
          }
          return rows.length;
        },
      );

      const pagesScraped = perPageCounts.length;
      this.logger.log(
        `Scraping finished: pages=${pagesScraped} total_rows=${totalRows} total_saved=${totalSaved}`,
      );

      return {
        pages: pagesScraped,
        saved: totalSaved,
        total_scraped: totalRows,
        queued: totalSaved,
      };
    } catch (err) {
      this.logger.error(`Scrape ${target} failed`, err instanceof Error ? err.stack : undefined);
      throw err;
    } finally {
      if (browser) {
        await browser.browser.close().catch(() => null);
      }
    }
  }
}