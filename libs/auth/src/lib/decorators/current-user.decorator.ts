import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../models/auth-user';

/**
 * The caller resolved by AuthGuard.
 *
 * Only meaningful on routes the guard actually ran for: on a @Public route
 * there is no user and this is undefined.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<Request>();

    return (request as Request & { user?: AuthenticatedUser }).user;
  },
);
