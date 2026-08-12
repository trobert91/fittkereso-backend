import { Reflector } from '@nestjs/core';
import { UserRole } from '@fittkereso-backend/database';

export const Roles = Reflector.createDecorator<UserRole[]>();
