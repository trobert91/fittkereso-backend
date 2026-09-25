import { Injectable } from '@nestjs/common';
import { ProductSourceType } from '@fittkereso-backend/database';
import { ProductSourceImporter } from '../../interfaces/product-source-importer.interface';

/**
 * Resolves a ProductSource to its importer by `type`.
 *
 * Same shape as ScrapeOpRegistryService. Registration happens once, in
 * ProductScraperModule.onModuleInit, so the whole set is visible in one place
 * rather than scattered across provider constructors.
 *
 * An unregistered type throws by name rather than returning undefined: a source
 * whose type has no importer is a wiring gap, and failing the run with the type
 * in the message is more use than a null dereference three frames later.
 */
@Injectable()
export class ProductSourceImporterRegistry {
  private readonly importers = new Map<ProductSourceType, ProductSourceImporter>();

  /** Under each type the importer lists. */
  register(importer: ProductSourceImporter): void {
    for (const type of importer.types) {
      if (this.importers.has(type)) {
        throw new Error(
          `An importer is already registered for product source type "${type}"`,
        );
      }
    }
    for (const type of importer.types) this.importers.set(type, importer);
  }

  types(): ProductSourceType[] {
    return [...this.importers.keys()];
  }

  get(type: ProductSourceType): ProductSourceImporter {
    const importer = this.importers.get(type);
    if (!importer) {
      throw new Error(`No importer registered for product source type "${type}"`);
    }
    return importer;
  }
}
