import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignStartDateToCampaignInfo1776001000000 implements MigrationInterface {
    name = 'AddCampaignStartDateToCampaignInfo1776001000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaign_info" ADD "campaignStartDate" date`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaign_info" DROP COLUMN "campaignStartDate"`);
    }
}

