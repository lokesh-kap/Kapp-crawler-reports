import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeInModuleForScraping1774351615045 implements MigrationInterface {
    name = 'ChangeInModuleForScraping1774351615045'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "provider_summary_config" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "config_id" integer NOT NULL, "provider_config_id" integer NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_20005d054975e3deb9969133022" UNIQUE ("config_id"), CONSTRAINT "PK_e643be7f00177100c98cea40a1e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "provider_leads_config" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "config_id" integer NOT NULL, "provider_config_id" integer NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_8c0e0948781822167f70d0b5efd" UNIQUE ("config_id"), CONSTRAINT "PK_1e95af1d8139e3961b7cc27facc" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "client_wise_summary_config" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" integer NOT NULL, "year" integer NOT NULL, "user_id" integer NOT NULL, "config_id" integer NOT NULL, "client_wise_id" integer NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_ffa178658bdc401aa271e813d1a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "client_wise_leads_config" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "client_id" integer NOT NULL, "year" integer NOT NULL, "user_id" integer NOT NULL, "config_id" integer NOT NULL, "client_wise_id" integer NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_d6fce9c3011d049eee33acd58a7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "provider_config" DROP COLUMN "url"`);
        await queryRunner.query(`ALTER TABLE "provider_config" DROP COLUMN "filters"`);
        await queryRunner.query(`ALTER TABLE "provider_config" DROP COLUMN "advance_filters"`);
        await queryRunner.query(`ALTER TABLE "provider_config" DROP COLUMN "is_advance_filters"`);
        await queryRunner.query(`ALTER TABLE "client_wise" DROP COLUMN "url"`);
        await queryRunner.query(`ALTER TABLE "client_wise" DROP COLUMN "filters"`);
        await queryRunner.query(`ALTER TABLE "client_wise" DROP COLUMN "advance_filters"`);
        await queryRunner.query(`ALTER TABLE "client_wise" DROP COLUMN "is_advance_filters"`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" ADD CONSTRAINT "FK_f57bc4fbff9a99ead9fffbd236f" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "provider_leads_config" ADD CONSTRAINT "FK_f6f23f02ab3b12683cd8817f8fd" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" ADD CONSTRAINT "FK_7573293921d5a26f73139d02613" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" ADD CONSTRAINT "FK_93112d82b75e71dd4dd8ea9f433" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_wise_leads_config" DROP CONSTRAINT "FK_93112d82b75e71dd4dd8ea9f433"`);
        await queryRunner.query(`ALTER TABLE "client_wise_summary_config" DROP CONSTRAINT "FK_7573293921d5a26f73139d02613"`);
        await queryRunner.query(`ALTER TABLE "provider_leads_config" DROP CONSTRAINT "FK_f6f23f02ab3b12683cd8817f8fd"`);
        await queryRunner.query(`ALTER TABLE "provider_summary_config" DROP CONSTRAINT "FK_f57bc4fbff9a99ead9fffbd236f"`);
        await queryRunner.query(`ALTER TABLE "client_wise" ADD "is_advance_filters" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "client_wise" ADD "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "client_wise" ADD "filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "client_wise" ADD "url" text NOT NULL`);
        await queryRunner.query(`ALTER TABLE "provider_config" ADD "is_advance_filters" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "provider_config" ADD "advance_filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "provider_config" ADD "filters" jsonb NOT NULL DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "provider_config" ADD "url" text NOT NULL`);
        await queryRunner.query(`DROP TABLE "client_wise_leads_config"`);
        await queryRunner.query(`DROP TABLE "client_wise_summary_config"`);
        await queryRunner.query(`DROP TABLE "provider_leads_config"`);
        await queryRunner.query(`DROP TABLE "provider_summary_config"`);
    }

}
