import { MapSpecValueOp } from '@fittkereso-backend/database';
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
