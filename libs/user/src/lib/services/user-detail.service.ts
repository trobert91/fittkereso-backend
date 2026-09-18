import { Injectable } from '@nestjs/common';
import { User, UserRepository } from '@fittkereso-backend/database';

@Injectable()
export class UserDetailService {
  constructor(private readonly userRepository: UserRepository) {}

  /**
   * EntityNotFoundExceptionFilter turns the TypeORM miss into a clean 404,
   * so there is no need to check for null here.
   */
  async getById(id: string): Promise<User> {
    return this.userRepository.findByIdOrFail(id);
  }
}
