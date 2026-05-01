export interface ClassicEmailTemplateInput {
  title: string;
  greeting?: string;
  intro?: string;
  highlights?: string[];
  closingText?: string;
  signature?: string;
}

export const classicEmailTemplate = ({
  title,
  greeting = 'Hello,',
  intro = 'Please find your requested report update below.',
  highlights = [],
  closingText = 'Let us know if you need any additional details.',
  signature = 'Kapp Crawler Reports Team',
}: ClassicEmailTemplateInput): string => {
  const generatedAt = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
  });

  const highlightsHtml =
    highlights.length > 0
      ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dbd5cb;border-left:4px solid #8a9aa8;border-radius:8px;background:#f7f5f1;margin:0 0 16px 0;">
          <tr>
            <td style="padding:12px 12px;">
              <p style="margin:0 0 10px;color:#4b4438;font-family:Arial,'Segoe UI',sans-serif;font-size:16px;font-weight:700;">Highlights</p>
              <ul style="margin:0;padding-left:18px;color:#5b5245;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;line-height:20px;">
                ${highlights.map((item) => `<li>${item}</li>`).join('')}
              </ul>
            </td>
          </tr>
        </table>
      `
      : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f3f2ef;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f2ef;">
    <tr>
      <td align="center" style="padding:16px 10px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border:1px solid #d7d2c8;border-radius:12px;overflow:hidden;background:#ffffff;">
          <tr>
            <td style="padding:18px 20px;background:#4c5a67;">
              <div style="font-family:Arial,'Segoe UI',sans-serif;font-size:22px;line-height:28px;font-weight:700;color:#ffffff;">${title}</div>
              <div style="margin-top:6px;font-family:Arial,'Segoe UI',sans-serif;font-size:13px;line-height:18px;color:#e3e8ec;">Generated: ${generatedAt} (IST)</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 16px 10px 16px;color:#4b4438;">
              <p style="margin:0 0 12px;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;line-height:20px;color:#4b4438;">${greeting}</p>
              <p style="margin:0 0 12px;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;line-height:20px;color:#4b4438;">${intro}</p>
              ${highlightsHtml}
              <p style="margin:0 0 12px;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;line-height:20px;color:#4b4438;">${closingText}</p>
              <p style="margin:0;font-family:Arial,'Segoe UI',sans-serif;font-size:14px;line-height:20px;color:#4b4438;">
                Regards,<br />
                ${signature}
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 16px;background:#f5f3ef;border-top:1px solid #ddd7cd;font-family:Arial,'Segoe UI',sans-serif;font-size:12px;line-height:16px;color:#6a7280;text-align:center;">Kapp Crawler - automated report</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};
