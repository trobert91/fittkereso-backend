import { BadRequestException } from '@nestjs/common';
import { ProductSpecUpdaterService } from './product-spec-updater.service';
import { ProductSpecValidatorService } from './product-spec-validator.service';
import type { ProductModel } from '@fittkereso-backend/database';

describe('ProductSpecUpdaterService.updateManualSpecs', () => {
  let service: ProductSpecUpdaterService;
  let productRepo: { findOneOrFail: jest.Mock; save: jest.Mock };
  let sourceRecordUpdater: { upsertSourceRecord: jest.Mock };
  let mergeService: { mergeSources: jest.Mock };
  let validatorService: { validateSpecs: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock };

  const category = { slug: 'ebikes' };
  const jsonSchema = { properties: { weight: { type: 'number' } } } as any;

  function makeProduct(): ProductModel {
    return {
      id: 'product-1',
      productCategory: category,
      sources: [],
    } as any;
  }

  beforeEach(() => {
    productRepo = {
      findOneOrFail: jest.fn(),
      save: jest.fn((p) => p),
    };
    sourceRecordUpdater = { upsertSourceRecord: jest.fn() };
    mergeService = { mergeSources: jest.fn() };
    validatorService = {
      validateSpecs: jest.fn().mockReturnValue({ isValid: true, errors: {} }),
    };
    categoryConfigService = {
      getJsonSchema: jest.fn().mockReturnValue(jsonSchema),
    };

    service = new ProductSpecUpdaterService(
      productRepo as any,
      sourceRecordUpdater as any,
      mergeService as any,
      validatorService as any,
      categoryConfigService as any,
    );
  });

  it('rejects with a BadRequestException and does not persist when specs fail schema validation', async () => {
    const product = makeProduct();
    productRepo.findOneOrFail.mockResolvedValue(product);
    validatorService.validateSpecs.mockReturnValue({
      isValid: false,
      errors: { weight: ['must be number'] },
    });

    await expect(
      service.updateManualSpecs('product-1', { weight: 'not-a-number' } as any),
    ).rejects.toThrow(BadRequestException);

    expect(sourceRecordUpdater.upsertSourceRecord).not.toHaveBeenCalled();
    expect(mergeService.mergeSources).not.toHaveBeenCalled();
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('includes the per-field errors on the thrown exception response', async () => {
    const product = makeProduct();
    productRepo.findOneOrFail.mockResolvedValue(product);
    validatorService.validateSpecs.mockReturnValue({
      isValid: false,
      errors: { weight: ['must be number'] },
    });

    try {
      await service.updateManualSpecs('product-1', { weight: 'bad' } as any);
      fail('expected updateManualSpecs to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        message: 'Invalid product specs — weight: must be number',
        errors: { weight: ['must be number'] },
      });
    }
  });

  it('persists and merges when specs pass validation', async () => {
    const product = makeProduct();
    productRepo.findOneOrFail.mockResolvedValue(product);

    const result = await service.updateManualSpecs('product-1', { weight: 22 });

    expect(sourceRecordUpdater.upsertSourceRecord).toHaveBeenCalledWith({
      model: product,
      source: null,
      scrapedProduct: { specs: { weight: 22 } },
    });
    expect(mergeService.mergeSources).toHaveBeenCalledWith(product);
    expect(productRepo.save).toHaveBeenCalledWith(product);
    expect(result).toBe(product);
  });

  it('skips validation when the category has no JSON schema', async () => {
    const product = makeProduct();
    productRepo.findOneOrFail.mockResolvedValue(product);
    categoryConfigService.getJsonSchema.mockReturnValue(undefined);
    validatorService.validateSpecs.mockReturnValue({ isValid: true, errors: {} });

    await service.updateManualSpecs('product-1', { weight: 22 });

    expect(validatorService.validateSpecs).toHaveBeenCalledWith(undefined, {
      weight: 22,
    });
    expect(productRepo.save).toHaveBeenCalled();
  });

  it('forces additionalProperties: false onto the category schema before validating, so unknown keys are not silently passed', async () => {
    const product = makeProduct();
    productRepo.findOneOrFail.mockResolvedValue(product);

    await service.updateManualSpecs('product-1', { weight: 22 });

    expect(validatorService.validateSpecs).toHaveBeenCalledWith(
      { ...jsonSchema, additionalProperties: false },
      { weight: 22 },
    );
  });
});

// Exercises the real validator (no mocking) against the exact scenario
// reported: {"specs":{"test":false,"test2":false}} for the ebikes category
// must be rejected, not silently accepted with a 201.
describe('ProductSpecUpdaterService.updateManualSpecs (real validator)', () => {
  let service: ProductSpecUpdaterService;
  let productRepo: { findOneOrFail: jest.Mock; save: jest.Mock };
  let sourceRecordUpdater: { upsertSourceRecord: jest.Mock };
  let mergeService: { mergeSources: jest.Mock };
  let categoryConfigService: { getJsonSchema: jest.Mock };

  const category = { slug: 'ebikes' };
  const jsonSchema = {
    type: 'object',
    title: 'E-bike',
    properties: { weight: { type: 'number', title: 'Weight' } },
  } as any;

  beforeEach(() => {
    productRepo = {
      findOneOrFail: jest.fn().mockResolvedValue({
        id: 'product-1',
        productCategory: category,
        sources: [],
      }),
      save: jest.fn((p) => p),
    };
    sourceRecordUpdater = { upsertSourceRecord: jest.fn() };
    mergeService = { mergeSources: jest.fn() };
    categoryConfigService = { getJsonSchema: jest.fn().mockReturnValue(jsonSchema) };

    service = new ProductSpecUpdaterService(
      productRepo as any,
      sourceRecordUpdater as any,
      mergeService as any,
      new ProductSpecValidatorService(),
      categoryConfigService as any,
    );
  });

  it('rejects specs made entirely of keys unknown to the category schema', async () => {
    await expect(
      service.updateManualSpecs('product-1', {
        test: false,
        test2: false,
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(sourceRecordUpdater.upsertSourceRecord).not.toHaveBeenCalled();
    expect(productRepo.save).not.toHaveBeenCalled();
  });

  it('accepts specs using only known schema keys', async () => {
    await service.updateManualSpecs('product-1', { weight: 22 });

    expect(productRepo.save).toHaveBeenCalled();
  });
});
