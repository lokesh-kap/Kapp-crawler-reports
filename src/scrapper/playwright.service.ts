import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContext, BrowserContextOptions, Page, chromium } from 'playwright';

type BrowserLaunchResult = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

type BrowserProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

type CreateBrowserOptions = {
  useProxy?: boolean;
  proxy?: BrowserProxyConfig;
  headless?: boolean;
  blockResources?: boolean;
};

@Injectable()
export class PlaywrightService {
  private readonly logger = new Logger(PlaywrightService.name);

  constructor() {}

  async createBrowser(options: CreateBrowserOptions = {}): Promise<BrowserLaunchResult> {
    const headless = options.headless ?? this.getHeadlessFromEnv();
    const useProxy = options.useProxy ?? false;
    const proxy = useProxy ? (options.proxy ?? this.getProxyFromEnv()) : undefined;

    this.logger.log(
      `Launching browser in ${headless ? 'headless' : 'headed (UI)'} mode; proxy=${proxy ? 'enabled' : 'disabled'}`,
    );

    const browser = await chromium.launch({
      headless,
      proxy,
    });

    const contextOptions = this.buildBrowserContextOptions();
    const extraHdrs = contextOptions.extraHTTPHeaders;
    const acceptLanguageLog =
      extraHdrs !== undefined ? (extraHdrs['Accept-Language'] ?? '(none)') : '(none)';
    this.logger.log(
      `Browser context: locale=${contextOptions.locale ?? 'default'} ` +
        `Accept-Language=${acceptLanguageLog} ` +
        `ua_len=${(contextOptions.userAgent ?? '').length}`,
    );

    const context = await browser.newContext(contextOptions);

    const page = await context.newPage();

    const blockResources = options.blockResources ?? this.getBlockResourcesFromEnv();
    if (blockResources) {
      await page.route('**/*', (route) => {
        const type = route.request().resourceType();
        // Do NOT block stylesheets by default (pages render incorrectly otherwise).
        // Images + fonts are safe to block for speed in most cases.
        if (['image', 'font'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    return { browser, context, page };
  }

  private getProxyFromEnv(): BrowserProxyConfig | undefined {
    const domain = process.env.PROXY_DOMAIN_NAME;
    const port = process.env.PROXY_PORT;

    if (!domain || !port) {
      return undefined;
    }

    return {
      server: `http://${domain}:${port}`,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    };
  }

  private getHeadlessFromEnv(): boolean {
    // If false, browser opens with UI; otherwise runs in background.
    return this.parseBoolean(process.env.BROWSER_HEADLESS, true);
  }

  private getBlockResourcesFromEnv(): boolean {
    // If true, block heavy resources (images/fonts). Default true.
    return this.parseBoolean(process.env.SCRAPER_BLOCK_RESOURCES, true);
  }

  private parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
    if (value === undefined) {
      return defaultValue;
    }
    const v = value.toLowerCase().trim();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return defaultValue;
  }

  /**
   * Full Chrome-style UAs (Chromium). Truncated UAs are often rejected by CDNs/WAFs as non-browser traffic.
   * Playwright still aligns Sec-CH-UA with the bundled Chromium.
   */
  private pickOrganicUserAgent(): string {
    const fromEnv = (process.env.SCRAPER_USER_AGENT ?? '').trim();
    if (fromEnv.length > 20) return fromEnv;

    const chromeMajor = '131';
    const agents = [
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }

  /**
   * Locale + Accept-Language + optional JSON headers. Helps regional sites; not a bypass for strong bot detection.
   */
  private buildBrowserContextOptions(): BrowserContextOptions {
    const viewportW = this.parsePositiveInt(process.env.SCRAPER_VIEWPORT_WIDTH, 1280);
    const viewportH = this.parsePositiveInt(process.env.SCRAPER_VIEWPORT_HEIGHT, 720);
    const locale = (process.env.SCRAPER_LOCALE ?? 'en-IN').trim() || 'en-IN';
    const acceptLanguage =
      (process.env.SCRAPER_ACCEPT_LANGUAGE ?? 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7').trim() ||
      'en-IN,en;q=0.9';

    const extra: Record<string, string> = {
      'Accept-Language': acceptLanguage,
    };

    const tz = (process.env.SCRAPER_TIMEZONE_ID ?? '').trim();
    const rawJson = (process.env.SCRAPER_EXTRA_HTTP_HEADERS_JSON ?? '').trim();
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length > 0) extra[k] = v;
        }
      } catch {
        this.logger.warn('SCRAPER_EXTRA_HTTP_HEADERS_JSON is not valid JSON; ignoring');
      }
    }

    const opts: BrowserContextOptions = {
      userAgent: this.pickOrganicUserAgent(),
      viewport: { width: viewportW, height: viewportH },
      locale,
      extraHTTPHeaders: extra,
    };

    if (tz) {
      opts.timezoneId = tz;
    }

    if (this.parseBoolean(process.env.SCRAPER_IGNORE_HTTPS_ERRORS, false)) {
      opts.ignoreHTTPSErrors = true;
    }

    return opts;
  }

  private parsePositiveInt(raw: string | undefined, fallback: number): number {
    const n = Number(String(raw ?? '').trim());
    return Number.isFinite(n) && n >= 200 ? n : fallback;
  }
}