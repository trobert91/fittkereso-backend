import { Expose } from "class-transformer";
import { SerializeGroup } from "@ebike-backend/utils";

export class MainImageDto {
  @Expose({ groups: [SerializeGroup.list, SerializeGroup.details] })
  url: string;
}
