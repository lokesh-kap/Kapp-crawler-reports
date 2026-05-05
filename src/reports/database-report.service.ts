import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { MailerService } from '../common/mailer/mailer.service';
import { buildEmailTemplate } from '../common/mailer/email-template';

type DatabaseMappingRow = {
  database_name: string;
  medium_code: string;
};

type SummaryAggregateRow = {
  medium_code: string;
  primary_leads: number | null;
  secondary_leads: number | null;
  tertiary_leads: number | null;
  total_instances: number | null;
  verified_leads: number | null;
  unverified_leads: number | null;
  form_initiated: number | null;
  primary_applications: number | null;
  primary_enrolments: number | null;
  duplicate_leads: number | null;
  duplicate_form_initiated: number | null;
  duplicate_applications: number | null;
  duplicate_admissions: number | null;
};

type DatabaseReportRow = {
  database_name: string;
  medium_code: string;
  primary_leads: number | '';
  secondary_leads: number | '';
  tertiary_leads: number | '';
  total_instances: number | '';
  verified_leads: number | '';
  unverified_leads: number | '';
  form_initiated: number | '';
  primary_applications: number | '';
  primary_enrolments: number | '';
  duplicate_leads: number | '';
  duplicate_form_initiated: number | '';
  duplicate_applications: number | '';
  duplicate_admissions: number | '';
};

@Injectable()
export class DatabaseReportService {
  private readonly logger = new Logger(DatabaseReportService.name);
  private isJobRunning = false;
  private lastRunAt: string | null = null;
  private lastStatus: 'idle' | 'running' | 'success' | 'error' = 'idle';
  private lastMessage = 'No runs yet.';

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) {}

  triggerReportInBackground(): { accepted: boolean; message: string } {
    if (this.isJobRunning) {
      return { accepted: false, message: 'Database report is already running.' };
    }
    this.isJobRunning = true;
    this.lastStatus = 'running';
    this.lastRunAt = new Date().toISOString();
    this.lastMessage = 'Database report generation started.';

    setImmediate(async () => {
      try {
        const result = await this.generateAndSendReport();
        this.lastStatus = 'success';
        this.lastMessage = result.message ?? 'Database report generated and emailed.';
      } catch (err: any) {
        this.lastStatus = 'error';
        this.lastMessage = `Database report failed: ${err?.message ?? err}`;
        this.logger.error(this.lastMessage);
      } finally {
        this.isJobRunning = false;
      }
    });

    return { accepted: true, message: 'Database report job queued.' };
  }

  getJobStatus(): { running: boolean; status: string; lastRunAt: string | null; message: string } {
    return {
      running: this.isJobRunning,
      status: this.lastStatus,
      lastRunAt: this.lastRunAt,
      message: this.lastMessage,
    };
  }

  async importDatabaseMediumCodesFromCsv(): Promise<{ success: boolean; rows: number }> {
    await this.ensureMappingTable();
    const csvPath = this.resolveDatabaseCsvPath();
    if (!csvPath) {
      throw new Error(
        'Database Medium Codes - Sheet3.csv not found. Checked project root and parent workspace directory.',
      );
    }

    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
      skip_empty_lines: true,
      columns: true,
      bom: true,
      relax_column_count: true,
      trim: false,
    }) as Array<Record<string, string>>;

    const unique = new Map<string, DatabaseMappingRow>();

    for (const row of records) {
      const databaseName = this.getCsvValue(row, [
        'Source2',
        'source2',
        'Database Name Code',
        'database name code',
        'Database Name',
        'database name',
      ]);
      const mediumCode = this.getCsvValue(row, ['Medium', 'medium']);
      if (!mediumCode || mediumCode.toLowerCase() === '(blank)') continue;

      const normalizedDatabaseName =
        !databaseName || databaseName.toLowerCase() === '(blank)' ? '(blank)' : databaseName;

      const key = `${normalizedDatabaseName.toLowerCase()}::${mediumCode.toLowerCase()}`;
      if (unique.has(key)) continue;
      unique.set(key, {
        database_name: normalizedDatabaseName,
        medium_code: mediumCode,
      });
    }

    await this.dataSource.query(`TRUNCATE TABLE database_medium_codes`);
    if (unique.size > 0) {
      const rows = Array.from(unique.values());
      const chunkSize = 5000;
      for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const valuesSql = chunk.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
        const params = chunk.flatMap((r) => [r.database_name, r.medium_code]);
        await this.dataSource.query(
          `
          INSERT INTO database_medium_codes (database_name, medium_code)
          VALUES ${valuesSql}
          `,
          params,
        );
      }
    }

    this.logger.log(`Database medium codes imported: rows=${unique.size}`);
    return { success: true, rows: unique.size };
  }

  async generateAndSendReport(): Promise<{ success: boolean; message?: string }> {
    await this.ensureMappingTable();
    const reportDate = this.getReportDateString();
    let mappings = await this.fetchMappings();
    if (mappings.length === 0) {
      this.logger.log('Database mappings empty. Auto-importing from CSV before report generation.');
      const importResult = await this.importDatabaseMediumCodesFromCsv();
      if (!importResult.rows) {
        this.logger.warn('Database report skipped: auto-import loaded zero mappings.');
        return { success: true, message: 'Skipped — no database mappings found in CSV.' };
      }
      mappings = await this.fetchMappings();
    }

    const summaryRows = await this.fetchSummaryRows(reportDate);
    const rows = this.buildReportRows(mappings, summaryRows);
    const toList = this.parseEmailList(process.env.REPORT_DATABASE_TO);
    const ccList = this.parseEmailList(process.env.REPORT_DATABASE_CC);
    if (toList.length === 0) {
      this.logger.warn('Skipping database report email: REPORT_DATABASE_TO is empty.');
      return { success: true, message: 'Skipped — no recipients.' };
    }

    const columns = this.getDatabaseReportColumns();
    const html = buildEmailTemplate({
      title: 'Database Report',
      subtitle: 'Daily medium-code summary',
      date: reportDate,
      summaryCards: [
        { label: 'Rows', value: rows.length },
        { label: 'Databases', value: new Set(rows.map((x) => x.database_name)).size },
        { label: 'Unique medium codes', value: new Set(rows.map((x) => x.medium_code.toLowerCase())).size },
      ],
      columns: columns.map((c) => ({ key: c.key, label: c.header })),
      rows: rows as Record<string, unknown>[],
      footerNote:
        'This report is generated automatically. If you notice any inconsistent or incorrect data, please let us know so we can fix and improve it.',
    });

    await this.mailer.sendMail({
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject: `Database Report — ${reportDate}`,
      html,
    });

    return { success: true };
  }

  private async ensureMappingTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS database_medium_codes (
        id SERIAL PRIMARY KEY,
        database_name text NOT NULL,
        medium_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.dataSource.query(`
      DROP INDEX IF EXISTS uq_database_medium_codes_client_db_medium
    `);
    await this.dataSource.query(`
      ALTER TABLE database_medium_codes DROP COLUMN IF EXISTS client_id
    `);
    await this.dataSource.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_database_medium_codes_db_medium
      ON database_medium_codes (lower(database_name), lower(medium_code))
    `);
  }

  private resolveDatabaseCsvPath(): string | null {
    const candidates = [
      path.join(process.cwd(), 'Database Medium Codes - Sheet3.csv'),
      path.join(process.cwd(), '..', 'Database Medium Codes - Sheet3.csv'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  private parseEmailList(raw: string | undefined): string[] {
    return (raw ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  private getCsvValue(row: Record<string, string>, candidates: string[]): string {
    for (const candidate of candidates) {
      if (candidate in row) return String(row[candidate] ?? '').trim();
    }
    const normalized = new Map<string, string>();
    for (const [k, v] of Object.entries(row)) {
      normalized.set(k.toLowerCase().replace(/\s+/g, ' ').trim(), String(v ?? ''));
    }
    for (const candidate of candidates) {
      const key = candidate.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.has(key)) return normalized.get(key)!.trim();
    }
    return '';
  }

  private async fetchMappings(): Promise<DatabaseMappingRow[]> {
    const rows = await this.dataSource.query(`
      SELECT
        database_name::text AS database_name,
        medium_code::text AS medium_code
      FROM database_medium_codes
      ORDER BY database_name ASC, medium_code ASC
    `);
    return rows.map((r: any) => ({
      database_name: String(r.database_name ?? '').trim(),
      medium_code: String(r.medium_code ?? '').trim(),
    }));
  }

  private async fetchSummaryRows(reportDate: string): Promise<SummaryAggregateRow[]> {
    const rows = await this.dataSource.query(
      `
      SELECT
        lower(trim(COALESCE(s.medium, '')))::text AS medium_code,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.primary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.primary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.primary_leads::numeric ELSE 0 END)::numeric
          ELSE NULL END AS primary_leads,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END)::numeric
          ELSE NULL END AS secondary_leads,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)::numeric
          ELSE NULL END AS tertiary_leads,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.total_instances ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.total_instances ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.total_instances::numeric ELSE 0 END)::numeric
          ELSE NULL END AS total_instances,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.verified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.verified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.verified_leads::numeric ELSE 0 END)::numeric
          ELSE NULL END AS verified_leads,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.unverified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.unverified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.unverified_leads::numeric ELSE 0 END)::numeric
          ELSE NULL END AS unverified_leads,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.form_initiated ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.form_initiated ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.form_initiated::numeric ELSE 0 END)::numeric
          ELSE NULL END AS form_initiated,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.payment_approved ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.payment_approved ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.payment_approved::numeric ELSE 0 END)::numeric
          ELSE NULL END AS primary_applications,
        CASE WHEN COUNT(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.enrolments ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN 1 END) > 0
          THEN SUM(CASE WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none' AND s.enrolments ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.enrolments::numeric ELSE 0 END)::numeric
          ELSE NULL END AS primary_enrolments,
        CASE
          WHEN COUNT(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none'
                AND (
                  s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  OR s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                )
              THEN 1
              ELSE NULL
            END
          ) > 0
          THEN SUM(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none'
              THEN
                (CASE WHEN s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END) +
                (CASE WHEN s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)
              ELSE 0
            END
          )::numeric
          ELSE NULL
        END AS duplicate_leads,
        CASE
          WHEN COUNT(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) = 'form initiated'
                AND (
                  s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  OR s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                )
              THEN 1
              ELSE NULL
            END
          ) > 0
          THEN SUM(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) = 'form initiated'
              THEN
                (CASE WHEN s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END) +
                (CASE WHEN s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)
              ELSE 0
            END
          )::numeric
          ELSE NULL
        END AS duplicate_form_initiated,
        CASE
          WHEN COUNT(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) IN ('paid applications', 'paid application', 'paid apps')
                AND (
                  s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  OR s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                )
              THEN 1
              ELSE NULL
            END
          ) > 0
          THEN SUM(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) IN ('paid applications', 'paid application', 'paid apps')
              THEN
                (CASE WHEN s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END) +
                (CASE WHEN s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)
              ELSE 0
            END
          )::numeric
          ELSE NULL
        END AS duplicate_applications,
        CASE
          WHEN COUNT(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) IN ('enrolment status', 'enrollment status')
                AND (
                  s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  OR s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$'
                )
              THEN 1
              ELSE NULL
            END
          ) > 0
          THEN SUM(
            CASE
              WHEN lower(trim(COALESCE(s.filter_applied, ''))) IN ('enrolment status', 'enrollment status')
              THEN
                (CASE WHEN s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END) +
                (CASE WHEN s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)
              ELSE 0
            END
          )::numeric
          ELSE NULL
        END AS duplicate_admissions
      FROM client_wise_summary_data s
      WHERE (s.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      GROUP BY lower(trim(COALESCE(s.medium, '')))
      `,
      [reportDate],
    );
    return rows.map((r: any) => ({
      medium_code: String(r.medium_code ?? '').trim().toLowerCase(),
      primary_leads: this.toNullableNumber(r.primary_leads),
      secondary_leads: this.toNullableNumber(r.secondary_leads),
      tertiary_leads: this.toNullableNumber(r.tertiary_leads),
      total_instances: this.toNullableNumber(r.total_instances),
      verified_leads: this.toNullableNumber(r.verified_leads),
      unverified_leads: this.toNullableNumber(r.unverified_leads),
      form_initiated: this.toNullableNumber(r.form_initiated),
      primary_applications: this.toNullableNumber(r.primary_applications),
      primary_enrolments: this.toNullableNumber(r.primary_enrolments),
      duplicate_leads: this.toNullableNumber(r.duplicate_leads),
      duplicate_form_initiated: this.toNullableNumber(r.duplicate_form_initiated),
      duplicate_applications: this.toNullableNumber(r.duplicate_applications),
      duplicate_admissions: this.toNullableNumber(r.duplicate_admissions),
    }));
  }

  private buildReportRows(
    mappings: DatabaseMappingRow[],
    summaryRows: SummaryAggregateRow[],
  ): DatabaseReportRow[] {
    const summaryMap = new Map<string, SummaryAggregateRow>();
    for (const s of summaryRows) {
      summaryMap.set(s.medium_code, s);
    }

    const rows: DatabaseReportRow[] = mappings.map((m): DatabaseReportRow => {
      const mediumNorm = m.medium_code.trim().toLowerCase();
      const data = summaryMap.get(mediumNorm);
      return {
        database_name: m.database_name,
        medium_code: m.medium_code,
        primary_leads: data ? (data.primary_leads ?? '') : '',
        secondary_leads: data ? (data.secondary_leads ?? '') : '',
        tertiary_leads: data ? (data.tertiary_leads ?? '') : '',
        total_instances: data ? (data.total_instances ?? '') : '',
        verified_leads: data ? (data.verified_leads ?? '') : '',
        unverified_leads: data ? (data.unverified_leads ?? '') : '',
        form_initiated: data ? (data.form_initiated ?? '') : '',
        primary_applications: data ? (data.primary_applications ?? '') : '',
        primary_enrolments: data ? (data.primary_enrolments ?? '') : '',
        duplicate_leads: data ? (data.duplicate_leads ?? '') : '',
        duplicate_form_initiated: data ? (data.duplicate_form_initiated ?? '') : '',
        duplicate_applications: data ? (data.duplicate_applications ?? '') : '',
        duplicate_admissions: data ? (data.duplicate_admissions ?? '') : '',
      };
    });

    rows.sort((a, b) => Number(b.primary_applications || 0) - Number(a.primary_applications || 0));
    return rows;
  }

  private toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private async buildExcel(
    rows: DatabaseReportRow[],
    reportDate: string,
  ): Promise<{ buffer: Buffer }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Database Report');
    const columns = this.getDatabaseReportColumns();

    ws.columns = columns.map((c) => ({ key: c.key, width: c.width }));
    ws.insertRow(1, [`Database Report (${reportDate})`]);
    ws.mergeCells(1, 1, 1, columns.length);
    ws.getRow(1).font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
    ws.getRow(1).alignment = { horizontal: 'left', vertical: 'middle' };

    const headerRow = ws.getRow(2);
    columns.forEach((col, idx) => {
      const cell = headerRow.getCell(idx + 1);
      cell.value = col.header;
      cell.font = { bold: true };
    });

    rows.forEach((row) => ws.addRow(row));
    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer };
  }

  private getDatabaseReportColumns(): Array<{ header: string; key: keyof DatabaseReportRow; width: number }> {
    return [
      { header: 'Database Name', key: 'database_name', width: 28 },
      { header: 'Medium Code', key: 'medium_code', width: 18 },
      { header: 'Primary Leads', key: 'primary_leads', width: 14 },
      { header: 'Secondary Leads', key: 'secondary_leads', width: 16 },
      { header: 'Tertiary Leads', key: 'tertiary_leads', width: 14 },
      { header: 'Total Instances', key: 'total_instances', width: 14 },
      { header: 'Verified Leads', key: 'verified_leads', width: 14 },
      { header: 'Unverified leads', key: 'unverified_leads', width: 16 },
      { header: 'Form Initiated', key: 'form_initiated', width: 14 },
      { header: 'Primary Applications', key: 'primary_applications', width: 18 },
      { header: 'Primary Enrolments', key: 'primary_enrolments', width: 16 },
      { header: 'Duplicate Leads', key: 'duplicate_leads', width: 18 },
      { header: 'Duplicate Form Initiated', key: 'duplicate_form_initiated', width: 24 },
      { header: 'Duplicate Application', key: 'duplicate_applications', width: 22 },
      { header: 'Duplicate Admission', key: 'duplicate_admissions', width: 20 },
    ];
  }

  private getReportDateString(): string {
    const override = (process.env.REPORT_AS_OF_DATE || '').trim();
    if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  }
}
