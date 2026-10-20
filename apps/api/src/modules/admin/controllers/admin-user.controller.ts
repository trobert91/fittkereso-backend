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
  Put,
  SerializeOptions,
} from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, MinRole } from '@fittkereso-backend/auth';
import { SellerMembership, User, UserRole } from '@fittkereso-backend/database';
import {
  SellerMembershipRoleDto,
  SellerMembershipService,
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
 * User administration, admin only.
 *
 * Note the serialize groups: BasePostgresEntity exposes id/createdAt/updatedAt
 * under `list`, so every route here has to include it alongside the admin
 * groups or the ids silently vanish from the response.
 */
@Controller('admin-user')
@MinRole(UserRole.admin)
export class AdminUserController {
  constructor(
    private readonly searchService: UserSearchService,
    private readonly detailService: UserDetailService,
    private readonly createService: UserCreateService,
    private readonly updateService: UserUpdateService,
    private readonly deleteService: UserDeleteService,
    private readonly membershipService: SellerMembershipService,
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
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<User> {
    return this.updateService.update(id, dto, currentUser.id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<void> {
    await this.deleteService.delete(id, currentUser.id);
  }

  /**
   * Adds the account to a seller, or changes its role there. PUT because the
   * pair (user, seller) names the membership: sending it twice is one change.
   */
  @Put(':id/memberships/:sellerId')
  @SerializeOptions({ groups: [SerializeGroup.adminList, SerializeGroup.list] })
  async putMembership(
    @Param('id') id: string,
    @Param('sellerId') sellerId: string,
    @Body() dto: SellerMembershipRoleDto,
  ): Promise<SellerMembership> {
    return this.membershipService.upsert(id, sellerId, dto.role);
  }

  /** Removes the account from the seller. The account itself stays. */
  @Delete(':id/memberships/:sellerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMembership(
    @Param('id') id: string,
    @Param('sellerId') sellerId: string,
  ): Promise<void> {
    await this.membershipService.remove(id, sellerId);
  }
}
