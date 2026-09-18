import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { UserRole } from '@fittkereso-backend/database';
import { MinRole, ROLE_RANK } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../models/auth-user';

/**
 * Registered globally, immediately after AuthGuard.
 *
 * It reads the user AuthGuard already attached rather than re-parsing the
 * token, so a guarded request verifies its JWT and hits the database once
 * rather than twice.
 */
@Injectable()
export class RoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Handler first, then class: a handler-level @MinRole replaces the
    // class-level one rather than merging with it.
    const minRole = this.reflector.getAllAndOverride<UserRole | undefined>(
      MinRole,
      [context.getHandler(), context.getClass()],
    );

    // Unannotated routes - @Public ones included - have nothing to check.
    if (!minRole) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as Request & { user?: AuthenticatedUser }).user;

    if (!user) {
      // Only reachable if a route carries @MinRole and @Public at once, which
      // is a contradiction worth failing on rather than quietly allowing.
      throw new UnauthorizedException('Missing access token');
    }

    if (ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
      throw new ForbiddenException('Missing required role');
    }

    return true;
  }
}
