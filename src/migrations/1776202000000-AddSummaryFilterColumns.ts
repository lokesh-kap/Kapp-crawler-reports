import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSummaryFilterColumns1776202000000 implements MigrationInterface {
  name = 'AddSummaryFilterColumns1776202000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_wise_summary_data" ADD COLUMN IF NOT EXISTS "filter_applied" text DEFAULT 'None'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_wise_summary_data" DROP COLUMN IF EXISTS "filter_applied"`,
    );
  }
}
