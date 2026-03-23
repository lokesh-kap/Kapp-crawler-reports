# HandlePaginationService

## What It Is

`HandlePaginationService` is a generic next-page controller.
It repeatedly processes pages and moves to the next one until stop conditions are met.

## How It Works

Main method:

- `paginate(page, options, onPage)`

`onPage` callback:

- runs for each page
- returns page result (items, summary, etc.)
- collected into an array and returned at the end

Pagination options:

- `nextButtonSelector` or `nextButtonXpath`
- `maxPages`
- `stopWhenNextDisabled`
- `waitForLoadStateAfterClick`
- `waitForSelectorAfterClick` / `waitForXpathAfterClick`
- `delayMsBetweenPages`

## Example: Use In Another Service

```ts
import { Injectable } from '@nestjs/common';
import { HandlePaginationService } from './handle-pagination.service';
import { ScrapingDataService } from './scraping-data.service';
import { Page } from 'playwright';

@Injectable()
export class ListingPagerService {
  constructor(
    private readonly paginationService: HandlePaginationService,
    private readonly scrapingDataService: ScrapingDataService,
  ) {}

  async collectAll(page: Page) {
    const perPage = await this.paginationService.paginate(
      page,
      {
        nextButtonSelector: '.pagination-next',
        waitForSelectorAfterClick: '.list-row',
        maxPages: 20,
      },
      async (currentPage) => {
        return this.scrapingDataService.scrapeList(
          currentPage,
          {
            name: { selector: '.name', source: 'text' },
            link: { selector: 'a', source: 'attr', attrName: 'href' },
          },
          { itemSelector: '.list-row' },
        );
      },
    );

    return perPage.flat();
  }
}
```
