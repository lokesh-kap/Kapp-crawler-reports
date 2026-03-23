import { Injectable, Logger } from '@nestjs/common';
import { Locator, Page } from 'playwright';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'click'
  | 'file';

export type FormFieldConfig = {
  xpath: string;
  value?: string | boolean;
  type?: FormFieldType;
  timeoutMs?: number;
  clearBeforeType?: boolean;
  optional?: boolean;
};

export type FillFormOptions = {
  stopOnError?: boolean;
  delayMsBetweenFields?: number;
};

@Injectable()
export class FormFillerService {
  private readonly logger = new Logger(FormFillerService.name);

  async fillForm(
    page: Page,
    fields: FormFieldConfig[],
    options: FillFormOptions = {},
  ): Promise<void> {
    const stopOnError = options.stopOnError ?? true;
    const delayMsBetweenFields = options.delayMsBetweenFields ?? 0;

    for (const field of fields) {
      try {
        await this.fillSingleField(page, field);

        if (delayMsBetweenFields > 0) {
          await page.waitForTimeout(delayMsBetweenFields);
        }
      } catch (error) {
        const message = `Failed to fill field xpath="${field.xpath}" type="${field.type ?? 'text'}"`;

        if (field.optional) {
          this.logger.warn(`${message}. Skipping optional field.`);
          continue;
        }

        this.logger.error(message, error instanceof Error ? error.stack : undefined);
        if (stopOnError) {
          throw error;
        }
      }
    }
  }

  private async fillSingleField(page: Page, field: FormFieldConfig): Promise<void> {
    const locator = this.getXpathLocator(page, field.xpath);
    const timeoutMs = field.timeoutMs ?? 15000;
    const type = field.type ?? 'text';

    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    const target = locator.first();

    switch (type) {
      case 'text':
      case 'textarea':
        await this.fillText(target, field.value, field.clearBeforeType ?? true);
        return;

      case 'select':
        await target.selectOption(String(field.value ?? ''));
        return;

      case 'checkbox':
        await this.handleCheckbox(target, field.value);
        return;

      case 'radio':
        await target.check();
        return;

      case 'click':
        await target.click();
        return;

      case 'file':
        await target.setInputFiles(String(field.value ?? ''));
        return;

      default:
        throw new Error(`Unsupported field type: ${type}`);
    }
  }

  private getXpathLocator(page: Page, xpath: string): Locator {
    return page.locator(`xpath=${xpath}`);
  }

  private async fillText(locator: Locator, value: string | boolean | undefined, clear: boolean): Promise<void> {
    const text = String(value ?? '');
    if (clear) {
      await locator.fill(text);
      return;
    }
    await locator.type(text);
  }

  private async handleCheckbox(locator: Locator, value: string | boolean | undefined): Promise<void> {
    const desired = this.toBoolean(value);
    if (desired) {
      await locator.check();
      return;
    }
    await locator.uncheck();
  }

  private toBoolean(value: string | boolean | undefined): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    return String(value).toLowerCase() === 'true';
  }
}
