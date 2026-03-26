import { Injectable, Logger } from '@nestjs/common';
import { Browser, BrowserContext, Page, chromium } from 'playwright';

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

    const context = await browser.newContext({
      userAgent: this.getRandomUserAgent(),
      viewport: { width: 1280, height: 720 },
    });

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

  private getRandomUserAgent(): string {
    const agents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
  }
}