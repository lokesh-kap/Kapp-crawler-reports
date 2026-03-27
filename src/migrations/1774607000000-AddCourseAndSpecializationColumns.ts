import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCourseAndSpecializationColumns1774607000000
  implements MigrationInterface
{
  name = 'AddCourseAndSpecializationColumns1774607000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" ADD COLUMN IF NOT EXISTS "course" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" ADD COLUMN IF NOT EXISTS "specialization" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" DROP COLUMN IF EXISTS "course_specialization"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" DROP COLUMN IF EXISTS "specialization"`,
    );
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" DROP COLUMN IF EXISTS "course"`,
    );
    await queryRunner.query(
      `ALTER TABLE "client_wise_leads_data" ADD COLUMN IF NOT EXISTS "course_specialization" text`,
    );
  }
}

