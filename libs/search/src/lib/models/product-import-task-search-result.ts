import {
  ProductImportTaskKind,
  ProductImportTask,
  TaskStatus,
} from '@fittkereso-backend/database';
import { BasePageResult } from './base-page-result';

export class ProductImportTaskSearchResult extends BasePageResult<ProductImportTask> {
  statuses?: TaskStatus[];

  kinds?: ProductImportTaskKind[];

  sourceIds?: string[];
}
