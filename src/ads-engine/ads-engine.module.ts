import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdsCredential } from './entities/ads-credential.entity';
import { AdsAccount } from './entities/ads-account.entity';
import { CampaignInfo } from './entities/campaign-info.entity';
import { CampaignMetrics } from './entities/campaign-metrics.entity';
import { AdsMapping } from './entities/ads-mapping.entity';
import { GoogleAdsService } from './providers/google/google-ads.service';
import { MetaAdsService } from './providers/meta/meta-ads.service';
import { BingAdsService } from './providers/bing/bing-ads.service';
import { AdsEngineService } from './ads-engine.service';
import { AdsMappingService } from './ads-mapping.service';
import { AdsEngineController } from './ads-engine.controller';
import { AttributionService } from './attribution.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AdsCredential,
      AdsAccount,
      CampaignInfo,
      CampaignMetrics,
      AdsMapping,
    ]),
  ],
  controllers: [AdsEngineController],
  providers: [
    GoogleAdsService,
    MetaAdsService,
    BingAdsService,
    AdsEngineService,
    AdsMappingService,
    AttributionService,
  ],
  exports: [AdsEngineService, AdsMappingService, AttributionService],
})
export class AdsEngineModule {}
