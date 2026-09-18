import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  SerializeOptions,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, MinRole } from '@fittkereso-backend/auth';
import { User, UserRole } from '@fittkereso-backend/database';
import {
  UserCreateDto,
  UserCreateService,
  UserDeleteService,
  UserDetailService,
  UserUpdateDto,
  UserUpdateService,
} from '@fittkereso-backend/user';
import {
  UserSearchParams,
  UserSearchResult,
  UserSearchService,
} from '@fittkereso-backend/search';
import { SerializeGroup } from '@fittkereso-backend/utils';

/**
 * User administration, superadmin only.
 *
 * Note the serialize groups: BasePostgresEntity exposes id/createdAt/updatedAt
 * under `list`, so every route here has to include it alongside the admin
 * groups or the ids silently vanish from the response.
 */
@Controller('admin-user')
@MinRole(UserRole.superadmin)
export class AdminUserController {
  constructor(
    private readonly searchService: UserSearchService,
    private readonly detailService: UserDetailService,
    private readonly createService: UserCreateService,
    private readonly updateService: UserUpdateService,
    private readonly deleteService: UserDeleteService,
  ) {}

  @Post('search')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async searchUsers(
    @Body() params: UserSearchParams,
  ): Promise<UserSearchResult> {
    return this.searchService.search(params);
  }

  @Get(':id')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async getUser(@Param('id') id: string): Promise<User> {
    return this.detailService.getById(id);
  }

  @Post()
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async createUser(@Body() dto: UserCreateDto): Promise<User> {
    return this.createService.create(dto);
  }

  /**
   * PATCH rather than PUT, unlike the other admin controllers: the admin UI
   * sends only the fields that changed. A blank name is rejected and accounts
   * can legitimately have one, and a PUT that omitted `role` must not be read
   * as a request to reset it.
   */
  @Patch(':id')
  @SerializeOptions({
    groups: [
      SerializeGroup.adminList,
      SerializeGroup.list,
      SerializeGroup.adminDetails,
      SerializeGroup.details,
    ],
  })
  async updateUser(
    @Param('id') id: string,
    @Body() dto: UserUpdateDto,
  ): Promise<User> {
    return this.updateService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.deleteService.delete(id, currentUser.id);
  }
}
