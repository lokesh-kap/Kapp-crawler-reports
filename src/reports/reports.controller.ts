import { Controller, Post } from '@nestjs/common';
import { OverallClientReportService } from './overall-client-report.service';
import { GoogleAdsReportService } from './google-ads-report.service';
import { VendorReportService } from './vendor-report.service';
import { DatabaseReportService } from './database-report.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportService: OverallClientReportService,
    private readonly googleAdsReportService: GoogleAdsReportService,
    private readonly vendorReportService: VendorReportService,
    private readonly databaseReportService: DatabaseReportService,
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

  /** Manual trigger: POST /reports/vendor-email */
  @Post('vendor-email')
  async triggerVendorReport() {
    const result = await this.vendorReportService.generateAndSendReport();
    return { message: 'Vendor report generated and emailed.', ...result };
  }

  /** Manual trigger: POST /reports/database-import-medium-codes */
  @Post('database-import-medium-codes')
  async importDatabaseMediumCodes() {
    const result = await this.databaseReportService.importDatabaseMediumCodesFromCsv();
    return { message: 'Database medium codes imported.', ...result };
  }

  /** Manual trigger: POST /reports/database-email */
  @Post('database-email')
  async triggerDatabaseReport() {
    const result = this.databaseReportService.triggerReportInBackground();
    return { message: result.message, accepted: result.accepted };
  }

  /** Status: POST /reports/database-email-status */
  @Post('database-email-status')
  async databaseReportStatus() {
    return this.databaseReportService.getJobStatus();
  }
}
