import { MapSpecValueOp, MapValueOp } from '@fittkereso-backend/database';
import { ScrapedProductSpec } from '@fittkereso-backend/product';
import { ProductValueMapperService } from '../services/product-value-mapper.service';
import { OpHandler } from '../services/scrape-op-registry.service';

export function makeMapSpecValue(
  mapper: ProductValueMapperService,
): OpHandler<MapSpecValueOp> {
  return (ctx, _input, op) => {
    const rawSpecs = (ctx.vars['rawSpecs'] as ScrapedProductSpec[]) ?? [];

    if (!op.single) {
      return mapper.mapListValue({ specs: rawSpecs, label: op.label });
    }
    if (op.cast === 'number') {
      return mapper.mapNumber({ specs: rawSpecs, label: op.label });
    }
    return mapper.mapSingleValue({ specs: rawSpecs, label: op.label });
  };
}

export const mapValue: OpHandler<MapValueOp> = (ctx, input, op) => {
  const value = op.value !== undefined ? ctx.vars[op.value] : input;
  if (typeof value !== 'string') return op.default;
  return op.cases[value] ?? op.default;
};
