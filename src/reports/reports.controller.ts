import { Controller, Post } from '@nestjs/common';
import { OverallClientReportService } from './overall-client-report.service';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportService: OverallClientReportService) { }

  /** Manual trigger: POST /reports/email-reports */
  @Post('email')
  async triggerEmailReports() {
    await this.reportService.generateAndSendReport();
    return { message: 'All (Overall + Zone-wise) reports generated and emailed.' };
  }
}
