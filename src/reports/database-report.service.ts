import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import { MailerService } from '../common/mailer/mailer.service';

type DatabaseMappingRow = {
  client_id: number;
  database_name: string;
  medium_code: string;
};

type SummaryAggregateRow = {
  client_id: number;
  medium_code: string;
  primary_leads: number;
  secondary_leads: number;
  tertiary_leads: number;
  total_instances: number;
  verified_leads: number;
  unverified_leads: number;
  form_initiated: number;
  primary_applications: number;
  primary_enrolments: number;
};

type DatabaseReportRow = {
  database_name: string;
  medium_code: string;
  client_name: string;
  primary_leads: number | '';
  secondary_leads: number | '';
  tertiary_leads: number | '';
  total_instances: number | '';
  verified_leads: number | '';
  unverified_leads: number | '';
  form_initiated: number | '';
  primary_applications: number | '';
  primary_enrolments: number | '';
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

    let currentClientId: number | null = null;
    const unique = new Map<string, DatabaseMappingRow>();

    for (const row of records) {
      const rawClientId = this.getCsvValue(row, ['KAPP ID', 'Kapp Id', 'kapp id']);
      if (rawClientId && rawClientId.toLowerCase() !== '(blank)') {
        const parsed = Number(rawClientId);
        currentClientId = Number.isFinite(parsed) ? parsed : null;
      }
      if (!currentClientId) continue;

      const databaseName = this.getCsvValue(row, ['Source2', 'source2']);
      const mediumCode = this.getCsvValue(row, ['Medium', 'medium']);
      if (!mediumCode || mediumCode.toLowerCase() === '(blank)') continue;

      const normalizedDatabaseName =
        !databaseName || databaseName.toLowerCase() === '(blank)' ? '(blank)' : databaseName;

      const key = `${currentClientId}::${normalizedDatabaseName.toLowerCase()}::${mediumCode.toLowerCase()}`;
      if (unique.has(key)) continue;
      unique.set(key, {
        client_id: currentClientId,
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
        const valuesSql = chunk
          .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
          .join(', ');
        const params = chunk.flatMap((r) => [r.client_id, r.database_name, r.medium_code]);
        await this.dataSource.query(
          `
          INSERT INTO database_medium_codes (client_id, database_name, medium_code)
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
    const clientNames = await this.fetchLmsClientNameMap();
    const rows = this.buildReportRows(mappings, summaryRows, clientNames);

    const { buffer } = await this.buildExcel(rows, reportDate);
    const toList = this.parseEmailList(process.env.REPORT_DATABASE_TO);
    const ccList = this.parseEmailList(process.env.REPORT_DATABASE_CC);
    if (toList.length === 0) {
      this.logger.warn('Skipping database report email: REPORT_DATABASE_TO is empty.');
      return { success: true, message: 'Skipped — no recipients.' };
    }

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">
        <p>Hi Team,</p>
        <p>Please find attached the <strong>Database Report</strong> for <strong>${reportDate}</strong>.</p>
        <p>Rows: <strong>${rows.length}</strong> | Databases: <strong>${new Set(rows.map((x) => x.database_name)).size}</strong></p>
        <p>Thanks.</p>
      </div>
    `;

    await this.mailer.sendMail({
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject: `Database Report — ${reportDate}`,
      html,
      attachments: [
        {
          filename: `Database_Report_${reportDate}.xlsx`,
          content: buffer,
        },
      ],
    });

    return { success: true };
  }

  private async ensureMappingTable(): Promise<void> {
    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS database_medium_codes (
        id SERIAL PRIMARY KEY,
        client_id integer NOT NULL,
        database_name text NOT NULL,
        medium_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.dataSource.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_database_medium_codes_client_db_medium
      ON database_medium_codes (client_id, lower(database_name), lower(medium_code))
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
        client_id::int AS client_id,
        database_name::text AS database_name,
        medium_code::text AS medium_code
      FROM database_medium_codes
      ORDER BY database_name ASC, medium_code ASC
    `);
    return rows.map((r: any) => ({
      client_id: Number(r.client_id),
      database_name: String(r.database_name ?? '').trim(),
      medium_code: String(r.medium_code ?? '').trim(),
    }));
  }

  private async fetchSummaryRows(reportDate: string): Promise<SummaryAggregateRow[]> {
    const rows = await this.dataSource.query(
      `
      SELECT
        s.client_id::int AS client_id,
        lower(trim(COALESCE(s.medium, '')))::text AS medium_code,
        SUM(CASE WHEN s.primary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.primary_leads::numeric ELSE 0 END)::numeric AS primary_leads,
        SUM(CASE WHEN s.secondary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.secondary_leads::numeric ELSE 0 END)::numeric AS secondary_leads,
        SUM(CASE WHEN s.tertiary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.tertiary_leads::numeric ELSE 0 END)::numeric AS tertiary_leads,
        SUM(CASE WHEN s.total_instances ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.total_instances::numeric ELSE 0 END)::numeric AS total_instances,
        SUM(CASE WHEN s.verified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.verified_leads::numeric ELSE 0 END)::numeric AS verified_leads,
        SUM(CASE WHEN s.unverified_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.unverified_leads::numeric ELSE 0 END)::numeric AS unverified_leads,
        SUM(CASE WHEN s.form_initiated ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.form_initiated::numeric ELSE 0 END)::numeric AS form_initiated,
        SUM(CASE WHEN s.payment_approved ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.payment_approved::numeric ELSE 0 END)::numeric AS primary_applications,
        SUM(CASE WHEN s.enrolments ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.enrolments::numeric ELSE 0 END)::numeric AS primary_enrolments
      FROM client_wise_summary_data s
      WHERE (s.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      GROUP BY s.client_id, lower(trim(COALESCE(s.medium, '')))
      `,
      [reportDate],
    );
    return rows.map((r: any) => ({
      client_id: Number(r.client_id),
      medium_code: String(r.medium_code ?? '').trim().toLowerCase(),
      primary_leads: Number(r.primary_leads ?? 0),
      secondary_leads: Number(r.secondary_leads ?? 0),
      tertiary_leads: Number(r.tertiary_leads ?? 0),
      total_instances: Number(r.total_instances ?? 0),
      verified_leads: Number(r.verified_leads ?? 0),
      unverified_leads: Number(r.unverified_leads ?? 0),
      form_initiated: Number(r.form_initiated ?? 0),
      primary_applications: Number(r.primary_applications ?? 0),
      primary_enrolments: Number(r.primary_enrolments ?? 0),
    }));
  }

  private async fetchLmsClientNameMap(): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const backendUrl = (process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001').replace(/\/+$/, '');
    const apiKey = process.env.REPORTING_METADATA_API_SECRET_KEY || 'kapp-crawler-reports';
    try {
      const response = await axios.get(`${backendUrl}/clients/reporting-metadata`, {
        headers: { 'x-api-key': apiKey },
      });
      const rows = (response.data?.data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const clientId = Number(row.client_id);
        if (!Number.isFinite(clientId)) continue;
        const clientName = String(row.client_name ?? '').trim();
        out.set(clientId, clientName || `Client ${clientId}`);
      }
    } catch (err: any) {
      this.logger.warn(`Database report: failed to fetch LMS metadata (${err?.message ?? err}).`);
    }
    return out;
  }

  private buildReportRows(
    mappings: DatabaseMappingRow[],
    summaryRows: SummaryAggregateRow[],
    clientNames: Map<number, string>,
  ): DatabaseReportRow[] {
    const summaryMap = new Map<string, SummaryAggregateRow>();
    for (const s of summaryRows) {
      summaryMap.set(`${s.client_id}::${s.medium_code}`, s);
    }

    return mappings.map((m) => {
      const mediumNorm = m.medium_code.trim().toLowerCase();
      const data = summaryMap.get(`${m.client_id}::${mediumNorm}`);
      return {
        database_name: m.database_name,
        medium_code: m.medium_code,
        client_name: clientNames.get(m.client_id) || `Client ${m.client_id}`,
        primary_leads: data ? data.primary_leads : '',
        secondary_leads: data ? data.secondary_leads : '',
        tertiary_leads: data ? data.tertiary_leads : '',
        total_instances: data ? data.total_instances : '',
        verified_leads: data ? data.verified_leads : '',
        unverified_leads: data ? data.unverified_leads : '',
        form_initiated: data ? data.form_initiated : '',
        primary_applications: data ? data.primary_applications : '',
        primary_enrolments: data ? data.primary_enrolments : '',
      };
    });
  }

  private async buildExcel(
    rows: DatabaseReportRow[],
    reportDate: string,
  ): Promise<{ buffer: Buffer }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Database Report');
    const columns = [
      { header: 'Database Name', key: 'database_name', width: 28 },
      { header: 'Medium Code', key: 'medium_code', width: 18 },
      { header: 'Client Name', key: 'client_name', width: 30 },
      { header: 'Primary Leads', key: 'primary_leads', width: 14 },
      { header: 'Secondary Leads', key: 'secondary_leads', width: 16 },
      { header: 'Tertiary Leads', key: 'tertiary_leads', width: 14 },
      { header: 'Total Instances', key: 'total_instances', width: 14 },
      { header: 'Verified Leads', key: 'verified_leads', width: 14 },
      { header: 'Unverified leads', key: 'unverified_leads', width: 16 },
      { header: 'Form Initiated', key: 'form_initiated', width: 14 },
      { header: 'Primary Applications', key: 'primary_applications', width: 18 },
      { header: 'Primary Enrolments', key: 'primary_enrolments', width: 16 },
    ];

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
