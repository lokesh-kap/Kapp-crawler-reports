# ScrapperService

## What It Is

`ScrapperService` is currently a placeholder service.
Right now it does not contain orchestration logic.

## Intended Role

This service should act as the main coordinator for scrape jobs, for example:

- launch browser via `PlaywrightService`
- fill search/filter forms via `FormFillerService`
- paginate pages via `HandlePaginationService`
- extract data via `ScrapingDataService`
- close browser/context safely

## Example: Future Orchestration Structure

```ts
import { Injectable } from '@nestjs/common';
import { PlaywrightService } from './playwright.service';
import { FormFillerService } from './form-filler.service';
import { ScrapingDataService } from './scraping-data.service';
import { HandlePaginationService } from './handle-pagination.service';

@Injectable()
export class ScrapperService {
  constructor(
    private readonly playwrightService: PlaywrightService,
    private readonly formFillerService: FormFillerService,
    private readonly scrapingDataService: ScrapingDataService,
    private readonly paginationService: HandlePaginationService,
  ) {}

  async runJob(): Promise<void> {
    const { browser, page } = await this.playwrightService.createBrowser({ useProxy: true });

    try {
      await page.goto('https://example.com');
      // form fill + pagination + extraction here
    } finally {
      await browser.close();
    }
  }
}
```
