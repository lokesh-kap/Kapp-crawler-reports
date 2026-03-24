import { MigrationInterface, QueryRunner } from "typeorm";

export class ProviderConfig1774334493096 implements MigrationInterface {
    name = 'ProviderConfig1774334493096'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "provider_config" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(255) NOT NULL, "config_id" integer NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "credentials" jsonb, "is_active" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_8f4ffc67ccbc6368e7131acc94f" UNIQUE ("config_id"), CONSTRAINT "PK_0e85075c470965991cb249bee99" PRIMARY KEY ("id"))`);

    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "provider_config"`);
    }

}
