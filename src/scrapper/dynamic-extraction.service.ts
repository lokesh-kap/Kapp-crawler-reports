import { Injectable, Logger } from '@nestjs/common';
import type { Page } from 'playwright';
import { ConfigTableEntity } from '../extraction-config/entities/config-table.entity';
import { ConfigTableFieldEntity } from '../extraction-config/entities/config-table-field.entity';

@Injectable()
export class DynamicExtractionService {
  private readonly logger = new Logger(DynamicExtractionService.name);

  private normalizeRowSelector(selector: string): string {
    const raw = (selector ?? '').trim();
    if (!raw) return raw;

    // If selector ends at tbody, expand to rows.
    if (/\/tbody$/i.test(raw)) {
      const normalizedTbody = `${raw}/tr`;
      this.logger.warn(
        `Row selector ended at tbody and was normalized to rows: original="${raw}" normalized="${normalizedTbody}"`,
      );
      return normalizedTbody;
    }

    // Common mistake: using an indexed row selector like .../tr[1], which limits extraction to one row.
    // Normalize to all rows to avoid under-scraping.
    const normalized = raw.replace(/\/tr\[\d+\](?=$|\/)/i, '/tr');
    if (normalized !== raw) {
      this.logger.warn(
        `Row selector looked indexed and was normalized: original="${raw}" normalized="${normalized}"`,
      );
    }
    return normalized;
  }

  private normalizeFieldSelector(selector: string): string {
    const raw = (selector ?? '').trim();
    if (!raw) return raw;

    // If already relative, keep as-is.
    if (raw.startsWith('./') || raw.startsWith('.//')) return raw;

    // Common mistake: absolute selector copied from first row like .../tbody/tr[1]/td[3]
    // Convert to row-relative selector so it works for every row context.
    const absoluteRowCellMatch = raw.match(/\/tbody\/tr\[\d+\]\/(td\[\d+\](?:\/.*)?)$/i);
    if (absoluteRowCellMatch?.[1]) {
      const normalized = `./${absoluteRowCellMatch[1]}`;
      this.logger.warn(
        `Field selector looked absolute-row-specific and was normalized: original="${raw}" normalized="${normalized}"`,
      );
      return normalized;
    }

    return raw;
  }

  async extract(
    page: Page,
    tableConfig: ConfigTableEntity,
    fieldConfigs: ConfigTableFieldEntity[],
  ): Promise<Record<string, unknown>[]> {
    const rowSelector = this.normalizeRowSelector(tableConfig.row_selector);
    const rows = page.locator(`xpath=${rowSelector}`);
    const rowCount = await rows.count().catch(() => 0);
    this.logger.log(
      `Dynamic extract start: row_selector="${rowSelector}" row_count=${rowCount} fields=${fieldConfigs.length}`,
    );

    const normalizedFields = fieldConfigs.map((f) => ({
      ...f,
      selector: this.normalizeFieldSelector(f.selector),
    }));

    const output: Record<string, unknown>[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      const record: Record<string, unknown> = {};

      for (const f of normalizedFields) {
        let value: string | null = null;
        try {
          const cell = row.locator(`xpath=${f.selector}`).first();
          const exists = await cell.count().catch(() => 0);
          if (!exists) {
            if (i === 0) {
              this.logger.warn(
                `Field miss on first row: field_key=${f.field_key} selector="${f.selector}"`,
              );
            }
            record[f.field_key] = null;
            continue;
          }

          if (f.data_type === 'attr' && f.attribute) {
            value = await cell.getAttribute(f.attribute).catch(() => null);
          } else {
            value = await cell.innerText().catch(() => null);
          }
        } catch {
          value = null;
        }
        record[f.field_key] = value?.trim?.() ?? value ?? null;
      }
      if (i === 0) {
        this.logger.log(`Dynamic extract first-row sample: ${JSON.stringify(record)}`);
      }

      output.push(record);
    }

    return output;
  }

  mapFieldKeysToDbColumns(
    rows: Record<string, unknown>[],
    fieldConfigs: ConfigTableFieldEntity[],
  ): Record<string, unknown>[] {
    return rows.map((row) => {
      const obj: Record<string, unknown> = {};
      fieldConfigs.forEach((f) => {
        obj[f.db_column] = row[f.field_key] ?? null;
      });
      return obj;
    });
  }
}

