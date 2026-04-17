import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateNpfFunnelSummaryTableFinal1775649281806 implements MigrationInterface {
    name = 'CreateNpfFunnelSummaryTableFinal1775649281806'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "npf_funnel_summary" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" integer NOT NULL, "year" integer NOT NULL, "source" text, "primary_leads" text, "secondary_leads" text, "tertiary_leads" text, "total_instances" text, "verified_leads" text, "unverified_leads" text, "form_initiated" text, "paid_applications" text, "submit_applications" text, "enrolments" text, "instance_filter" text NOT NULL DEFAULT 'Instance', "filter_applied" text NOT NULL DEFAULT 'None', "funnel_source" text NOT NULL DEFAULT 'campaign_view', "raw_data" jsonb, CONSTRAINT "PK_c6a3425023b15c9e0eccd772ba4" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5791dace033670b65d063888ab" ON "npf_funnel_summary" ("client_id", "source", "instance_filter", "filter_applied", "funnel_source") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_5791dace033670b65d063888ab"`);
        await queryRunner.query(`DROP TABLE "npf_funnel_summary"`);
    }

}
