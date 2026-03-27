import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExtractionConfigTables1774605000000 implements MigrationInterface {
  name = 'ExtractionConfigTables1774605000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "config_tables" (
        "id" SERIAL NOT NULL,
        "config_type" character varying(20) NOT NULL,
        "config_id" integer NOT NULL,
        "row_selector" text NOT NULL,
        "next_selector" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_config_tables_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "config_table_fields" (
        "id" SERIAL NOT NULL,
        "table_id" integer NOT NULL,
        "field_key" character varying(100) NOT NULL,
        "db_column" character varying(100) NOT NULL,
        "selector" text NOT NULL,
        "data_type" character varying(20) NOT NULL DEFAULT 'text',
        "attribute" character varying(50),
        "sequence" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_config_table_fields_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_config_table_fields_table_id"
          FOREIGN KEY ("table_id") REFERENCES "config_tables"("id")
          ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "config_table_fields"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "config_tables"`);
  }
}

