import {
  Body,
  Controller,
  Post,
  SerializeOptions,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, RoleGuard, Roles } from '@fittkereso-backend/auth';
import { ProductResolutionInput, UserRole } from '@fittkereso-backend/database';
import {
  ResolutionOptions,
  ResolutionResult,
  ResolutionService,
} from '@fittkereso-backend/resolution';

@Controller('test/resolve')
@UseGuards(AuthGuard, RoleGuard)
@Roles([UserRole.admin])
export class ResolutionTestController {
  constructor(private readonly productSearch: ResolutionService) {}

  @Post('/product')
  @SerializeOptions({ strategy: 'exposeAll' })
  async resolve(
    @Body()
    body: {
      input: ProductResolutionInput;
      options?: {
        webSearchEnabled?: boolean;
        useEmbedding?: boolean;
        mode?: 'strict' | 'loose';
      };
    },
  ): Promise<ResolutionResult> {
    if (body.input.searchBefore && !(body.input.searchBefore instanceof Date)) {
      body.input.searchBefore = new Date(body.input.searchBefore as string);
    }

    const options: ResolutionOptions = {
      webSearchEnabled: body.options?.webSearchEnabled ?? true,
      useEmbedding: body.options?.useEmbedding ?? true,
      mode: body.options?.mode ?? 'loose',
    };

    return this.productSearch.search(body.input, options, undefined, {
      source: 'resolution-test-controller',
    });
  }
}
