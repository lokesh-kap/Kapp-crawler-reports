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
  summaryTable?: {
    title?: string;
    layout?: 'horizontal' | 'vertical';
    position?: 'beforeHeader' | 'afterHeader';
    columns: Array<{ key: string; label: string; align?: 'left' | 'center' | 'right' }>;
    rows: Record<string, any>[];
  };
  mainTableHasTotalRow?: boolean;
  mainTableGroupHeaders?: Array<{
    label: string;
    span: number;
    bgColor?: string;
    textColor?: string;
  }>;
  columns: TemplateColumn[];
  rows: Record<string, any>[];
  footerNote?: string;
}

export function buildEmailTemplate(opts: EmailTemplateOptions): string {
  const estimatedTableMinWidth = Math.max(980, opts.columns.length * 135);

  const cards = (opts.summaryCards ?? [])
    .map(
      (c) => `
      <td style="padding:8px 10px;text-align:center;">
        <div style="border:1px solid rgba(255,122,89,.35);border-left:3px solid #ff7a59;border-radius:8px;background:rgba(255,255,255,.08);padding:8px 10px;">
          <div style="font-size:11px;color:#dbe6f0;margin-bottom:4px;font-weight:600;">${c.label}</div>
          <div style="font-size:20px;font-weight:700;color:${c.color ?? '#ffffff'};">${c.value}</div>
        </div>
      </td>`,
    )
    .join('');

  const thCells = opts.columns
    .map(
      (col) =>
        `<th style="padding:10px 12px;border:1px solid #6f7d8a;white-space:nowrap;text-align:center;">${col.label}</th>`,
    )
    .join('');

  const mainGroupHeaderCells = (opts.mainTableGroupHeaders ?? [])
    .map((g) => {
      const span = Number.isFinite(Number(g.span)) && Number(g.span) > 0 ? Math.floor(Number(g.span)) : 1;
      return `<th colspan="${span}" style="padding:7px 8px;border:1px solid #6f7d8a;white-space:nowrap;text-align:center;background:${g.bgColor ?? '#e5e7eb'};color:${g.textColor ?? '#111827'};font-weight:700;">${g.label}</th>`;
    })
    .join('');

  const summaryThCells = (opts.summaryTable?.columns ?? [])
    .map(
      (col) =>
        `<th style="padding:8px 10px;border:1px solid #6f7d8a;white-space:nowrap;text-align:center;">${col.label}</th>`,
    )
    .join('');

  const summaryRows = (opts.summaryTable?.rows ?? [])
    .map((row, i) => {
      const primaryAppRaw = row['primary_application'];
      const primaryAppNum = Number(
        typeof primaryAppRaw === 'string' ? primaryAppRaw.replace(/,/g, '').trim() : primaryAppRaw,
      );
      const isZeroPrimaryApp = i > 0 && Number.isFinite(primaryAppNum) && primaryAppNum === 0;
      const bg = i === 0 ? '#2f3841' : isZeroPrimaryApp ? '#fde8e8' : i % 2 === 0 ? '#ffffff' : '#faf9f7';
      const textColor = i === 0 ? '#ffffff' : '#111827';
      const fontWeight = i === 0 ? 700 : 500;
      const cells = (opts.summaryTable?.columns ?? [])
        .map((col) => {
          const raw = row[col.key];
          const val = raw === null || raw === undefined || raw === '' ? '—' : raw;
          return `<td style="padding:8px 10px;border:1px solid #e1dbd1;text-align:center;white-space:nowrap;color:${textColor};font-weight:${fontWeight};">${val}</td>`;
        })
        .join('');
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  const summaryVerticalRows = (() => {
    if (!opts.summaryTable || opts.summaryTable.layout !== 'vertical') return '';
    const firstRow = opts.summaryTable.rows?.[0] ?? {};
    return (opts.summaryTable.columns ?? [])
      .map((col, i) => {
        const raw = firstRow[col.key];
        const rawNum = Number(typeof raw === 'string' ? raw.replace(/,/g, '').trim() : raw);
        const isZeroPrimaryApplications =
          (col.key === 'primary_application' || col.key === 'total_applications') &&
          Number.isFinite(rawNum) &&
          rawNum === 0;
        const val = raw === null || raw === undefined || raw === '' ? '—' : raw;
        const bg = isZeroPrimaryApplications ? '#fde8e8' : i % 2 === 0 ? '#ffffff' : '#faf9f7';
        return `<tr style="background:${bg};">
          <td style="padding:9px 12px;border:1px solid #e1dbd1;white-space:nowrap;color:#111827;font-weight:600;text-align:left;">${col.label}</td>
          <td style="padding:9px 12px;border:1px solid #e1dbd1;white-space:nowrap;color:#111827;font-weight:700;text-align:right;">${val}</td>
        </tr>`;
      })
      .join('');
  })();

  const summarySection =
    opts.summaryTable && opts.summaryTable.columns.length > 0
      ? `
    <div style="padding:12px 12px 0;text-align:left;">
      ${opts.summaryTable.title ? `<div style="margin:0 0 8px 2px;color:#4b4438;font-size:12px;font-weight:700;">${opts.summaryTable.title}</div>` : ''}
      <div style="${
        opts.summaryTable.layout === 'vertical'
          ? 'display:inline-block;overflow:hidden;border:1px solid #ddd7cd;border-radius:8px;background:#fff;'
          : 'width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;border:1px solid #ddd7cd;border-radius:8px;background:#fff;'
      }">
        ${
          opts.summaryTable.layout === 'vertical'
            ? `<table style="width:560px;max-width:100%;border-collapse:collapse;font-size:12px;margin:0;">
          <thead>
            <tr style="background:#4c5a67;color:#fff;">
              <th style="padding:8px 10px;border:1px solid #6f7d8a;text-align:left;">Metric</th>
              <th style="padding:8px 10px;border:1px solid #6f7d8a;text-align:right;">Value</th>
            </tr>
          </thead>
          <tbody>${summaryVerticalRows}</tbody>
        </table>`
            : `<table style="width:100%;min-width:980px;border-collapse:collapse;font-size:11px;margin:0;">
          <thead>
            <tr style="background:#4c5a67;color:#fff;">${summaryThCells}</tr>
          </thead>
          <tbody>${summaryRows}</tbody>
        </table>`
        }
      </div>
    </div>`
      : '';

  const tdRows = opts.rows
    .map((row, i) => {
      const isMainTotalRow = Boolean(opts.mainTableHasTotalRow) && i === 0;
      const primaryAppRaw = row['primary_application'];
      const primaryAppNum = Number(
        typeof primaryAppRaw === 'string' ? primaryAppRaw.replace(/,/g, '').trim() : primaryAppRaw,
      );
      const isZeroPrimaryApp = Number.isFinite(primaryAppNum) && primaryAppNum === 0;
      const bg = isMainTotalRow
        ? '#2f3841'
        : isZeroPrimaryApp
          ? '#fde8e8'
          : i % 2 === 0
            ? '#ffffff'
            : '#faf9f7';
      const textColor = isMainTotalRow ? '#ffffff' : '#111827';
      const fontWeight = isMainTotalRow ? 700 : 500;
      const cells = opts.columns
        .map((col) => {
          const raw = row[col.key];
          const val = col.format ? col.format(raw) : (raw ?? '—');
          return `<td style="padding:9px 12px;border:1px solid #e1dbd1;text-align:center;white-space:nowrap;color:${textColor};font-weight:${fontWeight};">${val}</td>`;
        })
        .join('');
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;font-family:Arial,'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f3f2ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f2ef;">
    <tr>
      <td align="center" style="padding:16px 10px;">
  <div style="width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;">
  <div style="min-width:${estimatedTableMinWidth}px;max-width:none;margin:0 auto;background:#fff;border:1px solid #d7d2c8;border-radius:12px;overflow:hidden;">

    ${opts.summaryTable?.position === 'beforeHeader' ? summarySection : ''}

    <!-- Header -->
    <div style="background:#123456;color:white;padding:18px 20px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td><h2 style="margin:0;font-size:22px;font-weight:700;line-height:1.25;">${opts.title}</h2>
            ${opts.subtitle ? `<div style="font-size:13px;opacity:.92;margin-top:6px;line-height:1.4;color:#e3e8ec;">${opts.subtitle}</div>` : ''}
            <div style="font-size:12px;opacity:.9;margin-top:6px;line-height:1.35;color:#e3e8ec;">
              Report date: ${opts.date}
            </div>
            <div style="margin-top:10px;width:68px;height:4px;border-radius:999px;background:#ff7a59;"></div>
          </td>
        </tr>
      </table>

      ${cards ? `
      <table style="width:100%;border-collapse:collapse;text-align:center;margin-top:12px;"><tr>${cards}</tr></table>` : ''}
    </div>

    ${opts.summaryTable?.position !== 'beforeHeader' ? summarySection : ''}

    <!-- Table -->
    <div style="padding:12px 12px 14px;">
      <div style="width:100%;border:1px solid #ddd7cd;border-radius:8px;background:#fff;">
      <table style="width:${estimatedTableMinWidth}px;border-collapse:collapse;font-size:11px;">
          <thead>
            ${mainGroupHeaderCells ? `<tr>${mainGroupHeaderCells}</tr>` : ''}
            <tr style="background:#4c5a67;color:#fff;">${thCells}</tr>
          </thead>
          <tbody>${tdRows}</tbody>
        </table>
      </div>
    </div>

    ${opts.footerNote ? `
    <div style="padding:12px 16px;background:#f5f3ef;border-top:1px solid #ddd7cd;font-size:11px;color:#6a7280;">
      ℹ️ ${opts.footerNote}
    </div>` : ''}
  </div>
  </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
