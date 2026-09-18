import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  SerializeOptions,
  UnauthorizedException,
} from '@nestjs/common';
import { Response, Request } from 'express';
import {
  AllowPasswordChangeRequired,
  AuthenticatedUser,
  CurrentUser,
  LoginService,
  Public,
  UserAuthService,
} from '@fittkereso-backend/auth';
import {
  MeUpdateDto,
  MeUpdateService,
  PasswordResetRequestDto,
  PasswordResetService,
  SetPasswordDto,
  SetPasswordService,
  SignInRecordService,
  VerifyRecoveryDto,
} from '@fittkereso-backend/user';
import { User } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { LoginDto, RefreshTokenDto } from '../dtos';

const ACCESS_TOKEN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

@Controller('auth')
@SerializeOptions({ strategy: 'exposeAll' })
export class AuthController {
  private readonly logger = new CustomLogger(AuthController.name);

  constructor(
    private readonly loginService: LoginService,
    private readonly userAuthService: UserAuthService,
    private readonly setPasswordService: SetPasswordService,
    private readonly meUpdateService: MeUpdateService,
    private readonly passwordResetService: PasswordResetService,
    private readonly signInRecordService: SignInRecordService,
  ) {}

  @Post('login')
  @Public()
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: Response, // allows you to modify response but still return JSON
  ): Promise<{
    user: AuthenticatedUser;
    access_token: string;
    refresh_token: string;
  }> {
    const result = await this.loginService.login(body.email, body.password);

    this.setSessionCookies(res, result.access_token, result.refresh_token);

    // Resolving the user also enforces that they have a local account: a
    // Supabase sign-in on its own does not grant access here.
    const user = await this.userAuthService.getUser(result.access_token);
    await this.signInRecordService.recordSignIn(user.authUserId);

    return {
      user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    };
  }

  @Post('refresh-token')
  @Public()
  async refresh(
    @Req() req: Request,
    @Body() body: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    user: AuthenticatedUser;
    access_token: string;
    refresh_token: string;
  }> {
    const refreshToken = body?.refreshToken ?? req.cookies?.['refresh_token'];
    if (!refreshToken) throw new UnauthorizedException('No refresh token');

    const result = await this.loginService.refresh(refreshToken);
    if (!result?.access_token || !result?.refresh_token)
      throw new UnauthorizedException('Failed to refresh');

    this.setSessionCookies(res, result.access_token, result.refresh_token);

    const user = await this.userAuthService.getUser(result.access_token);

    return {
      user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    };
  }

  @Post('logout')
  @Public()
  async logout(@Res({ passthrough: true }) res: Response) {
    // Clear cookies
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('refresh_token', { path: '/' });

    return { message: 'Logged out' };
  }

  @Get('user')
  @AllowPasswordChangeRequired()
  getUser(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /**
   * Replaces the caller's password and lifts any temporary-password hold.
   *
   * Reachable while held, since it is what lifts the hold. A password change
   * revokes the old session, so the service mints a new one and it is written
   * straight back to the cookies - the very next request then carries a token
   * without the claim, instead of being redirected here until it expired.
   */
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  @AllowPasswordChangeRequired()
  async setPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const session = await this.setPasswordService.setPassword({
      userId: user.id,
      password: body.password,
    });

    if (session.accessToken && session.refreshToken) {
      this.setSessionCookies(res, session.accessToken, session.refreshToken);
    } else {
      this.logger.warn(
        'Password set but no new session was issued; the caller must sign in again.',
        { userId: user.id },
      );
    }

    return { message: 'Password updated' };
  }

  /** Self-service profile edit. Deliberately blocked while held. */
  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: MeUpdateDto,
  ): Promise<User> {
    return this.meUpdateService.update(user.id, body);
  }

  /**
   * Always 202, whether or not the address belongs to an account, so this
   * cannot be used to discover which addresses are registered.
   */
  @Post('password-reset')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body() body: PasswordResetRequestDto,
  ): Promise<{ message: string }> {
    await this.passwordResetService.requestReset(body.email);

    return {
      message: 'If that address has an account, a reset link is on its way.',
    };
  }

  /**
   * Exchanges the token hash from a reset link for a real session.
   *
   * Public because the token itself is the credential. It only opens a
   * session; the password is then changed through set-password, which is what
   * clears the hold.
   */
  @Post('verify-recovery')
  @Public()
  async verifyRecovery(
    @Body() body: VerifyRecoveryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const result = await this.loginService.verifyRecoveryToken(body.tokenHash);

    if (!result?.access_token || !result?.refresh_token) {
      throw new UnauthorizedException('Invalid or expired recovery link');
    }

    this.setSessionCookies(res, result.access_token, result.refresh_token);

    return { message: 'Recovery link accepted' };
  }

  private setSessionCookies(
    res: Response,
    accessToken?: string,
    refreshToken?: string,
  ): void {
    const options = {
      httpOnly: true, // can't be accessed by JS (security)
      secure: process.env.NODE_ENV === 'production', // only HTTPS in prod
      sameSite: 'lax' as const, // protects against CSRF
      path: '/', // cookie available for all routes
    };

    if (accessToken) {
      res.cookie('access_token', accessToken, {
        ...options,
        maxAge: ACCESS_TOKEN_MAX_AGE_MS,
      });
    }
    if (refreshToken) {
      res.cookie('refresh_token', refreshToken, {
        ...options,
        maxAge: REFRESH_TOKEN_MAX_AGE_MS,
      });
    }
  }
}
