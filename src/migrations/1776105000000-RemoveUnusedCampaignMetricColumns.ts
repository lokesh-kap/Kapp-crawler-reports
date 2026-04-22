import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveUnusedCampaignMetricColumns1776105000000 implements MigrationInterface {
  name = 'RemoveUnusedCampaignMetricColumns1776105000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "campaign_metrics" DROP COLUMN "leads"`);
    await queryRunner.query(`ALTER TABLE "campaign_metrics" DROP COLUMN "cpl"`);
    await queryRunner.query(`ALTER TABLE "campaign_metrics" DROP COLUMN "applications"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "campaign_metrics" ADD "applications" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "campaign_metrics" ADD "cpl" numeric(12,2) NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "campaign_metrics" ADD "leads" integer NOT NULL DEFAULT '0'`);
  }
}
