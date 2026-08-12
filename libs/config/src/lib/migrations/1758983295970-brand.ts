import { MigrationInterface, QueryRunner } from 'typeorm';

export class Brand1758983295970 implements MigrationInterface {
  name = 'Migration1758983295970';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX brand_name_trgm_idx
      ON brand USING gin (name gin_trgm_ops)
    `);

    await queryRunner.query(`INSERT INTO "brand" (id,"createdAt","updatedAt",name,domains) VALUES
	 ('18ccc1b8-1a2f-400d-b981-d391e0a684ef'::uuid,'2025-09-27 20:57:37.640','2025-09-27 20:57:37.640','KTM','[]'),
	 ('99b8685d-a860-411c-b9a4-d85495c16487'::uuid,'2025-09-27 20:57:37.654','2025-09-27 20:57:37.654','Riese und Müller','[]'),
	 ('855238d1-ef2e-4028-b2e0-be1b440dc188'::uuid,'2025-09-27 20:57:37.656','2025-09-27 20:57:37.656','Winora','[]'),
	 ('0548a85a-654c-489b-9500-5bad46aadc44'::uuid,'2025-09-27 20:57:37.658','2025-09-27 20:57:37.658','Cube','[]'),
	 ('fb988b87-16c4-4b61-86c5-093c40429185'::uuid,'2025-09-27 20:57:37.659','2025-09-27 20:57:37.659','Corratec','[]'),
	 ('121112d6-4eb8-4e29-aded-82b377abdd30'::uuid,'2025-09-27 20:57:37.660','2025-09-27 20:57:37.660','Victoria','[]'),
	 ('a41c23cd-4c83-4ee6-8dc8-e8625b91282a'::uuid,'2025-09-27 20:57:37.662','2025-09-27 20:57:37.662','Brennabor','[]'),
	 ('ab673223-47fb-46d3-8bc1-35d28abad113'::uuid,'2025-09-27 20:57:37.663','2025-09-27 20:57:37.663','Rideonic','[]'),
	 ('19f0dbcd-1444-4fb4-865a-7f1551c09c08'::uuid,'2025-09-27 20:57:37.664','2025-09-27 20:57:37.664','Ghost','[]'),
	 ('b7fc68ce-51ac-4e7a-b61b-fae1e017b15b'::uuid,'2025-09-27 20:57:37.666','2025-09-27 20:57:37.666','Haibike','[]'),
	 ('2767d2e8-bdaf-421b-bf93-27ae7052d04c'::uuid,'2025-09-27 20:57:37.667','2025-09-27 20:57:37.667','Hercules','[]');`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "brand"`);
  }
}
