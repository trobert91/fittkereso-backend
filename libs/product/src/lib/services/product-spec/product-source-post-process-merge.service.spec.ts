import { ProductSourcePostProcessMergeService } from './product-source-post-process-merge.service';
import type {
  DeterministicProductData,
  ModelSpecContribution,
  OfferIdentityContribution,
} from './product-source-post-process.service';

describe('ProductSourcePostProcessMergeService', () => {
  let service: ProductSourcePostProcessMergeService;

  const deterministic: DeterministicProductData = {
    brand: 'KTM',
    model: 'MACINA SCARP SX PRESTIGE Di2 M/43 electric bike',
    specs: { weight: 17, batteryCapacity: 400 },
  };

  beforeEach(() => {
    service = new ProductSourcePostProcessMergeService();
  });

  it('lets the model-spec contribution win per-key while deterministic fills the rest', () => {
    const modelSpecs: ModelSpecContribution = {
      specs: { motorPosition: 'Középmotor' },
    };

    const result = service.merge(deterministic, undefined, modelSpecs);

    expect(result.specs).toEqual({
      weight: 17,
      batteryCapacity: 400,
      motorPosition: 'Középmotor',
    });
  });

  it('combines offer-identity and model-spec contributions into one merged specs object', () => {
    const offerIdentity: OfferIdentityContribution = {
      specs: { frameSize: 43 },
    };
    const modelSpecs: ModelSpecContribution = {
      specs: { motorPosition: 'Középmotor' },
    };

    const result = service.merge(deterministic, offerIdentity, modelSpecs);

    expect(result.specs).toEqual({
      weight: 17,
      batteryCapacity: 400,
      frameSize: 43,
      motorPosition: 'Középmotor',
    });
  });

  it('lets falsy-but-defined spec values ("", 0, false) win over deterministic', () => {
    const modelSpecs: ModelSpecContribution = {
      specs: { weight: 0, display: false, waterResistance: '' },
    };

    const result = service.merge(deterministic, undefined, modelSpecs);

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
    const modelSpecs: ModelSpecContribution = {
      specs: { smartConnectivity: ['App'] },
    };

    const result = service.merge(withArray, undefined, modelSpecs);

    expect(result.specs['smartConnectivity']).toEqual(['App']);
  });

  it('degrades to an exact deterministic pass-through when both contributions are undefined, returning a fresh specs object', () => {
    const result = service.merge(deterministic, undefined, undefined);

    expect(result).toEqual({
      brand: 'KTM',
      model: deterministic.model,
      specs: { weight: 17, batteryCapacity: 400 },
    });
    expect(result.specs).not.toBe(deterministic.specs);
  });

  it('falls specs through to deterministic entirely when offerIdentity.specs is undefined but offerIdentity.model is set', () => {
    const offerIdentity: OfferIdentityContribution = { model: 'MACINA SCARP SX PRESTIGE Di2' };

    const result = service.merge(deterministic, offerIdentity, undefined);

    expect(result.specs).toEqual(deterministic.specs);
    expect(result.model).toBe('MACINA SCARP SX PRESTIGE Di2');
  });

  it('falls model through to deterministic when offerIdentity.model is absent but modelSpecs.specs is set', () => {
    const modelSpecs: ModelSpecContribution = { specs: { weight: 17.9 } };

    const result = service.merge(deterministic, undefined, modelSpecs);

    expect(result.model).toBe(deterministic.model);
    expect(result.specs['weight']).toBe(17.9);
  });

  it('overrides brand alone (only offerIdentity carries it), leaving specs/model to fall through', () => {
    const offerIdentity: OfferIdentityContribution = { brand: 'KTM AG' };

    const result = service.merge(deterministic, offerIdentity, undefined);

    expect(result.brand).toBe('KTM AG');
    expect(result.model).toBe(deterministic.model);
    expect(result.specs).toEqual(deterministic.specs);
  });

  it('preserves a deterministic-only spec key neither contribution mentioned', () => {
    const modelSpecs: ModelSpecContribution = { specs: { motorPosition: 'Középmotor' } };

    const result = service.merge(deterministic, undefined, modelSpecs);

    expect(result.specs['batteryCapacity']).toBe(400);
  });
});
