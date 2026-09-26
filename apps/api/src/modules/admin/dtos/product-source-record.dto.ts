import { Expose, Transform } from 'class-transformer';
import {
  ProductSourceRecord,
  type SpecDefinitionJsonSchema,
} from '@fittkereso-backend/database';
import { SerializeGroup, transfromExposeAll } from '@fittkereso-backend/utils';

/**
 * One listing for the admin's details view: the record with its source,
 * offers and product, as a product's records come on the product details
 * route, and the spec schema its specs are labelled with.
 *
 * Decorated like ProductSourceVersionListDto, for the same reason.
 */
export class ProductSourceRecordDetailsDto {
  @Expose({ groups: [SerializeGroup.list] })
  record: ProductSourceRecord;

  /** Of the product's category, or while unattached of the listing's own. */
  @Expose({ groups: [SerializeGroup.list] })
  @Transform(transfromExposeAll())
  schema: SpecDefinitionJsonSchema | null;
}
