import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProviderRawStatusColumns1775657600000 implements MigrationInterface {
    name = 'AddProviderRawStatusColumns1775657600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ads_accounts" ADD "providerRawStatus" character varying`);
        await queryRunner.query(`ALTER TABLE "campaign_info" ADD "providerRawStatus" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaign_info" DROP COLUMN "providerRawStatus"`);
        await queryRunner.query(`ALTER TABLE "ads_accounts" DROP COLUMN "providerRawStatus"`);
    }

}
