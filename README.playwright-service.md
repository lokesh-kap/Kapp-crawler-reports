# PlaywrightService

## What It Is

`PlaywrightService` is a reusable browser launcher for scraping flows.
It creates:

- `browser`
- `context`
- `page`

It supports both:

- proxy mode
- non-proxy mode

It also supports headless/headed mode from env config.

## How It Works

Main method:

- `createBrowser(options?)`

Important options:

- `useProxy`: enable/disable proxy use
- `proxy`: optional explicit proxy object
- `headless`: optional override for UI/background mode
- `blockResources`: block image/font/stylesheet requests for speed

Env variables used:

- `PROXY_DOMAIN_NAME`
- `PROXY_PORT`
- `PROXY_USERNAME`
- `PROXY_PASSWORD`
- `BROWSER_HEADLESS`

## Example: Use In Another Service

```ts
import { Injectable } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';

@Injectable()
export class JobRunnerService {
  constructor(private readonly playwrightService: PlaywrightService) {}

  async run(): Promise<void> {
    const { browser, page } = await this.playwrightService.createBrowser({
      useProxy: true, // false for direct connection
    });

    try {
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
      // do your logic
    } finally {
      await browser.close();
    }
  }
}
```
