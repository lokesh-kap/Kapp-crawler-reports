import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUniqueToAdsAccount1775642280942 implements MigrationInterface {
    name = 'AddUniqueToAdsAccount1775642280942'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c23f3e0c42f84177a1984beaa8"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c23f3e0c42f84177a1984beaa8" ON "ads_accounts" ("externalCustomerId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_c23f3e0c42f84177a1984beaa8"`);
        await queryRunner.query(`CREATE INDEX "IDX_c23f3e0c42f84177a1984beaa8" ON "ads_accounts" ("externalCustomerId") `);
    }

}
