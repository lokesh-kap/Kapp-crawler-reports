import { Module } from '@nestjs/common';
import { OverallClientReportService } from './overall-client-report.service';
import { ReportsController } from './reports.controller';

@Module({
  controllers: [ReportsController],
  providers: [OverallClientReportService],
  exports: [OverallClientReportService],
})
export class ReportsModule {}
