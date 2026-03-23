import { Injectable, Logger } from '@nestjs/common';
import { Locator, Page } from 'playwright';

export type PaginationOptions = {
  nextButtonSelector?: string;
  nextButtonXpath?: string;
  waitForSelectorAfterClick?: string;
  waitForXpathAfterClick?: string;
  waitForLoadStateAfterClick?: boolean;
  stopWhenNextDisabled?: boolean;
  disabledAttribute?: string;
  maxPages?: number;
  delayMsBetweenPages?: number;
};

@Injectable()
export class HandlePaginationService {
  private readonly logger = new Logger(HandlePaginationService.name);

  async paginate<T>(
    page: Page,
    options: PaginationOptions,
    onPage: (page: Page, pageNumber: number) => Promise<T>,
  ): Promise<T[]> {
    const maxPages = options.maxPages ?? 50;
    const stopWhenNextDisabled = options.stopWhenNextDisabled ?? true;
    const delayMsBetweenPages = options.delayMsBetweenPages ?? 0;
    const results: T[] = [];

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      this.logger.log(`Handling page ${pageNumber}`);
      results.push(await onPage(page, pageNumber));

      const nextButton = this.getNextButtonLocator(page, options);
      if ((await nextButton.count()) === 0) {
        this.logger.log('Next button not found. Pagination complete.');
        break;
      }

      const next = nextButton.first();

      if (stopWhenNextDisabled && (await this.isDisabled(next, options.disabledAttribute ?? 'disabled'))) {
        this.logger.log('Next button is disabled. Pagination complete.');
        break;
      }

      await next.click();
      await this.waitAfterPaginationClick(page, options);

      if (delayMsBetweenPages > 0) {
        await page.waitForTimeout(delayMsBetweenPages);
      }
    }

    return results;
  }

  private getNextButtonLocator(page: Page, options: PaginationOptions): Locator {
    if (options.nextButtonSelector) {
      return page.locator(options.nextButtonSelector);
    }
    if (options.nextButtonXpath) {
      return page.locator(`xpath=${options.nextButtonXpath}`);
    }
    throw new Error('nextButtonSelector or nextButtonXpath is required');
  }

  private async waitAfterPaginationClick(page: Page, options: PaginationOptions): Promise<void> {
    if (options.waitForLoadStateAfterClick ?? true) {
      await page.waitForLoadState('domcontentloaded');
    }

    if (options.waitForSelectorAfterClick) {
      await page.locator(options.waitForSelectorAfterClick).first().waitFor({ state: 'visible' });
    }

    if (options.waitForXpathAfterClick) {
      await page.locator(`xpath=${options.waitForXpathAfterClick}`).first().waitFor({ state: 'visible' });
    }
  }

  private async isDisabled(locator: Locator, disabledAttribute: string): Promise<boolean> {
    const attr = await locator.getAttribute(disabledAttribute);
    if (attr !== null) {
      return true;
    }

    const ariaDisabled = await locator.getAttribute('aria-disabled');
    if ((ariaDisabled ?? '').toLowerCase() === 'true') {
      return true;
    }

    const className = (await locator.getAttribute('class')) ?? '';
    return className.toLowerCase().includes('disabled');
  }
}
