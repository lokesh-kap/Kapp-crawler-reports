import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVendorMediumCodesTable1776200000000 implements MigrationInterface {
  name = 'CreateVendorMediumCodesTable1776200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "vendor_medium_codes" (
        "id" SERIAL NOT NULL,
        "vendor_name" text NOT NULL,
        "medium_code" text NOT NULL,
        "medium_code_normalized" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vendor_medium_codes_id" PRIMARY KEY ("id"),
        CONSTRAINT "uq_vendor_medium_codes_vendor_norm" UNIQUE ("vendor_name", "medium_code_normalized")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_vendor_medium_codes_normalized"
      ON "vendor_medium_codes" ("medium_code_normalized")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_vendor_medium_codes_normalized"`);
    await queryRunner.query(`DROP TABLE "vendor_medium_codes"`);
  }
}

