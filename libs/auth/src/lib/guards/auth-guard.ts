import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { UserAuthService } from '../services/user-auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly userAuthService: UserAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.split(' ')[1]
      : req.cookies?.['access_token']; // fallback to cookie if available

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    try {
      const user = await this.userAuthService.getUser(token);
      // Attach the user to the request for downstream handlers
      (req as any).user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }
}
