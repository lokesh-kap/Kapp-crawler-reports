import { MigrationInterface, QueryRunner } from "typeorm";

export class ClientData1774434390368 implements MigrationInterface {
    name = 'ClientData1774434390368'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "client_wise_summary_data" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" integer NOT NULL, "year" integer NOT NULL, "user_id" integer NOT NULL, "config_id" integer NOT NULL, "source" text, "medium" text, "campaign_name" text, "primary_leads" text, "secondary_leads" text, "tertiary_leads" text, "total_instances" text, "verified_leads" text, "unverified_leads" text, "form_initiated" text, "payment_approved" text, "enrolments" text, "raw_data" jsonb, CONSTRAINT "PK_6a6a9800d68febbf940ce4f4d93" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "client_wise_leads_data" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" integer NOT NULL, "year" integer NOT NULL, "user_id" integer NOT NULL, "config_id" integer NOT NULL, "name" text, "email" text, "mobile" text, "lead_origin" text, "country" text, "state" text, "city" text, "instance" text, "instance_date" text, "campaign" text, "lead_stage" text, "lead_status" text, "email_verification_status" text, "mobile_verification_status" text, "lead_score" text, "registration_device" text, "course_specialization" text, "campus" text, "last_lead_activity_date" text, "form_initiated" text, "paid_applications" text, "submitted_applications" text, "enrolment_status" text, "qualification_level" text, "program" text, "degree" text, "discipline" text, "raw_data" jsonb, CONSTRAINT "PK_df1ef233674c7b1bb6a46ea2d1f" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "client_wise_leads_data"`);
        await queryRunner.query(`DROP TABLE "client_wise_summary_data"`);
    }

}
