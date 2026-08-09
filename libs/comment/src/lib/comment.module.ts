import { Module } from "@nestjs/common";
import { CommentUpdateMapperService } from "./services/comment-update-mapper.service";
import {
  CommentDetailService,
  CommentStatusService,
  CommentUpdateService,
} from "./services";
import { DatabaseModule } from "@ebike-backend/database";
import { AiModule } from "@ebike-backend/ai";
import { ProductModule } from "@ebike-backend/product";
import { RelevanceModule } from "@ebike-backend/relevance";
import { ResolutionModule } from "@ebike-backend/resolution";

@Module({
  imports: [
    ProductModule,
    AiModule,
    DatabaseModule,
    RelevanceModule,
    ResolutionModule,
  ],
  providers: [
    CommentUpdateMapperService,
    CommentUpdateService,
    CommentDetailService,
    CommentStatusService,
  ],
  exports: [CommentUpdateService, CommentDetailService, CommentStatusService],
})
export class CommentModule {}
