# ScrapingDataService

## What It Is

`ScrapingDataService` is a generic extractor for page data.
It supports extracting:

- a single object from a page/root
- a list of objects from repeated item blocks

## How It Works

Main methods:

- `scrapeObject(page, schema)`
- `scrapeList(page, schema, options)`

Schema field config:

- `selector` or `xpath`
- `source`: `text | html | value | attr`
- `attrName`: attribute name when `source='attr'`
- `multiple`: extract multiple values from matched elements
- `required`: throw error if missing
- `defaultValue`: fallback value
- `trim`: trim output text

List options:

- `itemSelector` or `itemXpath` for repeated cards/rows

## Example: Use In Another Service

```ts
import { Injectable } from '@nestjs/common';
import { ScrapingDataService, ScrapeSchema } from './scraping-data.service';
import { Page } from 'playwright';

@Injectable()
export class ProductScraperService {
  constructor(private readonly scrapingDataService: ScrapingDataService) {}

  async scrapeProducts(page: Page) {
    const schema: ScrapeSchema = {
      title: { selector: '.title', source: 'text', required: true },
      url: { selector: 'a.item-link', source: 'attr', attrName: 'href' },
      price: { selector: '.price', source: 'text', defaultValue: '' },
    };

    return this.scrapingDataService.scrapeList(page, schema, {
      itemSelector: '.product-card',
    });
  }
}
```
