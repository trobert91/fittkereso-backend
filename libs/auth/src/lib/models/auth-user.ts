import { UserRole } from "@ebike-backend/database";
import { SerializeGroup } from "@ebike-backend/utils";
import { Expose } from "class-transformer";

export class AuthenticatedUser {
  @Expose({ groups: [SerializeGroup.list] })
  id: string;
  @Expose({ groups: [SerializeGroup.list] })
  email: string;
  @Expose({ groups: [SerializeGroup.list] })
  role: UserRole;
}
