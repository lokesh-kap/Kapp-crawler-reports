import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as ExcelJS from 'exceljs';
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

    const overallLeads = vendorAggList.reduce((acc, v) => acc + v.totalLeads, 0);
    const overallApplications = vendorAggList.reduce((acc, v) => acc + v.totalApplications, 0);

    const { buffer, emailRows, emailCols } = await this.buildVendorExcel(
      vendorAggList,
      reportDate,
      overallLeads,
      overallApplications,
    );

    const toList = this.parseEmailList(process.env.REPORT_VENDOR_TO);
    const ccList = this.parseEmailList(process.env.REPORT_VENDOR_CC);
    if (toList.length === 0) {
      this.logger.warn('Skipping vendor report email: REPORT_VENDOR_TO is empty.');
      return { success: true, message: 'Skipped — no recipients.' };
    }

    const html = buildEmailTemplate({
      title: 'Vendor / Publisher Report',
      subtitle: `NPF day-wise summary mapped by vendor medium codes (${reportDate})`,
      date: reportDate,
      summaryCards: [
        { label: 'Vendors', value: vendorAggList.length },
        { label: 'Overall Leads', value: overallLeads },
        { label: 'Overall Applications', value: overallApplications },
      ],
      columns: emailCols,
      rows: emailRows,
      footerNote:
        'Leads = primary_leads, Applications = payment_approved from client_wise_summary_data. Matching uses lowercase medium codes.',
    });

    await this.mailer.sendMail({
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject: `Vendor Report — ${reportDate}`,
      html,
      attachments: [
        {
          filename: `Vendor_Report_${reportDate}.xlsx`,
          content: buffer,
        },
      ],
    });

    return { success: true };
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

  private async buildVendorExcel(
    vendors: VendorAggregate[],
    reportDate: string,
    overallLeads: number,
    overallApplications: number,
  ): Promise<{
    buffer: Buffer;
    emailRows: Record<string, unknown>[];
    emailCols: { key: string; label: string }[];
  }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Vendor Report');
    ws.columns = [
      { key: 'campus', width: 48 },
      { key: 'leads', width: 14 },
      { key: 'applications', width: 16 },
    ];

    const emailRows: Record<string, unknown>[] = [];
    const emailCols = [
      { key: 'vendor', label: 'Vendor' },
      { key: 'campus', label: 'Campus' },
      { key: 'leads', label: 'Leads' },
      { key: 'applications', label: 'Applications' },
    ];

    ws.addRow([`Vendor Report (${reportDate})`]);
    ws.mergeCells(1, 1, 1, 3);
    ws.getRow(1).font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A68' } };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' };

    ws.addRow(['Overall Total', overallLeads, overallApplications]);
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF4E5' } };

    ws.addRow([]);
    let rowPointer = 4;

    for (const vendor of vendors) {
      ws.addRow([vendor.vendorName]);
      ws.mergeCells(rowPointer, 1, rowPointer, 3);
      ws.getRow(rowPointer).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(rowPointer).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3A68' } };
      rowPointer += 1;

      ws.addRow([`CODE: ${vendor.codes.join(', ')}`]);
      ws.mergeCells(rowPointer, 1, rowPointer, 3);
      ws.getRow(rowPointer).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(rowPointer).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8A6F00' } };
      rowPointer += 1;

      ws.addRow(['Total', vendor.totalLeads, vendor.totalApplications]);
      ws.getRow(rowPointer).font = { bold: true };
      ws.getRow(rowPointer).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC4D4C0' } };
      rowPointer += 1;

      ws.addRow(['Campus', 'Leads', 'Applications']);
      ws.getRow(rowPointer).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(rowPointer).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8F8F8F' } };
      rowPointer += 1;

      const campuses = Array.from(vendor.campuses.values()).sort((a, b) => a.campus.localeCompare(b.campus));
      for (const c of campuses) {
        ws.addRow([c.campus, c.leads, c.applications]);
        rowPointer += 1;
        emailRows.push({
          vendor: vendor.vendorName,
          campus: c.campus,
          leads: c.leads,
          applications: c.applications,
        });
      }
      ws.addRow([]);
      rowPointer += 1;

      if (campuses.length === 0) {
        emailRows.push({
          vendor: vendor.vendorName,
          campus: '—',
          leads: 0,
          applications: 0,
        });
      }
    }

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, emailRows, emailCols };
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

