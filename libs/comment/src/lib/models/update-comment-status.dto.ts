import { IsDefined, IsEnum } from "class-validator";
import { CommentStatus } from "@ebike-backend/database";

export class UpdateCommentStatusDto {
  @IsDefined()
  @IsEnum(CommentStatus)
  status: CommentStatus;
}
