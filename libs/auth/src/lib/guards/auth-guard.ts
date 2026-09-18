import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import {
  ALLOW_PASSWORD_CHANGE_REQUIRED_KEY,
  IS_PUBLIC_KEY,
} from '@fittkereso-backend/utils';
import { UserAuthService } from '../services/user-auth.service';
import { AuthenticatedUser } from '../models/auth-user';

/**
 * Registered globally, so every route requires a valid Supabase token unless
 * it opts out with @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly userAuthService: UserAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.hasMetadata(context, IS_PUBLIC_KEY)) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : req.cookies?.['access_token']; // fallback to cookie if available

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const user = await this.resolveUser(token);

    // Attach the user to the request for RoleGuard and downstream handlers.
    (req as Request & { user?: AuthenticatedUser }).user = user;

    this.assertPasswordChangeNotPending(context, user);

    return true;
  }

  private async resolveUser(token: string): Promise<AuthenticatedUser> {
    try {
      return await this.userAuthService.getUser(token);
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid access token');
    }
  }

  /**
   * An account on a temporary password can only reach the routes that lift
   * the hold, or let it sign out.
   *
   * 403 rather than 401: the token is perfectly good, the account just is not
   * ready. A 401 would send the frontend off to refresh a token that is not
   * the problem, and then to the login page rather than to set-password.
   */
  private assertPasswordChangeNotPending(
    context: ExecutionContext,
    user: AuthenticatedUser,
  ): void {
    if (!user.passwordChangeRequired) {
      return;
    }
    if (this.hasMetadata(context, ALLOW_PASSWORD_CHANGE_REQUIRED_KEY)) {
      return;
    }

    throw new ForbiddenException('Password change required');
  }

  /** Handler first, then class, so an opt-out works at either level. */
  private hasMetadata(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
