import { MigrationInterface, QueryRunner } from 'typeorm';

export class Brand1758983295970 implements MigrationInterface {
  name = 'Migration1758983295970';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX brand_name_trgm_idx
      ON brand USING gin (name gin_trgm_ops)
    `);

    await queryRunner.query(`INSERT INTO "brand" (id,"createdAt","updatedAt",name,domains) VALUES
	 ('18ccc1b8-1a2f-400d-b981-d391e0a684ef'::uuid,'2025-09-27 20:57:37.640','2025-09-27 20:57:37.640','LG','["lg.com"]'),
	 ('99b8685d-a860-411c-b9a4-d85495c16487'::uuid,'2025-09-27 20:57:37.654','2025-09-27 20:57:37.654','Samsung','["samsung.com"]'),
	 ('855238d1-ef2e-4028-b2e0-be1b440dc188'::uuid,'2025-09-27 20:57:37.656','2025-09-27 20:57:37.656','ASUS','["asus.com"]'),
	 ('0548a85a-654c-489b-9500-5bad46aadc44'::uuid,'2025-09-27 20:57:37.658','2025-09-27 20:57:37.658','Corsair','["corsair.com"]'),
	 ('fb988b87-16c4-4b61-86c5-093c40429185'::uuid,'2025-09-27 20:57:37.659','2025-09-27 20:57:37.659','Acer','["acer.com"]'),
	 ('121112d6-4eb8-4e29-aded-82b377abdd30'::uuid,'2025-09-27 20:57:37.660','2025-09-27 20:57:37.660','MSI','["msi.com"]'),
	 ('a41c23cd-4c83-4ee6-8dc8-e8625b91282a'::uuid,'2025-09-27 20:57:37.662','2025-09-27 20:57:37.662','Gigabyte','["gigabyte.com"]'),
	 ('ab673223-47fb-46d3-8bc1-35d28abad113'::uuid,'2025-09-27 20:57:37.663','2025-09-27 20:57:37.663','Lenovo','["lenovo.com"]'),
	 ('19f0dbcd-1444-4fb4-865a-7f1551c09c08'::uuid,'2025-09-27 20:57:37.664','2025-09-27 20:57:37.664','Dell','["dell.com"]'),
	 ('b7fc68ce-51ac-4e7a-b61b-fae1e017b15b'::uuid,'2025-09-27 20:57:37.666','2025-09-27 20:57:37.666','Philips','["philips.com"]'),
	 ('2767d2e8-bdaf-421b-bf93-27ae7052d04c'::uuid,'2025-09-27 20:57:37.667','2025-09-27 20:57:37.667','AOC','["aoc.com"]'),
	 ('075932dc-8734-494b-8b9c-bdc11f562957'::uuid,'2025-09-27 20:57:37.668','2025-09-27 20:57:37.668','BenQ','["benq.com"]'),
	 ('64022e6a-1755-4845-9369-27f8bb7a5224'::uuid,'2025-09-27 20:57:37.670','2025-09-27 20:57:37.670','HP','["hp.com"]'),
	 ('45f1c954-f110-4cd0-90c5-65ec49f451bf'::uuid,'2025-09-27 20:57:37.671','2025-09-27 20:57:37.671','Sony','["sony.com"]'),
	 ('3032a2db-776d-4b9a-9f58-552a32f1c4b7'::uuid,'2025-09-27 20:57:37.672','2025-09-27 20:57:37.672','TCL','["tcl.com"]'),
	 ('99a81660-328d-4fbb-ba46-fce6a70422e4'::uuid,'2025-09-27 20:57:37.674','2025-09-27 20:57:37.674','ViewSonic','["philips.com"]'),
	 ('2619ec7f-b568-4438-bf31-861323a09268'::uuid,'2025-09-27 20:57:37.675','2025-09-27 20:57:37.675','Xiaomi','["mi.com"]');`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "brand"`);
  }
}
