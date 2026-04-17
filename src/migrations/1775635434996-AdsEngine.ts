import { MigrationInterface, QueryRunner } from "typeorm";

export class AdsEngine1775635434996 implements MigrationInterface {
    name = 'AdsEngine1775635434996'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "provider_step" DROP CONSTRAINT "FK_provider_step_provider_config_id"`);
        await queryRunner.query(`ALTER TABLE "config_table_fields" DROP CONSTRAINT "FK_config_table_fields_table_id"`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" DROP CONSTRAINT "FK_client_wise_step_client_wise_id"`);
        await queryRunner.query(`CREATE TYPE "public"."ads_credentials_provider_enum" AS ENUM('google', 'meta', 'bing')`);
        await queryRunner.query(`CREATE TABLE "ads_credentials" ("id" SERIAL NOT NULL, "name" character varying NOT NULL, "provider" "public"."ads_credentials_provider_enum" NOT NULL, "refreshToken" text NOT NULL, "accessToken" text, "clientId" text, "clientSecret" text, "developerToken" text, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9d02dabb260730418fe8ea014be" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TYPE "public"."ads_accounts_status_enum" AS ENUM('ENABLED', 'PAUSED', 'DEACTIVATED', 'REVOKED', 'UNKNOWN')`);
        await queryRunner.query(`CREATE TYPE "public"."ads_accounts_provider_enum" AS ENUM('google', 'meta', 'bing')`);
        await queryRunner.query(`CREATE TABLE "ads_accounts" ("id" SERIAL NOT NULL, "externalCustomerId" character varying NOT NULL, "name" character varying NOT NULL, "currencyCode" character varying NOT NULL DEFAULT 'INR', "timeZone" character varying NOT NULL DEFAULT 'Asia/Kolkata', "resourceName" character varying, "isManager" boolean NOT NULL DEFAULT false, "status" "public"."ads_accounts_status_enum" NOT NULL DEFAULT 'ENABLED', "provider" "public"."ads_accounts_provider_enum" NOT NULL, "parentId" integer, "credentialId" integer NOT NULL, "lastSyncedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7a0934eada012245d998e2afd7b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_c23f3e0c42f84177a1984beaa8" ON "ads_accounts" ("externalCustomerId") `);
        await queryRunner.query(`CREATE TABLE "ads_mapping" ("id" SERIAL NOT NULL, "mediumCode" character varying NOT NULL, "clientId" integer NOT NULL, "campaignInfoId" integer, "notes" text, "isActive" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_cab34c25594a4c8d9e4d92f4754" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9ee26cbcc30513afd1fde1c56e" ON "ads_mapping" ("mediumCode") `);
        await queryRunner.query(`CREATE TYPE "public"."campaign_info_provider_enum" AS ENUM('google', 'meta', 'bing')`);
        await queryRunner.query(`CREATE TYPE "public"."campaign_info_status_enum" AS ENUM('ENABLED', 'PAUSED', 'REMOVED', 'UNKNOWN')`);
        await queryRunner.query(`CREATE TYPE "public"."campaign_info_campaigntype_enum" AS ENUM('SEARCH', 'DISPLAY', 'VIDEO', 'PERFORMANCE_MAX', 'MULTI_CHANNEL', 'UNKNOWN')`);
        await queryRunner.query(`CREATE TYPE "public"."campaign_info_biddingstrategy_enum" AS ENUM('MANUAL_CPC', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_CPA', 'TARGET_ROAS', 'UNKNOWN')`);
        await queryRunner.query(`CREATE TABLE "campaign_info" ("id" SERIAL NOT NULL, "externalCampaignId" character varying NOT NULL, "name" character varying NOT NULL, "provider" "public"."campaign_info_provider_enum" NOT NULL, "status" "public"."campaign_info_status_enum" NOT NULL DEFAULT 'UNKNOWN', "campaignType" "public"."campaign_info_campaigntype_enum", "biddingStrategy" "public"."campaign_info_biddingstrategy_enum", "optimizationScore" numeric(5,2), "dailyBudget" numeric(12,2), "adsAccountId" integer NOT NULL, "clientId" integer, "lastSyncedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_219f9e6ec718c2e734fd8838c09" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_eb20d5e92d286d7aea49849407" ON "campaign_info" ("externalCampaignId") `);
        await queryRunner.query(`CREATE TABLE "campaign_metrics" ("id" SERIAL NOT NULL, "date" date NOT NULL, "impressions" bigint NOT NULL DEFAULT '0', "clicks" bigint NOT NULL DEFAULT '0', "ctr" numeric(6,4) NOT NULL DEFAULT '0', "avgCpc" numeric(10,2) NOT NULL DEFAULT '0', "spend" numeric(12,2) NOT NULL DEFAULT '0', "leads" integer NOT NULL DEFAULT '0', "cpl" numeric(12,2) NOT NULL DEFAULT '0', "applications" integer NOT NULL DEFAULT '0', "searchImpressionShare" numeric(6,4), "campaignInfoId" integer NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b95e9070ecece04855633296da3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c8dfa07e20e2523cfdc8846585" ON "campaign_metrics" ("campaignInfoId", "date") `);
        await queryRunner.query(`ALTER TABLE "provider_step" ADD CONSTRAINT "FK_a672fc3a6979d55867efb190dd4" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "config_table_fields" ADD CONSTRAINT "FK_14c4688fd104d338f966be52fe0" FOREIGN KEY ("table_id") REFERENCES "config_tables"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" ADD CONSTRAINT "FK_bb68bca7b330daacfd755467cab" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ads_accounts" ADD CONSTRAINT "FK_2ddad239ebeda36dd92fca53652" FOREIGN KEY ("parentId") REFERENCES "ads_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ads_accounts" ADD CONSTRAINT "FK_89abcb12fe7e72647845526e2d7" FOREIGN KEY ("credentialId") REFERENCES "ads_credentials"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ads_mapping" ADD CONSTRAINT "FK_90be9ec340075bc48a5ba6a0474" FOREIGN KEY ("campaignInfoId") REFERENCES "campaign_info"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "campaign_info" ADD CONSTRAINT "FK_0ca68966bdac5298e789267a2c8" FOREIGN KEY ("adsAccountId") REFERENCES "ads_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "campaign_metrics" ADD CONSTRAINT "FK_a5232af68251d278339e39f4194" FOREIGN KEY ("campaignInfoId") REFERENCES "campaign_info"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaign_metrics" DROP CONSTRAINT "FK_a5232af68251d278339e39f4194"`);
        await queryRunner.query(`ALTER TABLE "campaign_info" DROP CONSTRAINT "FK_0ca68966bdac5298e789267a2c8"`);
        await queryRunner.query(`ALTER TABLE "ads_mapping" DROP CONSTRAINT "FK_90be9ec340075bc48a5ba6a0474"`);
        await queryRunner.query(`ALTER TABLE "ads_accounts" DROP CONSTRAINT "FK_89abcb12fe7e72647845526e2d7"`);
        await queryRunner.query(`ALTER TABLE "ads_accounts" DROP CONSTRAINT "FK_2ddad239ebeda36dd92fca53652"`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" DROP CONSTRAINT "FK_bb68bca7b330daacfd755467cab"`);
        await queryRunner.query(`ALTER TABLE "config_table_fields" DROP CONSTRAINT "FK_14c4688fd104d338f966be52fe0"`);
        await queryRunner.query(`ALTER TABLE "provider_step" DROP CONSTRAINT "FK_a672fc3a6979d55867efb190dd4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c8dfa07e20e2523cfdc8846585"`);
        await queryRunner.query(`DROP TABLE "campaign_metrics"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_eb20d5e92d286d7aea49849407"`);
        await queryRunner.query(`DROP TABLE "campaign_info"`);
        await queryRunner.query(`DROP TYPE "public"."campaign_info_biddingstrategy_enum"`);
        await queryRunner.query(`DROP TYPE "public"."campaign_info_campaigntype_enum"`);
        await queryRunner.query(`DROP TYPE "public"."campaign_info_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."campaign_info_provider_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9ee26cbcc30513afd1fde1c56e"`);
        await queryRunner.query(`DROP TABLE "ads_mapping"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c23f3e0c42f84177a1984beaa8"`);
        await queryRunner.query(`DROP TABLE "ads_accounts"`);
        await queryRunner.query(`DROP TYPE "public"."ads_accounts_provider_enum"`);
        await queryRunner.query(`DROP TYPE "public"."ads_accounts_status_enum"`);
        await queryRunner.query(`DROP TABLE "ads_credentials"`);
        await queryRunner.query(`DROP TYPE "public"."ads_credentials_provider_enum"`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" ADD CONSTRAINT "FK_client_wise_step_client_wise_id" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "config_table_fields" ADD CONSTRAINT "FK_config_table_fields_table_id" FOREIGN KEY ("table_id") REFERENCES "config_tables"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "provider_step" ADD CONSTRAINT "FK_provider_step_provider_config_id" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
