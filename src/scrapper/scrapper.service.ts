import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClientWiseEntity } from '../client-wise/entities/client-wise.entity';
import { ClientWiseLeadsConfigEntity } from '../client-wise/entities/client-wise-leads-config.entity';
import { ClientWiseSummaryConfigEntity } from '../client-wise/entities/client-wise-summary-config.entity';
import { ClientWiseLeadsDataEntity } from './entities/client-wise-leads-data.entity';
import { ClientWiseSummaryDataEntity } from './entities/client-wise-summary-data.entity';
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

type TargetKind = 'leads' | 'summary';
type StepGroup = 'normal' | 'advanced' | 'extra';
type ScrapeWriteJob = {
  target: TargetKind;
  rows: Record<string, unknown>[];
  meta: { client_id: number; year: number; user_id: number; config_id: number };
};

@Injectable()
export class ScrapperService implements OnModuleInit {
  private readonly logger = new Logger(ScrapperService.name);
  private static readonly WRITE_QUEUE_NAME = 'scrape-db-write-queue';

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
    private readonly playwrightService: PlaywrightService,
    private readonly formFillerService: FormFillerService,
    private readonly scrapingDataService: ScrapingDataService,
    private readonly paginationService: HandlePaginationService,
    private readonly extractionConfigService: ExtractionConfigService,
    private readonly dynamicExtractionService: DynamicExtractionService,
    private readonly queueManagerService: QueueManagerService,
    private readonly workerManagerService: WorkerManagerService,
  ) {}

  onModuleInit() {
    this.queueManagerService.getQueue(ScrapperService.WRITE_QUEUE_NAME);
    if (!this.workerManagerService.hasWorker(ScrapperService.WRITE_QUEUE_NAME)) {
      this.workerManagerService.registerWorker<ScrapeWriteJob>({
        queueName: ScrapperService.WRITE_QUEUE_NAME,
        concurrency: 3,
        processor: async (job: Job<ScrapeWriteJob>) => {
          const payload = job.data;
          const entities = payload.rows.map((row) =>
            this.mapLeadOrSummaryRowToEntity(payload.target, row, payload.meta),
          );
          if (!entities.length) return { saved: 0 };
          if (payload.target === 'leads') {
            await this.leadsDataRepository.save(entities as ClientWiseLeadsDataEntity[]);
          } else {
            await this.summaryDataRepository.save(entities as ClientWiseSummaryDataEntity[]);
          }
          return { saved: entities.length };
        },
      });
    }
  }

  async scrapeLeads(dto: ScrapeTargetDto) {
    return this.scrapeTarget(dto, 'leads');
  }

  async scrapeSummary(dto: ScrapeTargetDto) {
    return this.scrapeTarget(dto, 'summary');
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

    const advToggleXpath =
      dto.advanced_filters_toggle_xpath && dto.advanced_filters_toggle_xpath.trim().length > 0
        ? dto.advanced_filters_toggle_xpath.trim()
        : `
            //button[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced')]
            | //a[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced')]
            | //*[contains(translate(.,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'advanced filters')]
          `.trim().replace(/\s+/g, ' ');

    try {
      await page.locator(`xpath=${advToggleXpath}`).first().click({ timeout: 7000 });
      this.logger.log('Advanced filter toggle clicked.');
    } catch (err) {
      this.logger.warn(
        'Could not click advanced filter toggle using heuristic; continuing to attempt to fill advanced filters.',
        err instanceof Error ? err.stack : undefined,
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

    // Submit login: try common submit patterns, fallback to Enter key.
    this.logger.log('Submitting login...');
    try {
      // 1) Preferred: click configured submit xpath.
      const submitXpath = (creds as any)?.login_submit_xpath?.trim?.();
      const submitClickMs = this.getEnvInt('SCRAPER_LOGIN_SUBMIT_CLICK_TIMEOUT_MS', 30000);
      if (submitXpath) {
        await page.locator(`xpath=${submitXpath}`).first().click({ timeout: submitClickMs });
      } else {
        // 2) Heuristic: common submit button.
        await page.locator(`xpath=//button[@type="submit"]`).first().click({ timeout: submitClickMs });
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

  private async applyFilters(page: Page, items: Array<any>) {
    this.logger.log(`Applying filters: total_items=${items.length}`);
    let appliedCount = 0;
    let didTriggerSearchOrClick = false;
    const interFilterDelayMs = this.getEnvInt('SCRAPER_DELAY_MS_BETWEEN_FILTERS', 1200);

    for (let idx = 0; idx < items.length; idx += 1) {
      const item = items[idx];
      const xpath = item?.xpath?.trim?.();
      if (!xpath) {
        this.logger.warn(`Filter[${idx + 1}/${items.length}] skipped: empty xpath`);
        continue;
      }

      const selectorType: string | undefined = item?.selector_type;
      const formType = this.mapSelectorTypeToFormFieldType(selectorType);

      const valueToApply: string | undefined = item?.value_to_apply;
      const effectiveValueToApply =
        formType === 'checkbox' && (valueToApply === undefined || valueToApply === null || String(valueToApply).trim().length === 0)
          ? 'true'
          : valueToApply;
      const shouldApply =
        formType === 'click' || formType === 'radio'
          ? true
          : formType === 'checkbox'
            ? true
            : formType === 'select' && (selectorType ?? '').toLowerCase() === 'searchable_dropdown'
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
        `Filter[${idx + 1}/${items.length}] apply: selector_type=${selectorType ?? ''} formType=${formType} name=${item?.name ?? ''} ` +
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
        timeoutMs: 30000,
        ...(secondaryXpath ? { secondaryXpath } : {}),
        ...(dateStrategy ? { dateStrategy } : {}),
      };

      // DOM often changes after login; retry a bit if element isn't ready yet.
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const waitReady = await this.waitForLocatorToReappear(page, xpath, 12000);
          this.logger.log(
            `Filter[${idx + 1}/${items.length}] pre-attempt ${attempt}/3 locator_ready=${waitReady}`,
          );
          await this.formFillerService.fillForm(page, [field], { stopOnError: true });
          // Advanced/custom dropdown UIs often re-render after each click/select.
          // Wait a short beat for DOM stabilization so next step uses fresh nodes.
          await page.waitForTimeout(250);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          this.logger.warn(
            `Filter[${idx + 1}/${items.length}] apply failed (attempt ${attempt}/3) name=${item?.name ?? ''} xpath=${xpath}`,
            err instanceof Error ? err.stack : undefined,
          );
          await page.waitForTimeout(1500);
        }
      }
      if (lastErr) {
        this.logger.warn(`Filter[${idx + 1}/${items.length}] giving up (name=${item?.name ?? ''})`);
      }

      const itemDelay = typeof item?.delay === 'number' ? item.delay : 0;
      const effectiveDelay = Math.max(itemDelay, interFilterDelayMs);
      if (effectiveDelay > 0) {
        this.logger.log(
          `Filter settle wait: ${effectiveDelay}ms (item_delay=${itemDelay}ms, global_delay=${interFilterDelayMs}ms)`,
        );
        await page.waitForTimeout(effectiveDelay);
      }

      if (formType === 'click' || formType === 'radio') {
        didTriggerSearchOrClick = true;
      }
      appliedCount += 1;
    }

    this.logger.log(`Filters applied: count=${appliedCount}`);
    if (didTriggerSearchOrClick) {
      this.logger.log('Search/click filter detected; waiting for results to load...');
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    }
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
  ): ClientWiseLeadsDataEntity | ClientWiseSummaryDataEntity {
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

    return e;
  }

  private async scrapeTarget(dto: ScrapeTargetDto, target: TargetKind) {
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
            where: { client_wise_id: clientWise.id },
          })
        : await this.summaryConfigRepository.findOne({
            where: { client_wise_id: clientWise.id },
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

    const browser = await this.playwrightService.createBrowser({
      useProxy: resolvedUseProxy,
    });

    const page = browser.page;
    try {
      // 1) Always login first
      await this.login(page, dto, clientWise);

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
      const stepCount = await this.stepRepository.count({
        where: { client_wise_id: clientWise.id, config_type: target, is_active: true },
      });

      // Always apply base filters JSON first.
      const normalItems = [...(targetConfig.filters ?? [])];
      await this.applyFilters(page, normalItems);
      await this.waitBetweenStepPhases(page, 'after base filters');

      // Then advanced phase.
      if ((targetConfig as any).is_advance_filters) {
        await this.openAdvancedFiltersIfNeeded(page, dto, targetConfig);
        if (stepCount > 0) {
          await this.executeStepGroup(page, clientWise.id, target, 'advanced');
          await this.waitBetweenStepPhases(page, 'after advanced steps');
        }
      }

      // Then normal step group (if configured).
      if (stepCount > 0) {
        await this.executeStepGroup(page, clientWise.id, target, 'normal');
        await this.waitBetweenStepPhases(page, 'after normal steps');
      }

      // Extra steps: run whenever the step executor is used (same as normal). Rows are loaded
      // from DB by group; executeStepGroup no-ops if there are none. Do not gate on
      // has_extra_steps — that flag can drift false while extra rows still exist, which
      // skipped date/limit follow-up steps after normal steps.
      if (stepCount > 0) {
        await this.executeStepGroup(page, clientWise.id, target, 'extra');
        await this.waitBetweenStepPhases(page, 'after extra steps');
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
      await browser.browser.close().catch(() => null);
    }
  }
}