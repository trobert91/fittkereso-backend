import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard, RoleGuard, Roles } from "@ebike-backend/auth";
import { ProductResolutionInput, UserRole } from "@ebike-backend/database";
import {
  ResolutionOptions,
  ResolutionResult,
  ResolutionService,
  ResolutionThreadContext,
} from "@ebike-backend/resolution";

@Controller("test/search")
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class SearchAgentTestController {
  constructor(private readonly productSearch: ResolutionService) {}

  @Post("/product")
  @SerializeOptions({ strategy: "exposeAll" })
  async search(
    @Body()
    body: {
      input: ProductResolutionInput;
      options?: {
        webSearchEnabled?: boolean;
        useEmbedding?: boolean;
        mode?: "strict" | "loose";
        threadContext?: ResolutionThreadContext;
      };
    },
  ): Promise<ResolutionResult> {
    if (body.input.searchBefore && !(body.input.searchBefore instanceof Date)) {
      body.input.searchBefore = new Date(body.input.searchBefore as string);
    }

    const options: ResolutionOptions = {
      webSearchEnabled: body.options?.webSearchEnabled ?? true,
      useEmbedding: body.options?.useEmbedding ?? true,
      mode: body.options?.mode ?? "loose",
    };
    const callerContext = body.options?.threadContext
      ? { threadContext: body.options.threadContext }
      : {};

    return this.productSearch.search(
      body.input,
      options,
      callerContext,
      undefined,
      { source: "test-controller" },
    );
  }
}
