import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { parse } from 'csv-parse/sync';
import { MailerService } from '../common/mailer/mailer.service';
import { buildEmailTemplate } from '../common/mailer/email-template';
import { VendorMediumCodeEntity } from './entities/vendor-medium-code.entity';

type VendorCampusAggregate = {
  clientId: number;
  campus: string;
  leads: number;
  applications: number;
};

type VendorAggregate = {
  vendorName: string;
  codes: string[];
  totalLeads: number;
  totalApplications: number;
  campuses: Map<number, VendorCampusAggregate>;
};

@Injectable()
export class VendorReportService {
  private readonly logger = new Logger(VendorReportService.name);

  constructor(
    @InjectRepository(VendorMediumCodeEntity)
    private readonly vendorCodeRepo: Repository<VendorMediumCodeEntity>,
    private readonly mailer: MailerService,
  ) {}

  async importVendorMediumCodesFromCsv(): Promise<{ success: boolean; vendors: number; codes: number }> {
    const csvPath = this.resolvePublisherCsvPath();
    if (!csvPath) {
      throw new Error(
        'publisher-medium-codes.csv not found. Checked project root and parent workspace directory.',
      );
    }

    const content = fs.readFileSync(csvPath, 'utf8');
    const records = parse(content, {
      skip_empty_lines: true,
      relax_column_count: true,
    }) as string[][];

    const rows = records.slice(1);
    const unique = new Map<string, VendorMediumCodeEntity>();

    for (const row of rows) {
      const vendorName = String(row?.[0] ?? '').trim();
      if (!vendorName) continue;

      const rawCodeCells = row.slice(1);
      const codes: string[] = [];
      for (const cell of rawCodeCells) {
        const raw = String(cell ?? '').trim();
        if (!raw) continue;
        for (const part of raw.split(',')) {
          const code = String(part ?? '').trim();
          if (!code) continue;
          codes.push(code);
        }
      }

      for (const code of codes) {
        const normalized = code.trim().toLowerCase();
        const key = `${vendorName.toLowerCase()}::${normalized}`;
        if (unique.has(key)) continue;
        const entity = this.vendorCodeRepo.create({
          vendor_name: vendorName,
          medium_code: code,
        });
        unique.set(key, entity);
      }
    }

    await this.vendorCodeRepo.clear();
    if (unique.size > 0) {
      await this.vendorCodeRepo.save(Array.from(unique.values()));
    }

    const vendors = new Set(Array.from(unique.values()).map((x) => x.vendor_name)).size;
    this.logger.log(`Vendor medium codes imported from CSV: vendors=${vendors}, codes=${unique.size}`);
    return { success: true, vendors, codes: unique.size };
  }

  async generateAndSendReport(): Promise<{ success: boolean; message?: string }> {
    const reportDate = this.getReportDateString();
    const vendorCodes = await this.vendorCodeRepo.find({
      order: { vendor_name: 'ASC', medium_code: 'ASC' },
    });
    if (!vendorCodes.length) {
      this.logger.warn('Vendor report skipped: vendor_medium_codes table is empty.');
      return { success: true, message: 'Skipped — no vendor mappings found. Import CSV first.' };
    }

    const lmsClientNameMap = await this.fetchLmsClientNameMap();
    const summaryRows = await this.fetchDailySummaryRows(reportDate);
    const vendorAggMap = this.aggregateVendorData(vendorCodes, summaryRows, lmsClientNameMap);
    const vendorAggList = Array.from(vendorAggMap.values()).sort((a, b) =>
      a.vendorName.localeCompare(b.vendorName),
    );

    const toList = this.parseEmailList(process.env.REPORT_VENDOR_TO);
    const ccList = this.parseEmailList(process.env.REPORT_VENDOR_CC);
    if (toList.length === 0) {
      this.logger.warn('Skipping vendor report email: REPORT_VENDOR_TO is empty.');
      return { success: true, message: 'Skipped — no recipients.' };
    }

    const footerNote =
      'This report is generated automatically. If you notice any inconsistent or incorrect data, please let us know so we can fix and improve it.';

    let sentCount = 0;
    for (const vendor of vendorAggList) {
      if (vendor.campuses.size === 0) {
        this.logger.log(`Vendor report email skipped (0 campus/client): ${vendor.vendorName}`);
        continue;
      }
      const { emailRows, emailCols } = this.buildSingleVendorEmailRows(vendor);
      const html = buildEmailTemplate({
        title: `Vendor / Publisher — ${vendor.vendorName}`,
        date: reportDate,
        summaryCards: [
          { label: 'Medium codes', value: vendor.codes.join(', ') || '—' },
          { label: 'Total leads', value: vendor.totalLeads },
          { label: 'Total applications', value: vendor.totalApplications },
        ],
        columns: emailCols,
        rows: emailRows,
        footerNote,
      });

      await this.mailer.sendMail({
        to: toList,
        cc: ccList.length ? ccList : undefined,
        subject: `Vendor Report — ${vendor.vendorName} — ${reportDate}`,
        html,
      });
      sentCount += 1;
      this.logger.log(`Vendor report email sent: ${vendor.vendorName}`);
    }

    if (sentCount === 0) {
      return { success: true, message: 'Skipped — no vendor has campus/client data.' };
    }

    return { success: true, message: `Sent ${sentCount} vendor email(s).` };
  }

  private resolvePublisherCsvPath(): string | null {
    const candidates = [
      path.join(process.cwd(), 'publisher-medium-codes.csv'),
      path.join(process.cwd(), '..', 'publisher-medium-codes.csv'),
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

  private async fetchLmsClientNameMap(): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const backendUrl = (process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001').replace(/\/+$/, '');
    const apiKey = process.env.REPORTING_METADATA_API_SECRET_KEY || 'kapp-crawler-reports';
    try {
      const response = await axios.get(`${backendUrl}/clients/reporting-metadata`, {
        headers: {
          'x-api-key': apiKey,
        },
      });
      const rows = (response.data?.data ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const clientId = Number(row.client_id);
        if (!Number.isFinite(clientId)) continue;
        const clientName = String(row.client_name ?? '').trim();
        out.set(clientId, clientName || `Client ${clientId}`);
      }
      this.logger.log(`Vendor report: LMS metadata loaded for ${out.size} client(s).`);
    } catch (err: any) {
      this.logger.warn(`Vendor report: failed to fetch LMS metadata (${err?.message ?? err}).`);
    }
    return out;
  }

  private async fetchDailySummaryRows(reportDate: string): Promise<
    Array<{ client_id: number; medium_code: string; leads: number; applications: number }>
  > {
    const rows = await this.vendorCodeRepo.query(
      `
      SELECT
        s.client_id::int AS client_id,
        lower(trim(COALESCE(s.medium, '')))::text AS medium_code,
        SUM(
          CASE
            WHEN s.primary_leads ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.primary_leads::numeric
            ELSE 0
          END
        )::numeric AS leads,
        SUM(
          CASE
            WHEN s.payment_approved ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN s.payment_approved::numeric
            ELSE 0
          END
        )::numeric AS applications
      FROM client_wise_summary_data s
      WHERE (s.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date
        AND lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none'
      GROUP BY s.client_id, lower(trim(COALESCE(s.medium, '')))
      `,
      [reportDate],
    );
    return rows.map((r: any) => ({
      client_id: Number(r.client_id),
      medium_code: String(r.medium_code ?? '').trim().toLowerCase(),
      leads: Number(r.leads ?? 0),
      applications: Number(r.applications ?? 0),
    }));
  }

  private aggregateVendorData(
    vendorCodes: VendorMediumCodeEntity[],
    summaryRows: Array<{ client_id: number; medium_code: string; leads: number; applications: number }>,
    lmsClientNameMap: Map<number, string>,
  ): Map<string, VendorAggregate> {
    const vendorByCode = new Map<string, string[]>();
    const agg = new Map<string, VendorAggregate>();

    for (const v of vendorCodes) {
      const vendorName = String(v.vendor_name ?? '').trim();
      const norm = String(v.medium_code ?? '').trim().toLowerCase();
      const code = String(v.medium_code ?? '').trim();
      if (!vendorName || !norm) continue;

      const arr = vendorByCode.get(norm) ?? [];
      arr.push(vendorName);
      vendorByCode.set(norm, arr);

      if (!agg.has(vendorName)) {
        agg.set(vendorName, {
          vendorName,
          codes: [],
          totalLeads: 0,
          totalApplications: 0,
          campuses: new Map<number, VendorCampusAggregate>(),
        });
      }
      const item = agg.get(vendorName)!;
      if (!item.codes.includes(code)) item.codes.push(code);
    }

    for (const row of summaryRows) {
      const vendorNames = vendorByCode.get(row.medium_code);
      if (!vendorNames?.length) continue;
      for (const vendorName of vendorNames) {
        const vendor = agg.get(vendorName);
        if (!vendor) continue;
        vendor.totalLeads += row.leads;
        vendor.totalApplications += row.applications;
        const current =
          vendor.campuses.get(row.client_id) ??
          ({
            clientId: row.client_id,
            campus: lmsClientNameMap.get(row.client_id) || `Client ${row.client_id}`,
            leads: 0,
            applications: 0,
          } as VendorCampusAggregate);
        current.leads += row.leads;
        current.applications += row.applications;
        vendor.campuses.set(row.client_id, current);
      }
    }

    for (const item of agg.values()) {
      item.codes.sort((a, b) => a.localeCompare(b));
    }
    return agg;
  }

  private buildSingleVendorEmailRows(vendor: VendorAggregate): {
    emailRows: Record<string, unknown>[];
    emailCols: { key: string; label: string }[];
  } {
    const emailCols = [
      { key: 'campus', label: 'Campus' },
      { key: 'leads', label: 'Leads' },
      { key: 'applications', label: 'Applications' },
    ];
    const emailRows: Record<string, unknown>[] = [];
    const campuses = Array.from(vendor.campuses.values()).sort((a, b) => a.campus.localeCompare(b.campus));
    if (campuses.length === 0) {
      emailRows.push({ campus: '—', leads: 0, applications: 0 });
    } else {
      for (const c of campuses) {
        emailRows.push({
          campus: c.campus,
          leads: c.leads,
          applications: c.applications,
        });
      }
    }
    return { emailRows, emailCols };
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

