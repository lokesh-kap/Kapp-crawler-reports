import { Controller, Post } from '@nestjs/common';
import { OverallClientReportService } from './overall-client-report.service';
import { GoogleAdsReportService } from './google-ads-report.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportService: OverallClientReportService,
    private readonly googleAdsReportService: GoogleAdsReportService,
  ) {}

  /** Manual trigger: POST /reports/email */
  @Post('email')
  async triggerEmailReports() {
    await this.reportService.generateAndSendReport();
    return { message: 'All (Overall + Zone-wise) reports generated and emailed.' };
  }

  /** Manual trigger: POST /reports/google-ads-email */
  @Post('google-ads-email')
  async triggerGoogleAdsReport() {
    const result = await this.googleAdsReportService.generateAndSendReport();
    return { message: 'Google Ads report generated and emailed.', ...result };
  }
}
