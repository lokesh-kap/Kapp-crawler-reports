import { Module } from '@nestjs/common';
import { OverallClientReportService } from './overall-client-report.service';
import { GoogleAdsReportService } from './google-ads-report.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [OverallClientReportService, GoogleAdsReportService],
  exports: [OverallClientReportService, GoogleAdsReportService],
})
export class ReportsModule {}
