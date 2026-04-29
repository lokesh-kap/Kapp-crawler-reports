import { MigrationInterface, QueryRunner } from 'typeorm';

export class UseRuntimeNormalizationForVendorCodes1776201000000 implements MigrationInterface {
  name = 'UseRuntimeNormalizationForVendorCodes1776201000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_vendor_medium_codes_normalized"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_medium_codes" DROP CONSTRAINT IF EXISTS "uq_vendor_medium_codes_vendor_norm"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_medium_codes" DROP COLUMN IF EXISTS "medium_code_normalized"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_vendor_medium_codes_vendor_norm_runtime"
      ON "vendor_medium_codes" ("vendor_name", lower(trim("medium_code")))
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_vendor_medium_codes_medium_runtime"
      ON "vendor_medium_codes" (lower(trim("medium_code")))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."idx_vendor_medium_codes_medium_runtime"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."uq_vendor_medium_codes_vendor_norm_runtime"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_medium_codes" ADD COLUMN "medium_code_normalized" text`,
    );
    await queryRunner.query(
      `UPDATE "vendor_medium_codes" SET "medium_code_normalized" = lower(trim("medium_code"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_medium_codes" ALTER COLUMN "medium_code_normalized" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "vendor_medium_codes"
      ADD CONSTRAINT "uq_vendor_medium_codes_vendor_norm"
      UNIQUE ("vendor_name", "medium_code_normalized")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_vendor_medium_codes_normalized"
      ON "vendor_medium_codes" ("medium_code_normalized")
    `);
  }
}

