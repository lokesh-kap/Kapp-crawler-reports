import { Injectable, Logger } from '@nestjs/common';
import { Locator, Page } from 'playwright';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'click'
  | 'file'
  | 'date'
  | 'date_range';

export type DateFillStrategy = 'auto' | 'fill' | 'js';

export type FormFieldConfig = {
  xpath: string;
  value?: string | boolean;
  type?: FormFieldType;
  timeoutMs?: number;
  clearBeforeType?: boolean;
  optional?: boolean;
  /** End date field for `date_range` when the UI has two inputs */
  secondaryXpath?: string;
  /**
   * How to set `type=date` / calendar-backed inputs.
   * - auto: try Playwright fill; if readonly or fill fails, assign value in page JS + events (often works for Angular/Material).
   * - fill: fill/Tab only.
   * - js: click to focus, then JS assign (use when the field is read-only or opens a picker that ignores typing).
   * Override per field via step meta `date_strategy`; default from env SCRAPER_DATE_STRATEGY or `auto`.
   */
  dateStrategy?: DateFillStrategy;
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

    const first = locator.first();
    await first.waitFor({ state: 'attached', timeout: timeoutMs });
    // <option> nodes are usually not "visible" while the <select> is closed; waiting visible times out.
    if (type === 'select') {
      const isOption = await first
        .evaluate((el) => (el as HTMLElement).tagName.toLowerCase() === 'option')
        .catch(() => false);
      if (!isOption) {
        await first.waitFor({ state: 'visible', timeout: timeoutMs });
      }
    } else if (type === 'date_range' && field.secondaryXpath?.trim()) {
      await first.waitFor({ state: 'visible', timeout: timeoutMs });
      await page
        .locator(`xpath=${field.secondaryXpath.trim()}`)
        .first()
        .waitFor({ state: 'visible', timeout: timeoutMs });
    } else {
      await first.waitFor({ state: 'visible', timeout: timeoutMs });
    }
    const target = locator.first();

    switch (type) {
      case 'text':
      case 'textarea':
        await this.fillText(target, field.value, field.clearBeforeType ?? true);
        return;

      case 'date':
        await this.handleDateField(page, target, field);
        return;

      case 'date_range':
        await this.handleDateRange(page, field, target, timeoutMs);
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

  /** If s looks like D/M/DD-MM-YYYY, return YYYY-MM-DD for native `<input type="date">`; else unchanged. */
  private tryDdMmYyyyToIso(s: string): string {
    const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s.trim());
    if (!m) return s;
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  private resolveDateStrategy(field: FormFieldConfig): DateFillStrategy {
    const fromField = (field.dateStrategy ?? '').toLowerCase();
    if (fromField === 'fill' || fromField === 'js') return fromField;
    const env = (process.env.SCRAPER_DATE_STRATEGY ?? 'auto').toLowerCase();
    if (env === 'fill' || env === 'js') return env;
    return 'auto';
  }

  /**
   * Many SPAs use read-only inputs + calendar popups. Plain fill() does nothing or throws.
   * auto: fill when possible; otherwise set value + dispatch input/change (Angular-friendly).
   */
  private async handleDateField(page: Page, locator: Locator, field: FormFieldConfig): Promise<void> {
    const raw = String(field.value ?? '').trim();
    const timeoutMs = field.timeoutMs ?? 15000;
    const strategy = this.resolveDateStrategy(field);

    const inputMeta = await locator
      .evaluate((el) => ({
        inputType: (el as HTMLInputElement).type?.toLowerCase() ?? '',
        readOnly: !!(el as HTMLInputElement).readOnly,
        hasReadonlyAttr: el.hasAttribute('readonly'),
      }))
      .catch(() => ({ inputType: '', readOnly: false, hasReadonlyAttr: false }));

    const valueForNativeDate = inputMeta.inputType === 'date' ? this.tryDdMmYyyyToIso(raw) : raw;

    const tryFill = async () => {
      await this.fillText(locator, valueForNativeDate, field.clearBeforeType ?? true);
      await locator.press('Tab').catch(() => null);
    };

    const tryJsAssign = async () => {
      const val = valueForNativeDate;
      await locator.evaluate((el, v: string) => {
        const inp = el as HTMLInputElement;
        inp.removeAttribute('readonly');
        inp.readOnly = false;
        inp.focus();
        inp.value = v;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          inp.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: v, inputType: 'insertReplacementText' }),
          );
        } catch {
          // InputEvent missing in some runtimes
        }
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
      }, val);
      await locator.press('Tab').catch(() => null);
      await page.keyboard.press('Escape').catch(() => null);
      this.logger.log(`Date set via JS assign value="${val}"`);
    };

    if (strategy === 'fill') {
      await tryFill();
      return;
    }

    if (strategy === 'js') {
      await locator.click({ timeout: timeoutMs }).catch(() => null);
      await page.waitForTimeout(180);
      await tryJsAssign();
      return;
    }

    // auto
    if (inputMeta.readOnly || inputMeta.hasReadonlyAttr) {
      this.logger.log('Date input is read-only; using JS assign');
      await locator.click({ timeout: timeoutMs }).catch(() => null);
      await page.waitForTimeout(180);
      await tryJsAssign();
      return;
    }

    try {
      await tryFill();
    } catch (err) {
      this.logger.warn(
        `Date fill() failed (${err instanceof Error ? err.message : String(err)}); trying JS assign`,
      );
      await locator.click({ timeout: timeoutMs }).catch(() => null);
      await page.waitForTimeout(220);
      await tryJsAssign();
    }
  }

  /**
   * Split range into [start, end]. Supports:
   * - Single input: `02-03-2026 - 28-03-2026` (space-hyphen-space, common DD-MM-YYYY UIs)
   * - Also: `|`, `..`, or ` to ` between dates.
   */
  private parseDateRangeParts(raw: string): string[] {
    const trimmed = raw.trim();
    const bySpacedDash = trimmed
      .split(/\s+-\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (bySpacedDash.length >= 2) {
      return [bySpacedDash[0], bySpacedDash[1]];
    }
    return trimmed
      .split(/\s*\|\s*|\s*\.\.\s*|\s+to\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private async handleDateRange(
    page: Page,
    field: FormFieldConfig,
    primary: Locator,
    timeoutMs: number,
  ): Promise<void> {
    const raw = String(field.value ?? '').trim();
    if (!raw.length) {
      throw new Error(
        'date_range requires value_to_apply (e.g. 02-03-2026 - 28-03-2026 or 2025-01-01|2025-03-31)',
      );
    }
    const parts = this.parseDateRangeParts(raw);
    const secondary = field.secondaryXpath?.trim();
    if (secondary) {
      if (parts.length < 2) {
        throw new Error(
          'date_range with xpath_end needs two dates (e.g. 02-03-2026 - 28-03-2026 or start|end)',
        );
      }
      const start = parts[0];
      const end = parts[1];
      await this.fillText(primary, start, field.clearBeforeType ?? true);
      await primary.press('Tab').catch(() => null);
      const endLoc = page.locator(`xpath=${secondary}`).first();
      await endLoc.waitFor({ state: 'visible', timeout: timeoutMs });
      await this.fillText(endLoc, end, field.clearBeforeType ?? true);
      await endLoc.press('Tab').catch(() => null);
      this.logger.log(`Date range (two fields): start="${start}" end="${end}"`);
      return;
    }
    const joiner = (process.env.SCRAPER_DATE_RANGE_JOINER ?? ' - ').trim() || ' - ';
    const combined = parts.length >= 2 ? `${parts[0]}${joiner}${parts[1]}` : parts[0] ?? raw;
    await this.fillText(primary, combined, field.clearBeforeType ?? true);
    await primary.press('Tab').catch(() => null);
    this.logger.log(`Date range (single field): "${combined}"`);
  }

  private async handleSelect(
    page: Page,
    target: Locator,
    value: string | boolean | undefined,
  ): Promise<void> {
    const text = String(value ?? '').trim();

    // 0) XPath points at <option>: rewrite value + visible label from value_to_apply, then select on parent <select>.
    //    Use when the site only ships e.g. 10/20/50/100 but the backend accepts a larger page size (e.g. 1000).
    const tagHint = await target
      .evaluate((el) => (el as HTMLElement).tagName.toLowerCase())
      .catch(() => '');
    if (tagHint === 'option') {
      if (!text.length) {
        throw new Error(
          'value_to_apply is required when xpath targets an <option> (e.g. set 1000 to replace that option value)',
        );
      }
      await target.evaluate((el, newVal: string) => {
        const opt = el as HTMLOptionElement;
        const parent = opt.parentElement;
        if (parent && parent.tagName.toLowerCase() === 'select') {
          (parent as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        opt.value = newVal;
        opt.textContent = newVal;
        if (!parent || parent.tagName.toLowerCase() !== 'select') {
          return;
        }
        const sel = parent as HTMLSelectElement;
        sel.value = newVal;
        for (let i = 0; i < sel.options.length; i += 1) {
          sel.options[i].selected = sel.options[i].value === newVal;
        }
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          sel.dispatchEvent(new InputEvent('input', { bubbles: true, data: newVal, inputType: 'insertReplacementText' }));
        } catch {
          // InputEvent not available in very old runtimes
        }
      }, text);
      this.logger.log(
        `Select(option) set option to value/label="${text}" and selected it on parent <select> (Angular-friendly events)`,
      );
      return;
    }

    // 1) Native <select>
    try {
      const tag = await target.evaluate((el) => (el as HTMLElement).tagName.toLowerCase());
      if (tag === 'select') {
        const indexMatch = /^index\s*:\s*(\d+)$/i.exec(text);
        if (indexMatch) {
          const idx = Number(indexMatch[1]);
          await target.selectOption({ index: idx });
          this.logger.log(`Select(native) applied by index=${idx} (value_to_apply="${text}")`);
          return;
        }
        try {
          await target.selectOption({ value: text });
          this.logger.log(`Select(native) applied by value="${text}"`);
          return;
        } catch {
          await target.selectOption({ label: text });
          this.logger.log(`Select(native) applied by label="${text}"`);
          return;
        }
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
