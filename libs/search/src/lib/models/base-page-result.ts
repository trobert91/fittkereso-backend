import { SerializeGroup } from "@ebike-backend/utils";
import { Expose } from "class-transformer";

export abstract class BasePageResult<T> {
  @Expose({ groups: [SerializeGroup.list] })
  page?: number;

  @Expose({ groups: [SerializeGroup.list] })
  pageSize?: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalItems?: number;

  @Expose({ groups: [SerializeGroup.list] })
  totalPages?: number;

  @Expose({ groups: [SerializeGroup.list] })
  items?: T[];

  @Expose({ groups: [SerializeGroup.list] })
  sort?: string;

  @Expose({ groups: [SerializeGroup.list] })
  order?: "ASC" | "DESC";
}
