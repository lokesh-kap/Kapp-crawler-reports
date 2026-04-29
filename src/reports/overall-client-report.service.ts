import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import axios from 'axios';
import * as ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { MailerService } from '../common/mailer/mailer.service';
import { buildEmailTemplate } from '../common/mailer/email-template';

@Injectable()
export class OverallClientReportService {
  private readonly logger = new Logger(OverallClientReportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) { }

  async generateAndSendReport() {
    this.logger.log('📊 Generating Overall Client Report for configured clients...');
    const reportDate = this.getReportDateString();
    const reportDateObj = this.getReportDateObject(reportDate);
    const reportNote =
      'NOTE: This report is auto-generated. If you notice any incorrect data, please let us know so we can investigate and fix the issue at the source. LMS is being updated, upon which the null values in the report will also be updated with the correct fetched values.';

    // 1. Fetch active client IDs from local DB (same base used by scraper runs)
    const activeRows = await this.dataSource.query(`
      SELECT DISTINCT ON (cw.client_id) cw.client_id
      FROM client_wise cw
      WHERE cw.is_active = true
        AND cw.config_id IS NOT NULL
      ORDER BY cw.client_id, cw.id DESC
    `);
    const configuredIds = activeRows.map(r => Number(r.client_id));

    if (configuredIds.length === 0) {
      this.logger.warn('⚠️ No active clients found in client_wise. Report will be empty.');
      return { success: true, message: 'No active clients found.' };
    }

    // 2. Fetch client details from LMS only for those IDs
    const clients = await this.fetchClientsFromLms(configuredIds);
    const reportClients = clients
      .map((c) => ({
        ...c,
        effective_account_zone: this.normalizeLmsValue(c.account_zone),
      }))
      .filter((c) => this.isCampaignStatusActive(this.resolveCampaignStatusForReport(c)));
    this.logger.log(
      `📋 Report scope: ${reportClients.length} client(s) with Active campaign status (of ${clients.length} configured).`,
    );
    const leads = await this.fetchLeadTotals(reportDate);

    // Group by account_zone - FILTER OUT empty/null zones for dedicated emails
    const zones = [...new Set(
      reportClients
        .map(c => (c.effective_account_zone || '').trim())
        .filter(z => z !== '' && z.toLowerCase() !== 'null' && z.toLowerCase() !== 'undefined')
    )];

    this.logger.log(`🌍 Found ${zones.length} valid zones for dedicated emails: ${zones.join(', ')}`);

    for (const zone of zones) {
      this.logger.log(`📑 Generating report for zone: ${zone}`);
      const zoneClients = reportClients.filter(c => (c.effective_account_zone || '').trim() === zone);
      if (zoneClients.length === 0) continue;

      const { buffer, rowsData, columnsData } = await this.buildExcel(zoneClients, leads, reportDateObj);

      const emailHtml = buildEmailTemplate({
        title: `${zone} Zone - Client Report`,
        subtitle: 'Daily Performance Summary',
        date: reportDate,
        summaryCards: [
          { label: 'Zone Clients', value: zoneClients.length },
        ],
        columns: columnsData,
        rows: rowsData,
        footerNote: `Report generated for ${zoneClients.length} clients in ${zone} zone. ${reportNote}`
      });

      // Normalize zone name for env variables (e.g. "North Zone" -> "NORTH_ZONE")
      const zoneKey = zone.toUpperCase().replace(/[^A-Z0-9]/g, '_');

      const zoneToEnv = process.env[`REPORT_${zoneKey}_TO`] || '';
      const zoneCcEnv = process.env[`REPORT_${zoneKey}_CC`] || '';

      const toList = zoneToEnv.split(',').map(s => s.trim()).filter(s => s);
      const ccList = zoneCcEnv.split(',').map(s => s.trim()).filter(s => s);

      if (toList.length === 0) {
        this.logger.warn(`⏭️ Skipping email for ${zone} Zone: No TO recipients configured.`);
        continue;
      }

      await this.mailer.sendMail({
        to: toList,
        cc: ccList.length > 0 ? ccList : undefined,
        subject: `📊 ${zone} Zone Client Report — ${reportDate}`,
        html: emailHtml,
        attachments: [{
          filename: `${zone}_Zone_Report_${reportDate}.xlsx`,
          content: buffer,
        }],
      });
    }

    // Also send the original overall report as before
    const { buffer: overallBuffer, rowsData: overallRows, columnsData: overallCols } = await this.buildExcel(reportClients, leads, reportDateObj);

    const overallEmailHtml = buildEmailTemplate({
      title: 'Overall Client Report',
      subtitle: 'Daily Performance Summary',
      date: reportDate,
      summaryCards: [
        { label: 'Total Clients', value: reportClients.length },
      ],
      columns: overallCols,
      rows: overallRows,
      footerNote: `Overall report generated for ${reportClients.length} client(s) with Active campaign status. ${reportNote}`
    });

    const overallToEnv = process.env.REPORT_OVERALL_TO || '';
    const overallCcEnv = process.env.REPORT_OVERALL_CC || '';

    const overallToList = overallToEnv.split(',').map((s) => s.trim()).filter(s => s);
    const overallCcList = overallCcEnv.split(',').map((s) => s.trim()).filter(s => s);

    if (overallToList.length === 0) {
      this.logger.warn(`⏭️ Skipping Overall Client Report email: No TO recipients configured.`);
      return { success: true, message: 'Skipped - no recipients' };
    }

    await this.mailer.sendMail({
      to: overallToList,
      cc: overallCcList.length > 0 ? overallCcList : undefined,
      subject: `📊 Overall Client Report — ${reportDate}`,
      html: overallEmailHtml,
      attachments: [{
        filename: `Overall_Client_Report_${reportDate}.xlsx`,
        content: overallBuffer,
      }],
    });

    return { success: true };
  }

  private async fetchClientsFromLms(clientIds: number[]): Promise<any[]> {
    const backendUrl = (process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001').replace(
      /\/+$/,
      '',
    );
    const apiKey = process.env.REPORTING_METADATA_API_SECRET_KEY || 'kapp-crawler-reports';
    try {
      this.logger.log(`📡 Fetching client metadata from LMS API: ${backendUrl}`);
      const response = await axios.get(`${backendUrl}/clients/reporting-metadata`, {
        headers: {
          'x-api-key': apiKey
        }
      });
      const allClients = response.data?.data || [];

      // Filter locally for the requested IDs and map keys
      const filtered = allClients
        .filter((c: any) => clientIds.includes(Number(c.client_id)))
        .map((c: any) => ({
          ...c,
          state: c.client_state, // Map client_state to state for Excel
        }));

      this.logger.log(`✅ Successfully fetched ${filtered.length} clients from LMS API.`);
      return filtered;
    } catch (error) {
      this.logger.error(`❌ Failed to fetch clients from LMS API: ${error.message}`);
      return [];
    }
  }

  private async fetchLeadTotals(reportDate: string): Promise<Record<number, any>> {
    const rows: any[] = await this.dataSource.query(`
      WITH daily_latest AS (
        SELECT 
          client_id, filter_applied, funnel_source, primary_leads, verified_leads, secondary_leads, tertiary_leads,
          ROW_NUMBER() OVER(
            PARTITION BY client_id, filter_applied, funnel_source, (created_at AT TIME ZONE 'Asia/Kolkata')::date
            ORDER BY created_at DESC
          ) as intra_day_rn,
          (created_at AT TIME ZONE 'Asia/Kolkata')::date as scrape_date
        FROM npf_funnel_summary
      ),
      today_latest AS (
        SELECT *
        FROM daily_latest
        WHERE intra_day_rn = 1
          AND scrape_date = $1::date
      ),
      yesterday_latest AS (
        SELECT *
        FROM daily_latest
        WHERE intra_day_rn = 1
          AND scrape_date = ($1::date - INTERVAL '1 day')
      ),
      ranked_filters AS (
        SELECT *,
               ROW_NUMBER() OVER(PARTITION BY client_id, filter_applied, funnel_source ORDER BY scrape_date DESC) as rn
        FROM daily_latest
        WHERE intra_day_rn = 1
      ),
      m0_start AS (
        SELECT DISTINCT ON (client_id, filter_applied, funnel_source) client_id, filter_applied, funnel_source, primary_leads
        FROM npf_funnel_summary
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date >= DATE_TRUNC('month', $1::date)::date
        ORDER BY client_id, filter_applied, funnel_source, created_at ASC
      ),
      m1_start AS (
        SELECT DISTINCT ON (client_id, filter_applied, funnel_source) client_id, filter_applied, funnel_source, primary_leads
        FROM npf_funnel_summary
        WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date >= DATE_TRUNC('month', $1::date - INTERVAL '1 month')::date
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date < DATE_TRUNC('month', $1::date)::date
        ORDER BY client_id, filter_applied, funnel_source, created_at ASC
      )
      SELECT 
        c.client_id,
        NULLIF(REGEXP_REPLACE(trp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_application,
        CASE WHEN trp.primary_leads IS NULL OR yrp.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(trp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yrp.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_application,
        CASE WHEN trn.primary_leads IS NULL OR yrn.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(trn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yrn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_primary_leads,
        NULLIF(REGEXP_REPLACE(trn.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS total_primary_leads,
        NULLIF(REGEXP_REPLACE(trn.verified_leads, '[^0-9.-]', '', 'g'), '')::numeric AS prim_verified_leads,
        NULLIF(REGEXP_REPLACE(trfi.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_form_initiated,
        NULLIF(REGEXP_REPLACE(tren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric AS primary_admission,
        CASE WHEN tren.primary_leads IS NULL OR yren.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(tren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(yren.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS yesterday_admission,
        -- Month-1 Achievement (Start of M0 - Start of M1) e.g. (Apr 1st - Mar 1st)
        CASE WHEN ms0.primary_leads IS NULL OR ms1.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(ms0.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(ms1.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS month_1_adm_achieved,
        CASE WHEN aps0.primary_leads IS NULL OR aps1.primary_leads IS NULL THEN NULL ELSE GREATEST(0, COALESCE(NULLIF(REGEXP_REPLACE(aps0.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) - COALESCE(NULLIF(REGEXP_REPLACE(aps1.primary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS month_1_app_achieved,
        CASE WHEN trn.secondary_leads IS NULL OR trn.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(trn.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(trn.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_lead,
        CASE WHEN trp.secondary_leads IS NULL OR trp.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(trp.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(trp.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_application,
        CASE WHEN tren.secondary_leads IS NULL OR tren.tertiary_leads IS NULL THEN NULL ELSE (COALESCE(NULLIF(REGEXP_REPLACE(tren.secondary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0) + COALESCE(NULLIF(REGEXP_REPLACE(tren.tertiary_leads, '[^0-9.-]', '', 'g'), '')::numeric, 0)) END AS duplicate_admission
      FROM (SELECT DISTINCT client_id FROM npf_funnel_summary) c
      LEFT JOIN yesterday_latest yrn ON yrn.client_id = c.client_id AND yrn.funnel_source = 'lead_view' AND yrn.filter_applied = 'None'
      LEFT JOIN yesterday_latest yrp ON yrp.client_id = c.client_id AND yrp.funnel_source = 'lead_view' AND yrp.filter_applied = 'Paid Apps'
      LEFT JOIN yesterday_latest yren ON yren.client_id = c.client_id AND yren.funnel_source = 'lead_view' AND yren.filter_applied = 'Enrolment Status'
      LEFT JOIN today_latest trn ON trn.client_id = c.client_id AND trn.funnel_source = 'lead_view' AND trn.filter_applied = 'None'
      LEFT JOIN today_latest trp ON trp.client_id = c.client_id AND trp.funnel_source = 'lead_view' AND trp.filter_applied = 'Paid Apps'
      LEFT JOIN today_latest trfi ON trfi.client_id = c.client_id AND trfi.funnel_source = 'lead_view' AND trfi.filter_applied = 'Form Initiated'
      LEFT JOIN today_latest tren ON tren.client_id = c.client_id AND tren.funnel_source = 'lead_view' AND tren.filter_applied = 'Enrolment Status'
      LEFT JOIN m0_start ms0 ON ms0.client_id = c.client_id AND ms0.funnel_source = 'lead_view' AND ms0.filter_applied = 'Enrolment Status'
      LEFT JOIN m1_start ms1 ON ms1.client_id = c.client_id AND ms1.funnel_source = 'lead_view' AND ms1.filter_applied = 'Enrolment Status'
      LEFT JOIN m0_start aps0 ON aps0.client_id = c.client_id AND aps0.funnel_source = 'lead_view' AND aps0.filter_applied = 'Paid Apps'
      LEFT JOIN m1_start aps1 ON aps1.client_id = c.client_id AND aps1.funnel_source = 'lead_view' AND aps1.filter_applied = 'Paid Apps'
    `, [reportDate]);
    const map: Record<number, any> = {};
    rows.forEach((r) => {
      map[Number(r.client_id)] = {
        primary_application: r.primary_application != null ? Number(r.primary_application) : null,
        yesterday_application: r.yesterday_application != null ? Number(r.yesterday_application) : null,
        yesterday_primary_leads: r.yesterday_primary_leads != null ? Number(r.yesterday_primary_leads) : null,
        total_primary_leads: r.total_primary_leads != null ? Number(r.total_primary_leads) : null,
        prim_verified_leads: r.prim_verified_leads != null ? Number(r.prim_verified_leads) : null,
        primary_form_initiated: r.primary_form_initiated != null ? Number(r.primary_form_initiated) : null,
        primary_admission: r.primary_admission != null ? Number(r.primary_admission) : null,
        yesterday_admission: r.yesterday_admission != null ? Number(r.yesterday_admission) : null,
        month_1_adm_achieved: r.month_1_adm_achieved != null ? Number(r.month_1_adm_achieved) : null,
        month_1_app_achieved: r.month_1_app_achieved != null ? Number(r.month_1_app_achieved) : null,
        duplicate_lead: r.duplicate_lead != null ? Number(r.duplicate_lead) : null,
        duplicate_application: r.duplicate_application != null ? Number(r.duplicate_application) : null,
        duplicate_admission: r.duplicate_admission != null ? Number(r.duplicate_admission) : null
      };
    });
    return map;
  }

  private async buildExcel(clients: any[], leads: Record<number, any>, reportDate: Date): Promise<{ buffer: Buffer; rowsData: any[]; columnsData: any[] }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Overall Client Report');

    const now = reportDate;
    // Month-1 (e.g. March)
    const m1Date = new Date();
    m1Date.setDate(1);
    m1Date.setMonth(now.getMonth() - 1);
    const m1Name = m1Date.toLocaleString('default', { month: 'short' });

    const rawColumns = [
      { header: 'S.No', key: 'sno', width: 6 },
      { header: 'No. of Days', key: 'no_of_days', width: 12 },
      { header: 'Client Name', key: 'client_name', width: 35 },
      { header: 'Campaign Status', key: 'campaign_status', width: 12 },
      { header: 'Deal Type', key: 'deal_type', width: 15 },
      { header: 'CRM', key: 'crm', width: 15 },
      { header: 'Target Lead', key: 'target_lead', width: 15 },
      { header: 'Target Application', key: 'target_application', width: 18 },
      { header: 'Target Admission', key: 'target_admission', width: 18 },
      { header: 'Sales TL', key: 'sales_tl', width: 22 },
      { header: 'OPS TL', key: 'ops_tl', width: 22 },
      { header: 'State', key: 'state', width: 20 },
      { header: 'Yesterday Primary Lead', key: 'yesterday_primary_leads', width: 22 },
      { header: 'Primary Form Initiated', key: 'primary_form_initiated', width: 22 },
      { header: 'Prim. Verified Leads', key: 'prim_verified_leads', width: 22 },
      { header: 'Primary Lead', key: 'total_primary_leads', width: 22 },
      { header: `${m1Name} Admission Achieved`, key: 'month_1_adm_achieved', width: 25 },
      { header: 'Yesterday Admission Achieved', key: 'yesterday_admission', width: 25 },
      { header: 'Primary Admission', key: 'primary_admission', width: 20 },
      { header: `${m1Name} Application Achieved`, key: 'month_1_app_achieved', width: 25 },
      { header: 'Yesterday Application Achieved', key: 'yesterday_application', width: 25 },
      { header: 'Primary Application', key: 'primary_application', width: 20 },
      { header: 'Duplicate Lead', key: 'duplicate_lead', width: 20 },
      { header: 'Duplicate Application', key: 'duplicate_application', width: 22 },
      { header: 'Duplicate Admission', key: 'duplicate_admission', width: 22 },
    ];

    ws.columns = rawColumns;

    // Map Excel columns to the Email Template format { key, label }
    const columnsData = rawColumns.map(c => ({ key: c.key, label: c.header }));

    ws.getRow(1).height = 36;
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    // ---------------------------------------------------------------------
    // LOAD HISTORICAL M1 DATA FROM CSV (Specifically for March data)
    // ---------------------------------------------------------------------
    const manualHistoricalData: Record<string, { app: number; adm: number }> = {};

    // Only inject manual March data when the report is generating in April (month index 3)
    // Once May starts, the DB will natively have full snapshots for April!
    if (now.getMonth() === 3) {
      const csvPath = path.join(process.cwd(), 'data', 'Mar-Adm-App.csv');
      if (fs.existsSync(csvPath)) {
        try {
          const fileContent = fs.readFileSync(csvPath, 'utf-8');
          const lines = fileContent.split('\n');

          for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = line.split(',');
            if (parts.length >= 4) {
              const clientName = parts[1].trim(); // Index 1 is Client Name
              const apps = parseInt(parts[2].trim(), 10) || 0;
              const adms = parseInt(parts[3].trim(), 10) || 0;
              manualHistoricalData[clientName] = { app: apps, adm: adms };
            }
          }
          this.logger.log(`📥 Successfully loaded manual March historical data for ${Object.keys(manualHistoricalData).length} clients from CSV.`);
        } catch (e) {
          this.logger.error(`Failed to read data/Mar-Adm-App.csv: ${(e as Error).message}`);
        }
      }
    }

    const rowsData: any[] = [];

    clients.forEach((c, idx) => {
      const m = leads[Number(c.client_id)] || {};
      let days = 0;
      if (this.hasValue(c.on_boarding_date)) {
        const onboard = new Date(String(c.on_boarding_date));
        if (!Number.isNaN(onboard.getTime())) {
          days = Math.ceil((now.getTime() - onboard.getTime()) / (1000 * 60 * 60 * 24));
        }
      }

      // Check for manual overrides from the CSV (if DB calculated null or wasn't tracking yet)
      const historicalM1Apps = manualHistoricalData[c.client_name]?.app ?? m.month_1_app_achieved ?? null;
      const historicalM1Adms = manualHistoricalData[c.client_name]?.adm ?? m.month_1_adm_achieved ?? null;

      const rowData = {
        sno: idx + 1,
        no_of_days: days > 0 ? days : '',
        // Always from LMS (per business rule)
        client_name: this.normalizeLmsValue(c.client_name),
        campaign_status: this.normalizeLmsValue(c.campaign_status ?? c.status),
        deal_type: this.normalizeLmsValue(c.deal_type),
        crm: this.normalizeLmsValue(c.crm),
        target_lead: this.normalizeLmsValue(c.target_lead),
        target_application: this.normalizeLmsValue(c.target_application),
        target_admission: this.normalizeLmsValue(c.target_admission),
        sales_tl: this.normalizeLmsValue(c.sales_tl),
        ops_tl: this.normalizeLmsValue(c.ops_tl),
        state: this.normalizeLmsValue(c.client_state),
        yesterday_primary_leads: m.yesterday_primary_leads ?? '',
        primary_form_initiated: m.primary_form_initiated ?? '',
        prim_verified_leads: m.prim_verified_leads ?? '',
        total_primary_leads: m.total_primary_leads ?? '',
        month_1_adm_achieved: historicalM1Adms ?? '',
        month_1_app_achieved: historicalM1Apps ?? '',
        yesterday_admission: m.yesterday_admission ?? '',
        primary_admission: m.primary_admission ?? '',
        yesterday_application: m.yesterday_application ?? '',
        primary_application: m.primary_application ?? '',
        duplicate_lead: m.duplicate_lead ?? '',
        duplicate_application: m.duplicate_application ?? '',
        duplicate_admission: m.duplicate_admission ?? '',
      };

      ws.addRow(rowData);
      rowsData.push(rowData);
    });

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, rowsData, columnsData };
  }

  private resolveCampaignStatusForReport(
    client: Record<string, unknown>,
  ): string {
    return this.normalizeLmsValue(client['campaign_status'] ?? client['status']);
  }

  private isCampaignStatusActive(status: string): boolean {
    return status.toUpperCase() === 'ACTIVE';
  }

  private normalizeLmsValue(v: unknown): string {
    if (!this.hasValue(v)) return '';
    return String(v).trim();
  }

  private hasValue(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    const s = String(v).trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    return lower !== 'null' && lower !== 'undefined' && lower !== 'na' && lower !== 'n/a' && lower !== '-';
  }

  private getReportDateString(): string {
    const override = (process.env.REPORT_AS_OF_DATE || '').trim();
    if (override) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(override)) {
        this.logger.log(`📅 Using REPORT_AS_OF_DATE override: ${override}`);
        return override;
      }
      this.logger.warn(
        `⚠️ Invalid REPORT_AS_OF_DATE="${override}". Expected YYYY-MM-DD. Falling back to current IST date.`,
      );
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date());
  }

  private getReportDateObject(reportDate: string): Date {
    const [year, month, day] = reportDate.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

}


