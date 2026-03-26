import { MigrationInterface, QueryRunner } from "typeorm";

export class StepExecutorAdded11774519172527 implements MigrationInterface {
    name = 'StepExecutorAdded11774519172527'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "provider_step" DROP CONSTRAINT "FK_provider_step_provider_config_id"`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" DROP CONSTRAINT "FK_client_wise_step_client_wise_id"`);
        await queryRunner.query(`ALTER TABLE "provider_step" ADD CONSTRAINT "FK_a672fc3a6979d55867efb190dd4" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" ADD CONSTRAINT "FK_bb68bca7b330daacfd755467cab" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "client_wise_step" DROP CONSTRAINT "FK_bb68bca7b330daacfd755467cab"`);
        await queryRunner.query(`ALTER TABLE "provider_step" DROP CONSTRAINT "FK_a672fc3a6979d55867efb190dd4"`);
        await queryRunner.query(`ALTER TABLE "client_wise_step" ADD CONSTRAINT "FK_client_wise_step_client_wise_id" FOREIGN KEY ("client_wise_id") REFERENCES "client_wise"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "provider_step" ADD CONSTRAINT "FK_provider_step_provider_config_id" FOREIGN KEY ("provider_config_id") REFERENCES "provider_config"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
