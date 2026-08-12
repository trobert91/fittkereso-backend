import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserAuthService } from '../services/user-auth.service';
import { Reflector } from '@nestjs/core';
import { Roles } from '../decorators/roles.decorator';
import { some } from 'lodash';
import { UserRole } from '@fittkereso-backend/database';

@Injectable()
export class RoleGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly userAuthService: UserAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : req.cookies?.['access_token']; // fallback to cookie if available

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    const user = await this.userAuthService.getUser(token);
    const roles = this.reflector.get<UserRole[]>(Roles, context.getHandler());
    if (!roles) {
      return true;
    }

    if (some(roles, (role) => user.role !== role)) {
      throw new UnauthorizedException('Missing required role');
    }

    // Attach the user to the request for downstream handlers
    (req as any).user = user;
    return true;
  }
}
