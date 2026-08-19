import { ProductSourcePostProcessMergeService } from './product-source-post-process-merge.service';
import type {
  DeterministicProductData,
  LlmProductContribution,
} from './product-source-post-process.service';

describe('ProductSourcePostProcessMergeService', () => {
  let service: ProductSourcePostProcessMergeService;

  const deterministic: DeterministicProductData = {
    brand: 'KTM',
    model: 'MACINA SCARP SX PRESTIGE Di2 M/43 electric bike',
    specs: { weight: 17, batteryCapacity: 400 },
    releaseYear: 2024,
  };

  beforeEach(() => {
    service = new ProductSourcePostProcessMergeService();
  });

  it('lets the LLM specs win per-key while deterministic fills the rest', () => {
    const llm: LlmProductContribution = {
      specs: { motorPosition: 'Középmotor' },
    };

    const result = service.merge(deterministic, llm);

    expect(result.specs).toEqual({
      weight: 17,
      batteryCapacity: 400,
      motorPosition: 'Középmotor',
    });
  });

  it('lets falsy-but-defined LLM spec values ("", 0, false) win over deterministic', () => {
    const llm: LlmProductContribution = {
      specs: { weight: 0, display: false, waterResistance: '' },
    };

    const result = service.merge(deterministic, llm);

    expect(result.specs['weight']).toBe(0);
    expect(result.specs['display']).toBe(false);
    expect(result.specs['waterResistance']).toBe('');
    expect(result.specs['batteryCapacity']).toBe(400);
  });

  it('replaces array-type spec values wholesale rather than element-merging them', () => {
    const withArray: DeterministicProductData = {
      ...deterministic,
      specs: { ...deterministic.specs, smartConnectivity: ['GPS', 'App', 'Bluetooth'] },
    };
    const llm: LlmProductContribution = {
      specs: { smartConnectivity: ['App'] },
    };

    const result = service.merge(withArray, llm);

    expect(result.specs['smartConnectivity']).toEqual(['App']);
  });

  it('degrades to an exact deterministic pass-through when llm is undefined, returning a fresh specs object', () => {
    const result = service.merge(deterministic, undefined);

    expect(result).toEqual({
      brand: 'KTM',
      model: deterministic.model,
      specs: { weight: 17, batteryCapacity: 400 },
      releaseYear: 2024,
    });
    expect(result.specs).not.toBe(deterministic.specs);
  });

  it('falls specs through to deterministic entirely when llm.specs is undefined but llm.model is set', () => {
    const llm: LlmProductContribution = { model: 'MACINA SCARP SX PRESTIGE Di2' };

    const result = service.merge(deterministic, llm);

    expect(result.specs).toEqual(deterministic.specs);
    expect(result.model).toBe('MACINA SCARP SX PRESTIGE Di2');
  });

  it('falls model through to deterministic when llm.model is absent but llm.specs is set', () => {
    const llm: LlmProductContribution = { specs: { weight: 17.9 } };

    const result = service.merge(deterministic, llm);

    expect(result.model).toBe(deterministic.model);
    expect(result.specs['weight']).toBe(17.9);
  });

  it('overrides brand alone, leaving specs/model/releaseYear to fall through', () => {
    const llm: LlmProductContribution = { brand: 'KTM AG' };

    const result = service.merge(deterministic, llm);

    expect(result.brand).toBe('KTM AG');
    expect(result.model).toBe(deterministic.model);
    expect(result.specs).toEqual(deterministic.specs);
    expect(result.releaseYear).toBe(2024);
  });

  it('overrides releaseYear alone, leaving the rest to fall through', () => {
    const llm: LlmProductContribution = { releaseYear: 2025 };

    const result = service.merge(deterministic, llm);

    expect(result.releaseYear).toBe(2025);
    expect(result.brand).toBe(deterministic.brand);
    expect(result.model).toBe(deterministic.model);
    expect(result.specs).toEqual(deterministic.specs);
  });

  it('preserves a deterministic-only spec key the LLM schema never mentioned', () => {
    const llm: LlmProductContribution = { specs: { motorPosition: 'Középmotor' } };

    const result = service.merge(deterministic, llm);

    expect(result.specs['batteryCapacity']).toBe(400);
  });
});
