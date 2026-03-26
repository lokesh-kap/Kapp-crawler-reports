import { MigrationInterface, QueryRunner } from "typeorm";

export class StepExecutorAdded1774511531143 implements MigrationInterface {
    name = 'StepExecutorAdded1774511531143'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Remove legacy advanced filter json columns (replaced by step executor groups)
        await queryRunner.query(`ALTER TABLE "provider_leads_config" DROP COLUMN IF EXISTS "advance_filters"`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" DROP COLUMN IF EXISTS "advance_filters"`);
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" DROP COLUMN IF EXISTS "advance_filters"`);
        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" DROP COLUMN IF EXISTS "advance_filters"`);

        await queryRunner.query(`ALTER TABLE "provider_leads_config" ADD COLUMN IF NOT EXISTS "has_extra_steps" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" ADD COLUMN IF NOT EXISTS "has_extra_steps" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" ADD COLUMN IF NOT EXISTS "has_extra_steps" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" ADD COLUMN IF NOT EXISTS "has_extra_steps" boolean NOT NULL DEFAULT false`);

        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS "provider_step" (
            "id" SERIAL NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "provider_config_id" integer NOT NULL,
            "config_id" integer NOT NULL,
            "config_type" character varying(20) NOT NULL,
            "step_group" character varying(20) NOT NULL DEFAULT 'normal',
            "step_type" character varying(30) NOT NULL,
            "name" character varying(255),
            "xpath" text NOT NULL,
            "sequence" integer NOT NULL DEFAULT 0,
            "meta_data" jsonb NOT NULL DEFAULT '{}',
            "is_active" boolean NOT NULL DEFAULT true,
            CONSTRAINT "PK_provider_step_id" PRIMARY KEY ("id"),
            CONSTRAINT "FK_provider_step_provider_config_id"
              FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id")
              ON DELETE CASCADE ON UPDATE NO ACTION
          )
        `);

        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS "client_wise_step" (
            "id" SERIAL NOT NULL,
            "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
            "client_wise_id" integer NOT NULL,
            "config_type" character varying(20) NOT NULL,
            "step_group" character varying(20) NOT NULL DEFAULT 'normal',
            "step_type" character varying(30) NOT NULL,
            "name" character varying(255),
            "xpath" text NOT NULL,
            "sequence" integer NOT NULL DEFAULT 0,
            "meta_data" jsonb NOT NULL DEFAULT '{}',
            "is_active" boolean NOT NULL DEFAULT true,
            CONSTRAINT "PK_client_wise_step_id" PRIMARY KEY ("id"),
            CONSTRAINT "FK_client_wise_step_client_wise_id"
              FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id")
              ON DELETE CASCADE ON UPDATE NO ACTION
          )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "client_wise_step"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "provider_step"`);

        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" DROP COLUMN IF EXISTS "has_extra_steps"`);
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" DROP COLUMN IF EXISTS "has_extra_steps"`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" DROP COLUMN IF EXISTS "has_extra_steps"`);
        await queryRunner.query(`ALTER TABLE "provider_leads_config" DROP COLUMN IF EXISTS "has_extra_steps"`);

        // Restore legacy column on rollback
        await queryRunner.query(`ALTER TABLE "provider_leads_config" ADD COLUMN IF NOT EXISTS "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" ADD COLUMN IF NOT EXISTS "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" ADD COLUMN IF NOT EXISTS "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" ADD COLUMN IF NOT EXISTS "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
    }

}
