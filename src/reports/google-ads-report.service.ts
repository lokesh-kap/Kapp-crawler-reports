import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as ExcelJS from 'exceljs';
import axios from 'axios';
import { MailerService } from '../common/mailer/mailer.service';
import { buildEmailTemplate } from '../common/mailer/email-template';

interface ReportRow {
  campaign: string;
  client_name: string;
  account_handled_by: string;
  tracking_id: string;
  google_campaign_id: string;
  date: string;
  ads_start_date: string;
  hidden_open: string;
  course_stream: string;
  budget_inr: number | string;
  impressions: number | string;
  clicks: number | string;
  ctr: number | string;
  avg_cpc: number | string;
  primary_leads: string;
  daily_cost_inr: number | string;
  cpl: string;
  click_to_lead: string;
  panel: string;
  client_non_client: string;
  exam_brand_generic: string;
  account_id: string;
  account_active_suspended: string;
  days_campaign_running: string;
  monthly_cost: number | string;
  month_leads: string;
  monthly_cpl: string;
  month_applications: string;
  monthly_cpa: string;
  total_spend: number | string;
  total_leads: string;
  total_cpl: string;
  total_apps: string;
  total_cpa: string;
  overall_enrolments: string;
  total_cps: string;
  platform: string;
  zone: string;
  team: string;
  cluster: string;
  masked_unmasked: string;
  bid_strategy_type: string;
  client_type: string;
  billing: string;
  landing_page_link: string;
}

type LmsMetadataRow = {
  client_id: number;
  client_name?: string | null;
  trackingId?: string | number | null;
  key?: string | null;
  panel?: string | null;
  crm?: string | null;
  crm_data_status?: string | null;
  account_zone?: string | null;
  performance_parameter?: string | null;
  campaign_names?: unknown;
};

@Injectable()
export class GoogleAdsReportService {
  private readonly logger = new Logger(GoogleAdsReportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mailer: MailerService,
  ) {}

  async generateAndSendReport(): Promise<{ success: boolean; message?: string }> {
    const reportDate = this.getReportDateString();
    const campaignMetricsDate = this.getCampaignMetricsDateString(reportDate);
    const sqlRows = await this.fetchLatestCampaignRows(reportDate, campaignMetricsDate);
    if (sqlRows.length === 0) {
      this.logger.warn(
        'No Google Ads report rows found (enabled/paused campaigns with metrics). Skipping report.',
      );
      return { success: true, message: 'No rows found.' };
    }

    const lmsMeta = await this.fetchLmsClientMetadataMap();
    const mappedSqlRows = sqlRows.filter((r) => r.client_id != null);
    if (mappedSqlRows.length === 0) {
      this.logger.warn(
        'No mapped Google Ads report rows found (campaigns without active ads_mapping were excluded).',
      );
      return { success: true, message: 'No mapped rows found.' };
    }
    const reportRows: ReportRow[] = mappedSqlRows
      .map((r) => this.mapSqlToReportRow(r, lmsMeta))
      .sort((a, b) => Number(b.daily_cost_inr || 0) - Number(a.daily_cost_inr || 0));
    const reportRowsWithTotal = this.buildRowsWithTotal(reportRows);

    const latestDate = reportRows.reduce((acc, x) => (x.date > acc ? x.date : acc), '');
    const effectiveMetricsDate = latestDate || campaignMetricsDate;
    const { buffer, columnsData, rowsData } = await this.buildExcel(reportRowsWithTotal, effectiveMetricsDate);
    const emailCols = columnsData;
    const emailRows = rowsData.map((row) => {
      const slim: Record<string, unknown> = {};
      for (const c of emailCols) {
        slim[c.key] = row[c.key as keyof ReportRow];
      }
      return slim;
    });

    const toList = this.parseEmailList(process.env.REPORT_GOOGLE_ADS_TO);
    const ccList = this.parseEmailList(process.env.REPORT_GOOGLE_ADS_CC);
    if (toList.length === 0) {
      this.logger.warn('Skipping Google Ads report email: REPORT_GOOGLE_ADS_TO is empty.');
      return { success: true, message: 'Skipped — no recipients.' };
    }

    const html = buildEmailTemplate({
      title: 'Google Ads Report',
      subtitle: `Daily campaign performance snapshot | Metric Date: ${effectiveMetricsDate} | Rows: ${reportRows.length}`,
      date: reportDate,
      summaryCards: [],
      mainTableHasTotalRow: true,
      mainTableGroupHeaders: [
        { label: 'Campaign Details', span: 6, bgColor: '#e5e7eb', textColor: '#111827' },
        { label: 'Daily Matrix', span: 3, bgColor: '#fde68a', textColor: '#111827' },
        { label: 'Montly Matrix', span: 5, bgColor: '#c7d2fe', textColor: '#111827' },
        { label: 'Overall Matrix', span: 7, bgColor: '#f9a8d4', textColor: '#111827' },
        { label: 'Other Meta Details', span: 15, bgColor: '#d1fae5', textColor: '#111827' },
      ],
      columns: emailCols,
      rows: emailRows as Record<string, any>[],
      footerNote:
        'Lead/application attribution is computed live during report generation from lead data + ads mapping. No separate attribution sync is required.',
    });

    await this.mailer.sendMail({
      to: toList,
      cc: ccList.length ? ccList : undefined,
      subject: `Google Ads Report — ${reportDate} (metrics: ${effectiveMetricsDate})`,
      html,
      // attachments: [
      //   {
      //     filename: `Google_Ads_Report_${reportDate}.xlsx`,
      //     content: buffer,
      //   },
      // ],
    });

    return { success: true };
  }

  private parseEmailList(raw: string | undefined): string[] {
    return (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * One row per campaign: latest available campaign_metrics date.
   * Leads/apps/enrolments are mapped from client_wise_summary_data and converted
   * from cumulative snapshots to daily deltas using:
   * current(metric_date) - previous_available(metric_date).
   */
  private async fetchLatestCampaignRows(reportDate: string, campaignMetricsDate: string): Promise<any[]> {
    return this.dataSource.query(
      `
      WITH latest_day AS (
        SELECT MAX(cm.date)::date AS latest_date
        FROM campaign_metrics cm
        INNER JOIN campaign_info ci
          ON ci.id = cm."campaignInfoId"
         AND ci.provider = 'google'
         AND ci.status IN ('ENABLED', 'PAUSED')
      ),
      report_day AS (
        SELECT
          $1::date AS report_date,
          $2::date AS campaign_metrics_date,
          CASE
            WHEN EXTRACT(DAY FROM $1::date) = 1 THEN ($1::date - INTERVAL '1 day')::date
            ELSE $1::date
          END AS monthly_anchor_date
      ),
      summary_cumulative AS (
        SELECT
          am."campaignInfoId",
          (s.created_at AT TIME ZONE 'Asia/Kolkata')::date AS metric_date,
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
          )::numeric AS applications,
          SUM(
            CASE
              WHEN s.enrolments ~ '^[0-9]+(\\.[0-9]+)?$' THEN s.enrolments::numeric
              ELSE 0
            END
          )::numeric AS enrolments
        FROM client_wise_summary_data s
        INNER JOIN ads_mapping am
          ON am."clientId" = s.client_id
         AND am."isActive" = true
         AND am."campaignInfoId" IS NOT NULL
         AND lower(trim(COALESCE(s.medium, ''))) = lower(trim(am."mediumCode"))
         AND lower(trim(COALESCE(s.filter_applied, 'none'))) = 'none'
        GROUP BY am."campaignInfoId", (s.created_at AT TIME ZONE 'Asia/Kolkata')::date
      ),
      mapping_client AS (
        SELECT
          "campaignInfoId",
          MIN("clientId")::int AS client_id
        FROM ads_mapping
        WHERE "isActive" = true
          AND "campaignInfoId" IS NOT NULL
        GROUP BY "campaignInfoId"
      ),
      summary_points AS (
        SELECT
          mc."campaignInfoId",
          CASE
            WHEN curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(curr.leads, 0) - COALESCE(prev_day.leads, 0))::bigint
          END AS daily_leads,
          CASE
            WHEN curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(curr.applications, 0) - COALESCE(prev_day.applications, 0))::bigint
          END AS daily_apps,
          CASE
            WHEN curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(curr.enrolments, 0) - COALESCE(prev_day.enrolments, 0))::numeric
          END AS daily_enrolments,
          CASE
            WHEN monthly_curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(monthly_curr.leads, 0) - COALESCE(prev_month.leads, 0))::bigint
          END AS monthly_leads,
          CASE
            WHEN monthly_curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(monthly_curr.applications, 0) - COALESCE(prev_month.applications, 0))::bigint
          END AS monthly_apps,
          CASE
            WHEN monthly_curr.metric_date IS NULL THEN NULL
            ELSE GREATEST(0, COALESCE(monthly_curr.enrolments, 0) - COALESCE(prev_month.enrolments, 0))::numeric
          END AS monthly_enrolments,
          CASE WHEN curr.metric_date IS NULL THEN NULL ELSE COALESCE(curr.leads, 0)::bigint END AS total_leads,
          CASE WHEN curr.metric_date IS NULL THEN NULL ELSE COALESCE(curr.applications, 0)::bigint END AS total_apps,
          CASE WHEN curr.metric_date IS NULL THEN NULL ELSE COALESCE(curr.enrolments, 0)::numeric END AS total_enrolments
        FROM mapping_client mc
        CROSS JOIN report_day rd
        LEFT JOIN summary_cumulative curr
          ON curr."campaignInfoId" = mc."campaignInfoId"
         AND curr.metric_date = rd.report_date
        LEFT JOIN LATERAL (
          SELECT sc.metric_date, sc.leads, sc.applications, sc.enrolments
          FROM summary_cumulative sc
          WHERE sc."campaignInfoId" = mc."campaignInfoId"
            AND sc.metric_date <= rd.monthly_anchor_date
          ORDER BY sc.metric_date DESC
          LIMIT 1
        ) monthly_curr ON true
        LEFT JOIN LATERAL (
          SELECT sc.leads, sc.applications, sc.enrolments
          FROM summary_cumulative sc
          WHERE sc."campaignInfoId" = mc."campaignInfoId"
            AND sc.metric_date < rd.report_date
          ORDER BY sc.metric_date DESC
          LIMIT 1
        ) prev_day ON true
        LEFT JOIN LATERAL (
          SELECT sc.leads, sc.applications, sc.enrolments
          FROM summary_cumulative sc
          WHERE sc."campaignInfoId" = mc."campaignInfoId"
            AND sc.metric_date < date_trunc('month', rd.monthly_anchor_date)::date
          ORDER BY sc.metric_date DESC
          LIMIT 1
        ) prev_month ON true
      ),
      base AS (
        SELECT
          cm.date::text AS metric_date,
          rd.campaign_metrics_date::date AS report_latest_date,
          rd.report_date::date AS report_summary_date,
          rd.monthly_anchor_date::date AS monthly_anchor_date,
          cm.impressions::bigint AS impressions,
          cm.clicks::bigint AS clicks,
          cm.ctr::double precision AS ctr,
          cm."avgCpc"::double precision AS avg_cpc,
          cm.spend::double precision AS spend,
          ci.id AS campaign_info_id,
          ci."externalCampaignId"::text AS external_campaign_id,
          ci.name AS campaign_name,
          ci."campaignStartDate"::text AS campaign_start_date,
          COALESCE(ci."dailyBudget", 0)::double precision AS daily_budget,
          ci."biddingStrategy"::text AS bidding_strategy,
          ci.provider::text AS platform,
          aa."externalCustomerId" AS account_id,
          aa.status::text AS account_status,
          mc.client_id,
          sp.daily_leads::bigint AS leads,
          sp.daily_apps::bigint AS applications,
          sp.daily_enrolments::numeric AS enrolments,
          sp.monthly_leads::bigint AS monthly_leads,
          sp.monthly_apps::bigint AS monthly_apps,
          sp.monthly_enrolments::numeric AS monthly_enrolments,
          sp.total_leads::bigint AS total_leads,
          sp.total_apps::bigint AS total_apps,
          sp.total_enrolments::numeric AS total_enrolments
        FROM campaign_metrics cm
        CROSS JOIN latest_day ld
        CROSS JOIN report_day rd
        INNER JOIN campaign_info ci
          ON ci.id = cm."campaignInfoId"
         AND ci.provider = 'google'
         AND ci.status IN ('ENABLED', 'PAUSED')
        INNER JOIN ads_accounts aa ON aa.id = ci."adsAccountId" AND aa.provider = 'google'
        LEFT JOIN mapping_client mc ON mc."campaignInfoId" = ci.id
        LEFT JOIN summary_points sp ON sp."campaignInfoId" = ci.id
        WHERE ld.latest_date IS NOT NULL
          AND cm.date <= rd.campaign_metrics_date
      ),
      w AS (
        SELECT
          b.*,
          SUM(
            CASE
              WHEN b.metric_date::date >= date_trunc('month', b.monthly_anchor_date)::date
              THEN b.spend
              ELSE 0
            END
          )
            OVER (PARTITION BY b.campaign_info_id)::double precision AS monthly_cost,
          SUM(
            CASE
              WHEN b.metric_date::date <= b.report_summary_date
              THEN b.spend
              ELSE 0
            END
          )
            OVER (PARTITION BY b.campaign_info_id)::double precision AS total_spend
        FROM base b
      )
      SELECT * FROM w
      WHERE metric_date::date = report_latest_date
      ORDER BY campaign_info_id, metric_date
      `,
      [reportDate, campaignMetricsDate]
    );
  }

  private mapSqlToReportRow(
    r: any,
    lmsMetaMap: Map<number, LmsMetadataRow>,
  ): ReportRow {
    const parseNullableNumber = (value: unknown): number | null => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const hasAdsMapping = r.client_id != null;
    const clientId = Number(r.client_id);
    const lms = Number.isFinite(clientId) ? lmsMetaMap.get(clientId) : undefined;
    const dailyLeads = parseNullableNumber(r.leads);
    const monthlyLeads = parseNullableNumber(r.monthly_leads);
    const monthlyApps = parseNullableNumber(r.monthly_apps);
    const totalLeads = parseNullableNumber(r.total_leads);
    const totalApps = parseNullableNumber(r.total_apps);
    const dailyCost = r.spend != null ? Number(r.spend) : null;
    const monthlyCost = r.monthly_cost != null ? Number(r.monthly_cost) : null;
    const totalSpend = r.total_spend != null ? Number(r.total_spend) : null;
    const totalEnrolments = parseNullableNumber(r.total_enrolments);
    const dailyCpl =
      dailyCost != null && dailyLeads != null && dailyLeads > 0 ? dailyCost / dailyLeads : null;
    const monthlyCpl =
      monthlyCost != null && monthlyLeads != null && monthlyLeads > 0 ? monthlyCost / monthlyLeads : null;
    const monthlyCpa =
      monthlyCost != null && monthlyApps != null && monthlyApps > 0 ? monthlyCost / monthlyApps : null;
    const totalCpa =
      totalSpend != null && totalApps != null && totalApps > 0 ? totalSpend / totalApps : null;
    const totalCps =
      totalSpend != null && totalEnrolments != null && totalEnrolments > 0
        ? totalSpend / totalEnrolments
        : null;
    const totalCpl =
      totalSpend != null && totalLeads != null && totalLeads > 0 ? totalSpend / totalLeads : null;
    const clickToLead =
      Number(r.clicks ?? 0) > 0 && dailyLeads != null ? (dailyLeads / Number(r.clicks ?? 0)) * 100 : null;
    const daysRunning = this.daysFromStartDate(r.campaign_start_date);

    const biddingLabel = this.formatBiddingStrategy(r.bidding_strategy);
    const accountLabel = this.formatAccountStatus(r.account_status);
    const courseStream = this.stringifyCampaignNames(lms?.campaign_names);
    const panel = String(lms?.panel ?? lms?.crm ?? '').trim();
    const zone = String(lms?.account_zone ?? '').trim();
    const trackingId = this.extractTrackingId(lms?.key, r.campaign_name, lms?.trackingId);
    const clientName = String(lms?.client_name ?? '').trim();
    const accountHandledBy = this.extractAccountHandledBy(lms?.key, r.campaign_name);
    const masked = String(lms?.crm_data_status ?? '').trim();
    const billing = String(lms?.performance_parameter ?? '').trim();

    return {
      campaign: String(r.campaign_name ?? ''),
      client_name: clientName,
      account_handled_by: accountHandledBy,
      tracking_id: trackingId,
      google_campaign_id: String(r.external_campaign_id ?? ''),
      date: String(r.metric_date ?? ''),
      ads_start_date: String(r.campaign_start_date ?? ''),
      hidden_open: '',
      course_stream: courseStream,
      budget_inr: r.daily_budget != null ? Number(Number(r.daily_budget).toFixed(2)) : '',
      impressions: r.impressions != null ? Number(r.impressions) : '',
      clicks: r.clicks != null ? Number(r.clicks) : '',
      ctr: r.ctr != null ? Number(Number(r.ctr).toFixed(2)) : '',
      avg_cpc: r.avg_cpc != null ? Number(Number(r.avg_cpc).toFixed(2)) : '',
      primary_leads: hasAdsMapping && dailyLeads != null ? String(dailyLeads) : '',
      daily_cost_inr: r.spend != null ? Number(Number(r.spend).toFixed(2)) : '',
      cpl: dailyCpl != null ? dailyCpl.toFixed(2) : '',
      click_to_lead: clickToLead != null ? clickToLead.toFixed(2) : '',
      panel,
      client_non_client: '',
      exam_brand_generic: 'Brand',
      account_id: String(r.account_id ?? ''),
      account_active_suspended: accountLabel,
      days_campaign_running: daysRunning,
      monthly_cost: r.monthly_cost != null ? Number(Number(r.monthly_cost).toFixed(2)) : '',
      month_leads: hasAdsMapping && monthlyLeads != null ? String(monthlyLeads) : '',
      monthly_cpl: hasAdsMapping && monthlyCpl != null ? monthlyCpl.toFixed(2) : '',
      month_applications: hasAdsMapping && monthlyApps != null ? String(monthlyApps) : '',
      monthly_cpa: hasAdsMapping && monthlyCpa != null ? monthlyCpa.toFixed(2) : '',
      total_spend: r.total_spend != null ? Number(Number(r.total_spend).toFixed(2)) : '',
      total_leads: hasAdsMapping && totalLeads != null ? String(totalLeads) : '',
      total_cpl: hasAdsMapping && totalCpl != null ? totalCpl.toFixed(2) : '',
      total_apps: hasAdsMapping && totalApps != null ? String(totalApps) : '',
      total_cpa: hasAdsMapping && totalCpa != null ? totalCpa.toFixed(2) : '',
      overall_enrolments: hasAdsMapping && totalEnrolments != null ? String(totalEnrolments) : '',
      total_cps: hasAdsMapping && totalCps != null ? totalCps.toFixed(2) : '',
      platform: 'Adword',
      zone,
      team: '',
      cluster: '',
      masked_unmasked: masked,
      bid_strategy_type: biddingLabel,
      client_type: 'Client',
      billing,
      landing_page_link: '',
    };
  }

  private daysFromStartDate(raw: string | undefined): string {
    if (!raw || !String(raw).trim()) return '';
    const d = new Date(String(raw));
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const days = Math.ceil((now.getTime() - d.getTime()) / (86400 * 1000));
    return days > 0 ? String(days) : '0';
  }

  private stringifyCampaignNames(campaignNames: unknown): string {
    if (campaignNames == null) return '';
    if (Array.isArray(campaignNames)) {
      return campaignNames
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .join(' | ');
    }
    if (typeof campaignNames === 'string') {
      const s = campaignNames.trim();
      if (!s) return '';
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          return parsed
            .map((x) => String(x ?? '').trim())
            .filter(Boolean)
            .join(' | ');
        }
      } catch {
        // non-json string
      }
      return s;
    }
    return String(campaignNames);
  }

  private async fetchLmsClientMetadataMap(): Promise<Map<number, LmsMetadataRow>> {
    const out = new Map<number, LmsMetadataRow>();
    const backendUrl = (process.env.LMS_BACKEND_URL || 'http://127.0.0.1:9001').replace(
      /\/+$/,
      '',
    );
    const apiKey = process.env.REPORTING_METADATA_API_SECRET_KEY || 'kapp-crawler-reports';
    try {
      const response = await axios.get(`${backendUrl}/clients/reporting-metadata`, {
        headers: {
          'x-api-key': apiKey,
        },
      });
      const rows = (response.data?.data ?? []) as LmsMetadataRow[];
      for (const row of rows) {
        const clientId = Number((row as any).client_id);
        if (!Number.isFinite(clientId)) continue;
        out.set(clientId, row);
      }
      this.logger.log(`Google Ads report: LMS metadata loaded for ${out.size} client(s).`);
    } catch (err: any) {
      this.logger.warn(`Google Ads report: failed to fetch LMS metadata (${err?.message ?? err}).`);
    }
    return out;
  }

  private formatAccountStatus(status: string | undefined): string {
    const s = (status ?? '').toUpperCase();
    if (s === 'ENABLED') return 'Active';
    if (s === 'PAUSED' || s === 'DEACTIVATED' || s === 'REVOKED') return 'Suspended';
    return status ?? '';
  }

  private formatBiddingStrategy(raw: string | undefined): string {
    if (!raw) return '';
    return String(raw)
      .split('_')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }

  private splitCompositeParts(rawValue: unknown): string[] {
    const raw = String(rawValue ?? '').trim();
    if (!raw || raw.toLowerCase() === 'null' || raw.toLowerCase() === 'undefined') return [];
    // Support both "a || b || c" and "a | b | c".
    const parts = raw
      .split(/\|{1,2}/)
      .map((x) => x.trim())
      .filter(Boolean);
    return parts;
  }

  private extractAccountHandledBy(primaryKeyValue: unknown, campaignText: unknown): string {
    const keyParts = this.splitCompositeParts(primaryKeyValue);
    if (keyParts.length >= 7) return keyParts[keyParts.length - 1] ?? '';
    const campaignParts = this.splitCompositeParts(campaignText);
    if (campaignParts.length >= 7) return campaignParts[campaignParts.length - 1] ?? '';
    return '';
  }

  private extractTrackingId(
    primaryKeyValue: unknown,
    campaignText: unknown,
    fallbackTrackingId: unknown,
  ): string {
    const keyParts = this.splitCompositeParts(primaryKeyValue);
    if (keyParts.length >= 5) {
      const fromKey = String(keyParts[4] ?? '').trim();
      if (fromKey) return fromKey;
    }

    const campaignParts = this.splitCompositeParts(campaignText);
    if (campaignParts.length >= 5) {
      const fromCampaign = String(campaignParts[4] ?? '').trim();
      if (fromCampaign) return fromCampaign;
    }

    const fallback = String(fallbackTrackingId ?? '').trim();
    if (!fallback || fallback.toLowerCase() === 'null' || fallback.toLowerCase() === 'undefined') {
      return '';
    }
    return fallback;
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

  private getCampaignMetricsDateString(reportDate: string): string {
    const override = (process.env.REPORT_GOOGLE_ADS_METRICS_DATE || '').trim();
    if (override) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(override)) {
        this.logger.log(`📅 Using REPORT_GOOGLE_ADS_METRICS_DATE override: ${override}`);
        return override;
      }
      this.logger.warn(
        `⚠️ Invalid REPORT_GOOGLE_ADS_METRICS_DATE="${override}". Expected YYYY-MM-DD. Falling back to report date - 1 day.`,
      );
    }

    const [year, month, day] = reportDate.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() - 1);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  private buildRowsWithTotal(rows: ReportRow[]): ReportRow[] {
    const toNum = (v: unknown): number => {
      if (v === null || v === undefined || v === '') return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const totals = {
      leads: rows.reduce((acc, row) => acc + toNum(row.primary_leads), 0),
      dailyCost: rows.reduce((acc, row) => acc + toNum(row.daily_cost_inr), 0),
      monthlyCost: rows.reduce((acc, row) => acc + toNum(row.monthly_cost), 0),
      monthLeads: rows.reduce((acc, row) => acc + toNum(row.month_leads), 0),
      monthApps: rows.reduce((acc, row) => acc + toNum(row.month_applications), 0),
      totalSpend: rows.reduce((acc, row) => acc + toNum(row.total_spend), 0),
      totalLeads: rows.reduce((acc, row) => acc + toNum(row.total_leads), 0),
      totalApps: rows.reduce((acc, row) => acc + toNum(row.total_apps), 0),
      totalEnrolments: rows.reduce((acc, row) => acc + toNum(row.overall_enrolments), 0),
    };

    const cpl = totals.leads > 0 ? totals.dailyCost / totals.leads : null;
    const monthlyCpl = totals.monthLeads > 0 ? totals.monthlyCost / totals.monthLeads : null;
    const monthlyCpa = totals.monthApps > 0 ? totals.monthlyCost / totals.monthApps : null;
    const totalCpl = totals.totalLeads > 0 ? totals.totalSpend / totals.totalLeads : null;
    const totalCpa = totals.totalApps > 0 ? totals.totalSpend / totals.totalApps : null;
    const totalCps =
      totals.totalEnrolments > 0 ? totals.totalSpend / totals.totalEnrolments : null;

    const totalRow: ReportRow = {
      campaign: 'Total',
      client_name: '',
      account_handled_by: '',
      tracking_id: '',
      google_campaign_id: '',
      date: '',
      ads_start_date: '',
      hidden_open: '',
      course_stream: '',
      budget_inr: '',
      impressions: '',
      clicks: '',
      ctr: '',
      avg_cpc: '',
      primary_leads: String(totals.leads),
      daily_cost_inr: Number(totals.dailyCost.toFixed(2)),
      cpl: cpl != null ? cpl.toFixed(2) : '',
      click_to_lead: '',
      panel: '',
      client_non_client: '',
      exam_brand_generic: '',
      account_id: '',
      account_active_suspended: '',
      days_campaign_running: '',
      monthly_cost: Number(totals.monthlyCost.toFixed(2)),
      month_leads: String(totals.monthLeads),
      monthly_cpl: monthlyCpl != null ? monthlyCpl.toFixed(2) : '',
      month_applications: String(totals.monthApps),
      monthly_cpa: monthlyCpa != null ? monthlyCpa.toFixed(2) : '',
      total_spend: Number(totals.totalSpend.toFixed(2)),
      total_leads: String(totals.totalLeads),
      total_cpl: totalCpl != null ? totalCpl.toFixed(2) : '',
      total_apps: String(totals.totalApps),
      total_cpa: totalCpa != null ? totalCpa.toFixed(2) : '',
      overall_enrolments: String(totals.totalEnrolments),
      total_cps: totalCps != null ? totalCps.toFixed(2) : '',
      platform: '',
      zone: '',
      team: '',
      cluster: '',
      masked_unmasked: '',
      bid_strategy_type: '',
      client_type: '',
      billing: '',
      landing_page_link: '',
    };

    return [totalRow, ...rows];
  }

  private async buildExcel(
    rows: ReportRow[],
    metricsDateIst: string,
  ): Promise<{ buffer: Buffer; columnsData: { key: string; label: string }[]; rowsData: ReportRow[] }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Google Ads Report', {
      views: [{ state: 'frozen', ySplit: 3, xSplit: 0 }],
    });

    const rawColumns: { header: string; key: keyof ReportRow; width: number }[] = [
      { header: 'Platform', key: 'platform', width: 12 },
      { header: 'Zone', key: 'zone', width: 14 },
      { header: 'Tracking Id', key: 'tracking_id', width: 14 },
      { header: 'Campaign', key: 'campaign', width: 36 },
      { header: 'Client Name', key: 'client_name', width: 26 },
      { header: 'Account Handled By', key: 'account_handled_by', width: 22 },
      { header: 'Primary Leads', key: 'primary_leads', width: 14 },
      { header: 'Daily Cost (₹)', key: 'daily_cost_inr', width: 14 },
      { header: 'CPL', key: 'cpl', width: 10 },
      { header: 'Monthly Cost', key: 'monthly_cost', width: 14 },
      { header: 'Monthly leads', key: 'month_leads', width: 12 },
      { header: 'Monthly CPL', key: 'monthly_cpl', width: 12 },
      { header: 'Month Applications', key: 'month_applications', width: 18 },
      { header: 'Monthly CPA', key: 'monthly_cpa', width: 12 },
      { header: 'Total Spend', key: 'total_spend', width: 14 },
      { header: 'Total Leads', key: 'total_leads', width: 12 },
      { header: 'Total CPL', key: 'total_cpl', width: 12 },
      { header: 'Total Applications', key: 'total_apps', width: 18 },
      { header: 'Total CPA', key: 'total_cpa', width: 12 },
      { header: 'Total CPS', key: 'total_cps', width: 12 },
      { header: 'Overall Enrolments', key: 'overall_enrolments', width: 30 },
      { header: 'Ads Start Date', key: 'ads_start_date', width: 14 },
      { header: 'Budget (INR)', key: 'budget_inr', width: 14 },
      { header: 'Impressions', key: 'impressions', width: 14 },
      { header: 'Clicks', key: 'clicks', width: 10 },
      { header: 'CTR (%)', key: 'ctr', width: 10 },
      { header: 'Avg. CPC', key: 'avg_cpc', width: 12 },
      { header: 'Panel', key: 'panel', width: 12 },
      { header: 'Exam/Brand/Generic', key: 'exam_brand_generic', width: 18 },
      { header: 'Account Id', key: 'account_id', width: 14 },
      { header: 'Account Active / Suspended', key: 'account_active_suspended', width: 22 },
      { header: 'No.of Days Campaign Running', key: 'days_campaign_running', width: 22 },
      { header: 'Masked/Unmasked', key: 'masked_unmasked', width: 16 },
      { header: 'Bid strategy type', key: 'bid_strategy_type', width: 18 },
      { header: 'Client Type', key: 'client_type', width: 14 },
      { header: 'Billing', key: 'billing', width: 12 }
    ];

    ws.columns = rawColumns.map((c) => ({ key: c.key as string, width: c.width }));
    const columnsData = rawColumns.map((c) => ({ key: c.key as string, label: c.header }));

    ws.insertRow(1, [`Latest metrics date in this report: ${metricsDateIst || 'N/A'}`]);
    ws.mergeCells(1, 1, 1, rawColumns.length);
    ws.getRow(1).font = { italic: true, size: 11 };

    const groupHeaderRowNumber = 2;
    const groupHeaderRow = ws.getRow(groupHeaderRowNumber);
    groupHeaderRow.height = 22;

    const mergeHeaderGroup = (
      fromCol: number,
      toCol: number,
      label: string,
      fillArgb: string,
      textArgb = 'FF111827',
    ) => {
      ws.mergeCells(groupHeaderRowNumber, fromCol, groupHeaderRowNumber, toCol);
      const cell = groupHeaderRow.getCell(fromCol);
      cell.value = label;
      cell.font = { bold: true, color: { argb: textArgb }, size: 10 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF6B7280' } },
        bottom: { style: 'thin', color: { argb: 'FF6B7280' } },
        left: { style: 'thin', color: { argb: 'FF6B7280' } },
        right: { style: 'thin', color: { argb: 'FF6B7280' } },
      };
    };

    mergeHeaderGroup(1, 6, 'Campaign Details', 'FFE5E7EB');
    mergeHeaderGroup(7, 9, 'Daily Matrix', 'FFFDE68A');
    mergeHeaderGroup(10, 14, 'Montly Matrix', 'FFC7D2FE');
    mergeHeaderGroup(15, 21, 'Overall Matrix', 'FFF9A8D4');
    mergeHeaderGroup(22, rawColumns.length, 'Other Meta Details', 'FFD1FAE5');

    const headerRowNumber = 3;
    const headerRow = ws.getRow(headerRowNumber);
    headerRow.height = 36;
    rawColumns.forEach((colDef, idx) => {
      const cell = headerRow.getCell(idx + 1);
      cell.value = colDef.header;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    const dataStart = 4;
    rows.forEach((row, idx) => {
      const r = ws.getRow(dataStart + idx);
      rawColumns.forEach((col, cIdx) => {
        const cell = r.getCell(cIdx + 1);
        const v = row[col.key];
        cell.value = v === '' ? undefined : (v as ExcelJS.CellValue);
        if (col.key === 'ctr' && typeof v === 'number' && !Number.isNaN(v)) {
          // Keep as plain number; upstream may already provide percent-like value.
          cell.numFmt = '0.00';
        }
      });
    });

    const buffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
    return { buffer, columnsData, rowsData: rows };
  }

}
