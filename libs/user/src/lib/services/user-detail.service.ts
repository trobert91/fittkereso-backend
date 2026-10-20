import { Injectable } from '@nestjs/common';
import { User, UserRepository } from '@fittkereso-backend/database';

@Injectable()
export class UserDetailService {
  constructor(private readonly userRepository: UserRepository) {}

  /**
   * The account with its seller memberships (and each one's seller), by
   * seller name.
   *
   * EntityNotFoundExceptionFilter turns the TypeORM miss into a clean 404,
   * so there is no need to check for null here.
   */
  async getById(id: string): Promise<User> {
    return this.userRepository.findOneOrFail({
      where: { id },
      relations: { memberships: { seller: true } },
      order: { memberships: { seller: { name: 'ASC' } } },
    });
  }
}
