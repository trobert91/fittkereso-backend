import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductImportTaskKind } from '@fittkereso-backend/database';
import { ProductImportTaskCreateDto } from './product-import-task-create.dto';

describe('ProductImportTaskCreateDto priority', () => {
  const errorsFor = async (priority: unknown) =>
    validate(
      plainToInstance(ProductImportTaskCreateDto, {
        kind: ProductImportTaskKind.DetailPage,
        url: 'https://example.com/p/1',
        priority,
      }),
    );

  it.each([0, 10, 50, 90, 100])('accepts %p', async (priority) => {
    expect(await errorsFor(priority)).toHaveLength(0);
  });

  it.each([-1, 101, 50.5])('rejects %p', async (priority) => {
    const errors = await errorsFor(priority);
    expect(errors.map((error) => error.property)).toEqual(['priority']);
  });

  it('leaves the priority to the creator when it is absent', async () => {
    expect(await errorsFor(undefined)).toHaveLength(0);
  });
});
