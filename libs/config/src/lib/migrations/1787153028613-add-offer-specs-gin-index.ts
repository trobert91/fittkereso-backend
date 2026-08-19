import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOfferSpecsGinIndex1787153028613
  implements MigrationInterface
{
  name = 'AddOfferSpecsGinIndex1787153028613';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX offer_specs_gin_idx
      ON offer USING gin (specs jsonb_path_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS offer_specs_gin_idx`);
  }
}
