import { MigrationInterface, QueryRunner } from "typeorm";

export class ClientWiseConfig1774346163606 implements MigrationInterface {
    name = 'ClientWiseConfig1774346163606'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "client_wise" ("id" SERIAL NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(255) NOT NULL, "url" text NOT NULL, "filters" jsonb NOT NULL DEFAULT '[]', "advance_filters" jsonb NOT NULL DEFAULT '[]', "is_advance_filters" boolean NOT NULL DEFAULT false, "credentials" jsonb, "is_active" boolean NOT NULL DEFAULT true, "client_id" integer NOT NULL, "year" integer NOT NULL, "user_id" integer NOT NULL, "config_id" integer, CONSTRAINT "PK_21e014c933a23dec3d4f2ce576d" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "client_wise"`);
    }

}
