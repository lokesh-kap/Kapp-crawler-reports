import { Injectable, Logger } from '@nestjs/common';
import { Locator, Page } from 'playwright';

type RootLocator = Page | Locator;

export type FieldSourceType = 'text' | 'html' | 'value' | 'attr';

export type ScrapeFieldConfig = {
  selector?: string;
  xpath?: string;
  source?: FieldSourceType;
  attrName?: string;
  multiple?: boolean;
  trim?: boolean;
  required?: boolean;
  defaultValue?: string | string[] | null;
};

export type ScrapeSchema = Record<string, ScrapeFieldConfig>;

export type ScrapeListOptions = {
  itemSelector?: string;
  itemXpath?: string;
};

@Injectable()
export class ScrapingDataService {
  private readonly logger = new Logger(ScrapingDataService.name);

  async scrapeObject(page: Page, schema: ScrapeSchema): Promise<Record<string, unknown>> {
    return this.extractFromRoot(page, schema);
  }

  async scrapeList(
    page: Page,
    schema: ScrapeSchema,
    options: ScrapeListOptions,
  ): Promise<Record<string, unknown>[]> {
    const listLocator = this.getLocator(page, options.itemSelector, options.itemXpath);
    const count = await listLocator.count();
    const results: Record<string, unknown>[] = [];

    this.logger.log(`Scraping ${count} item(s) from list`);

    for (let index = 0; index < count; index += 1) {
      const itemRoot = listLocator.nth(index);
      const itemData = await this.extractFromRoot(itemRoot, schema);
      results.push(itemData);
    }

    return results;
  }

  private async extractFromRoot(root: RootLocator, schema: ScrapeSchema): Promise<Record<string, unknown>> {
    const output: Record<string, unknown> = {};

    for (const [key, field] of Object.entries(schema)) {
      output[key] = await this.extractField(root, field, key);
    }

    return output;
  }

  private async extractField(
    root: RootLocator,
    field: ScrapeFieldConfig,
    key: string,
  ): Promise<string | string[] | null> {
    const locator = this.getLocator(root, field.selector, field.xpath);
    const count = await locator.count();
    const required = field.required ?? false;

    if (count === 0) {
      if (required) {
        throw new Error(`Required field "${key}" not found`);
      }
      return field.defaultValue ?? null;
    }

    const source = field.source ?? 'text';
    const trim = field.trim ?? true;

    if (field.multiple) {
      const values = await this.extractMultiple(locator, source, field.attrName, trim);
      return values.length > 0 ? values : (field.defaultValue ?? []);
    }

    const value = await this.extractSingle(locator.first(), source, field.attrName, trim);
    return value ?? field.defaultValue ?? null;
  }

  private async extractSingle(
    locator: Locator,
    source: FieldSourceType,
    attrName: string | undefined,
    trim: boolean,
  ): Promise<string | null> {
    let raw: string | null;

    switch (source) {
      case 'html':
        raw = await locator.innerHTML();
        break;
      case 'value':
        raw = await locator.inputValue();
        break;
      case 'attr':
        raw = await locator.getAttribute(attrName ?? 'value');
        break;
      case 'text':
      default:
        raw = await locator.textContent();
        break;
    }

    if (raw === null) {
      return null;
    }
    return trim ? raw.trim() : raw;
  }

  private async extractMultiple(
    locator: Locator,
    source: FieldSourceType,
    attrName: string | undefined,
    trim: boolean,
  ): Promise<string[]> {
    const count = await locator.count();
    const values: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const value = await this.extractSingle(locator.nth(index), source, attrName, trim);
      if (value !== null) {
        values.push(value);
      }
    }

    return values;
  }

  private getLocator(root: RootLocator, selector?: string, xpath?: string): Locator {
    if (!selector && !xpath) {
      throw new Error('Either selector or xpath must be provided');
    }
    if (selector) {
      return root.locator(selector);
    }
    return root.locator(`xpath=${xpath}`);
  }
}
