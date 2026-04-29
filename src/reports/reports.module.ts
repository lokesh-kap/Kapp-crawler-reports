import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OverallClientReportService } from './overall-client-report.service';
import { GoogleAdsReportService } from './google-ads-report.service';
import { ReportsController } from './reports.controller';
import { VendorReportService } from './vendor-report.service';
import { VendorMediumCodeEntity } from './entities/vendor-medium-code.entity';
import { DatabaseMediumCodeEntity } from './entities/database-medium-code.entity';
import { DatabaseReportService } from './database-report.service';

@Module({
  imports: [TypeOrmModule.forFeature([VendorMediumCodeEntity, DatabaseMediumCodeEntity])],
  controllers: [ReportsController],
  providers: [OverallClientReportService, GoogleAdsReportService, VendorReportService, DatabaseReportService],
  exports: [OverallClientReportService, GoogleAdsReportService, VendorReportService, DatabaseReportService],
})
export class ReportsModule {}
