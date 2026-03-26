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
    const countBefore = await locator.count().catch(() => 0);
    this.logger.log(
      `Fill field start: type=${type} xpath="${field.xpath}" matches=${countBefore} value="${String(field.value ?? '')}"`,
    );

    await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
    const target = locator.first();

    switch (type) {
      case 'text':
      case 'textarea':
        await this.fillText(target, field.value, field.clearBeforeType ?? true);
        return;

      case 'select':
        await this.handleSelect(page, target, field.value);
        return;

      case 'checkbox':
        await this.handleCheckbox(target, field.value);
        return;

      case 'radio':
        await this.clickWithRetry(target, 3, 350);
        return;

      case 'click':
        await this.clickWithRetry(target, 3, 350);
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

  private async handleSelect(
    page: Page,
    target: Locator,
    value: string | boolean | undefined,
  ): Promise<void> {
    const text = String(value ?? '').trim();

    // 1) Native <select>
    try {
      const tag = await target.evaluate((el) => (el as HTMLElement).tagName.toLowerCase());
      if (tag === 'select') {
        await target.selectOption(text);
        this.logger.log(`Select(native) applied value="${text}"`);
        return;
      }
    } catch {
      // ignore and continue with custom dropdown flow
    }

    // 2) Custom dropdown (ng-select / searchable combo) with retries.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.logger.log(`Select(custom) attempt ${attempt}/3 value="${text}"`);
      await this.clickWithRetry(target, 2, 250);
      await new Promise((resolve) => setTimeout(resolve, 250));

      if (text.length > 0) {
        // Prefer typing inside input within the dropdown container.
        const innerInput = target.locator('input').first();
        const innerInputCount = await innerInput.count().catch(() => 0);
        if (innerInputCount > 0) {
          await innerInput.fill(text).catch(() => null);
        } else {
          // Fallback to global combobox/search input.
          const openSearchInput = page
            .locator(
              'input[role="combobox"], .ng-dropdown-panel input[type="text"], .ng-select input[type="text"]',
            )
            .first();
          const openInputCount = await openSearchInput.count().catch(() => 0);
          if (openInputCount > 0) {
            await openSearchInput.fill(text).catch(() => null);
          } else {
            await page.keyboard.type(text).catch(() => null);
          }
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 400));

      // Try selecting exact matching option from common dropdown option patterns.
      if (text.length > 0) {
        const exactOption = page
          .locator(
            '.ng-option .ng-option-label, [role="option"], .dropdown-item, .mat-option-text, .ant-select-item-option-content',
          )
          .filter({ hasText: text })
          .first();
        const exactCount = await exactOption.count().catch(() => 0);
        if (exactCount > 0) {
          await this.clickWithRetry(exactOption, 2, 200);
          this.logger.log(`Select(custom) clicked option text="${text}"`);
          return;
        }
      }

      // Fallback submit for searchable dropdowns.
      await page.keyboard.press('Enter').catch(() => null);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  private async handleCheckbox(locator: Locator, value: string | boolean | undefined): Promise<void> {
    const desired = this.toBoolean(value);
    this.logger.log(`Checkbox action start: desired=${desired}`);
    await locator.scrollIntoViewIfNeeded().catch(() => null);
    try {
      // Native checkbox input path
      const tag = await locator.evaluate((el) => (el as HTMLElement).tagName.toLowerCase());
      if (tag === 'label') {
        // Label-based custom checkbox controls are common in dropdown lists.
        // Avoid repeated clicks here to prevent accidental toggle back.
        this.logger.log('Checkbox label path detected; using single click behavior');
        if (desired) {
          await this.clickWithRetry(locator, 1, 0);
          return;
        }
        // For desired=false on label paths, do best effort single click.
        await this.clickWithRetry(locator, 1, 0);
        return;
      }
      const inputType = await locator.evaluate((el) =>
        (el as HTMLInputElement).type ? (el as HTMLInputElement).type.toLowerCase() : '',
      );
      if (tag === 'input' && inputType === 'checkbox') {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          this.logger.log(`Checkbox native attempt ${attempt}/3`);
          if (desired) {
            await locator.check({ force: attempt > 1 }).catch(() => null);
          } else {
            await locator.uncheck({ force: attempt > 1 }).catch(() => null);
          }

          const checked = await locator.isChecked().catch(() => null);
          this.logger.log(`Checkbox native attempt ${attempt}/3 result checked=${String(checked)}`);
          if (checked === desired) return;
          await locator.click({ force: true }).catch(() => null);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        this.logger.warn('Checkbox native path exhausted without state match');
        return;
      }
    } catch {
      // If introspection fails, continue with fallback behavior below.
    }

    // Custom checkbox widgets (div/span/label). Common in searchable dropdowns.
    // For custom controls, retry click and verify via aria/input descendant hints.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      this.logger.log(`Checkbox custom attempt ${attempt}/3`);
      await this.clickWithRetry(locator, 2, 250);
      const current = await this.readCustomCheckboxState(locator);
      this.logger.log(`Checkbox custom attempt ${attempt}/3 state=${String(current)}`);
      // Some custom controls don't expose a reliable checked state to DOM APIs.
      // If state is indeterminate but click succeeded, treat desired=true as best-effort success.
      if (current === null && desired) return;
      if (current === desired) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.logger.warn('Checkbox custom path exhausted without state match');
  }

  private async clickWithRetry(locator: Locator, maxAttempts = 3, delayMs = 300): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        this.logger.log(`Click attempt ${attempt}/${maxAttempts}`);
        await locator.scrollIntoViewIfNeeded().catch(() => null);
        await locator.click({ timeout: 5000 });
        return;
      } catch {
        try {
          this.logger.warn(`Click attempt ${attempt}/${maxAttempts} failed; trying force click`);
          await locator.click({ timeout: 5000, force: true });
          return;
        } catch {
          this.logger.warn(`Force click failed on attempt ${attempt}/${maxAttempts}; trying JS click`);
          await locator.evaluate((el) => (el as HTMLElement).click()).catch(() => null);
        }
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  private async readCustomCheckboxState(locator: Locator): Promise<boolean | null> {
    try {
      const state = await locator.evaluate((el) => {
        const node = el as HTMLElement;
        const ownAria = node.getAttribute('aria-checked');
        if (ownAria === 'true') return true;
        if (ownAria === 'false') return false;

        const nested = node.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (nested) return !!nested.checked;

        const cls = (node.className || '').toString().toLowerCase();
        if (cls.includes('checked') || cls.includes('selected') || cls.includes('active')) {
          return true;
        }
        return null;
      });
      return state;
    } catch {
      return null;
    }
  }

  private toBoolean(value: string | boolean | undefined): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    const raw = String(value ?? '').trim().toLowerCase();
    return ['true', '1', 'yes', 'on', 'checked'].includes(raw);
  }
}
