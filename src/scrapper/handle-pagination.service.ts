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
  stabilityCheckXpath?: string;
  maxSamePageRepeats?: number;
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
    const maxSamePageRepeats = options.maxSamePageRepeats ?? 2;
    const results: T[] = [];
    let samePageRepeatCount = 0;
    const seenPageSignatures = new Set<string>();

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      this.logger.log(`Handling page ${pageNumber}`);
      const currentSignature = await this.getPageSignature(page, options.stabilityCheckXpath);
      if (currentSignature !== 'n/a') {
        if (seenPageSignatures.has(currentSignature)) {
          this.logger.warn(
            `Detected repeated page signature before scrape on page ${pageNumber}; stopping to avoid duplicate scraping.`,
          );
          break;
        }
        seenPageSignatures.add(currentSignature);
      }
      results.push(await onPage(page, pageNumber));

      const beforeSignature = await this.getPageSignature(page, options.stabilityCheckXpath);
      this.logger.log(`Pagination signature before click (page ${pageNumber}): ${beforeSignature}`);

      const nextButton = this.getNextButtonLocator(page, options);
      if ((await nextButton.count()) === 0) {
        this.logger.log('Next button not found. Pagination complete.');
        break;
      }

      const next = nextButton.first();
      const clickableNext = await this.resolveClickableNext(next);
      const nextDebugText = ((await clickableNext.innerText().catch(() => '')) || '')
        .trim()
        .slice(0, 80);
      const nextDebugClass = (await clickableNext.getAttribute('class').catch(() => '')) || '';
      this.logger.log(
        `Next candidate debug: text="${nextDebugText}" class="${nextDebugClass}" count=${await nextButton.count()}`,
      );

      if (
        stopWhenNextDisabled &&
        (await this.isDisabled(clickableNext, options.disabledAttribute ?? 'disabled'))
      ) {
        this.logger.log('Next button is disabled. Pagination complete.');
        break;
      }

      await clickableNext.click().catch(async () => {
        await clickableNext.click({ force: true }).catch(() => null);
      });
      await this.waitAfterPaginationClick(page, options);

      if (delayMsBetweenPages > 0) {
        await page.waitForTimeout(delayMsBetweenPages);
      }

      const afterSignature = await this.getPageSignature(page, options.stabilityCheckXpath);
      this.logger.log(`Pagination signature after click (page ${pageNumber}): ${afterSignature}`);
      if (beforeSignature !== 'n/a' && beforeSignature === afterSignature) {
        const changed = await this.waitForSignatureChange(
          page,
          options.stabilityCheckXpath,
          beforeSignature,
          4000,
        );
        if (changed) {
          this.logger.log('Pagination signature changed after short wait; continuing.');
          samePageRepeatCount = 0;
          continue;
        }
        samePageRepeatCount += 1;
        this.logger.warn(
          `Pagination appears stuck on same page (repeat ${samePageRepeatCount}/${maxSamePageRepeats}).`,
        );
        if (samePageRepeatCount >= maxSamePageRepeats) {
          this.logger.warn('Stopping pagination to prevent duplicate over-scraping.');
          break;
        }
      } else {
        samePageRepeatCount = 0;
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

  private async resolveClickableNext(nextContainer: Locator): Promise<Locator> {
    const childClickable = nextContainer.locator('a,button,[role="button"]').first();
    const count = await childClickable.count().catch(() => 0);
    if (count > 0) return childClickable;
    return nextContainer;
  }

  private async getPageSignature(page: Page, xpath?: string): Promise<string> {
    const targetXpath = (xpath ?? '').trim();
    if (!targetXpath) return 'n/a';
    try {
      const locator = page.locator(`xpath=${targetXpath}`);
      const count = await locator.count();
      const firstText =
        count > 0 ? ((await locator.first().innerText().catch(() => '') || '').trim().slice(0, 120)) : '';
      return `url=${page.url()}|count=${count}|first=${firstText}`;
    } catch {
      return 'n/a';
    }
  }

  private async waitForSignatureChange(
    page: Page,
    xpath: string | undefined,
    previous: string,
    timeoutMs = 4000,
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = await this.getPageSignature(page, xpath);
      if (current !== 'n/a' && current !== previous) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }
}
