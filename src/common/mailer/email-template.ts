/**
 * Dynamic Email Template Builder
 * Supports any tabular report with configurable columns and summary cards.
 */

export interface TemplateColumn {
  key: string;
  label: string;
  align?: 'left' | 'center' | 'right';
  format?: (val: any) => string;
}

export interface TemplateSummaryCard {
  label: string;
  value: string | number;
  color?: string; // hex e.g. '#4ade80'
}

export interface EmailTemplateOptions {
  title: string;
  subtitle?: string;
  date: string;
  summaryCards?: TemplateSummaryCard[];
  columns: TemplateColumn[];
  rows: Record<string, any>[];
  footerNote?: string;
}

export function buildEmailTemplate(opts: EmailTemplateOptions): string {
  const cards = (opts.summaryCards ?? [])
    .map(
      (c) => `
      <td style="padding:0 16px;text-align:center;">
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${c.label}</div>
        <div style="font-size:20px;font-weight:700;color:${c.color ?? '#f8fafc'};">${c.value}</div>
      </td>`,
    )
    .join('');

  const thCells = opts.columns
    .map(
      (col) =>
        `<th style="padding:10px 12px;border:1px solid #334155;white-space:nowrap;text-align:${col.align ?? 'left'};">${col.label}</th>`,
    )
    .join('');

  const tdRows = opts.rows
    .map((row, i) => {
      const bg = i % 2 === 0 ? '#ffffff' : '#f0f9ff';
      const cells = opts.columns
        .map((col) => {
          const raw = row[col.key];
          const val = col.format ? col.format(raw) : (raw ?? '—');
          return `<td style="padding:9px 12px;border:1px solid #e2e8f0;text-align:${col.align ?? 'left'};">${val}</td>`;
        })
        .join('');
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:20px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f1f5f9;">
  <div style="max-width:1300px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:#1e3a8a;color:white;padding:24px 28px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td><h2 style="margin:0;font-size:22px;font-weight:600;">${opts.title}</h2>
            ${opts.subtitle ? `<div style="font-size:13px;opacity:.75;margin-top:4px;">${opts.subtitle}</div>` : ''}
          </td>
          <td style="text-align:right;vertical-align:top;white-space:nowrap;">
            <span style="font-size:12px;background:rgba(255,255,255,.15);padding:5px 12px;border-radius:20px;">
              📅 ${opts.date}
            </span>
          </td>
        </tr>
      </table>
    </div>

    ${cards ? `
    <!-- Summary cards -->
    <div style="background:#0f172a;padding:20px;">
      <table style="width:100%;border-collapse:collapse;text-align:center;"><tr>${cards}</tr></table>
    </div>` : ''}

    <!-- Table -->
    <div style="overflow-x:auto;padding:20px;">
      <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:900px;">
        <thead>
          <tr style="background:#0f172a;color:#fff;">${thCells}</tr>
        </thead>
        <tbody>${tdRows}</tbody>
      </table>
    </div>

    ${opts.footerNote ? `
    <div style="padding:12px 20px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;">
      ℹ️ ${opts.footerNote}
    </div>` : ''}
  </div>
</body>
</html>`;
}
