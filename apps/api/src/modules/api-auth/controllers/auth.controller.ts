import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  SerializeOptions,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Response, Request } from "express";
import {
  AuthenticatedUser,
  AuthGuard,
  LoginService,
  UserAuthService,
} from "@ebike-backend/auth";
import { CustomLogger } from "@ebike-backend/logger";

@Controller("auth")
@SerializeOptions({ strategy: "exposeAll" })
export class AuthController {
  private readonly logger = new CustomLogger(AuthController.name);

  constructor(
    private readonly loginService: LoginService,
    private readonly userAuthService: UserAuthService,
  ) {}

  @Post("login")
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: Response, // allows you to modify response but still return JSON
  ): Promise<{
    user: AuthenticatedUser;
    access_token: string;
    refresh_token: string;
  }> {
    const result = await this.loginService.login(body.email, body.password);

    // Assume result contains { access_token, user, ... }
    if (result.access_token) {
      res.cookie("access_token", result.access_token, {
        httpOnly: true, // can't be accessed by JS (security)
        secure: process.env.NODE_ENV === "production", // only HTTPS in prod
        sameSite: "lax", // protects against CSRF
        path: "/", // cookie available for all routes
        maxAge: 60 * 60 * 1000, // 1 hour
      });
    }
    if (result.refresh_token) {
      res.cookie("refresh_token", result.refresh_token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
      });
    }

    const user = await this.userAuthService.getUser(result.access_token);

    return {
      user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    };
  }

  @Post("refresh-token")
  async refresh(
    @Req() req: Request,
    @Body() body: { refreshToken: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    user: AuthenticatedUser;
    access_token: string;
    refresh_token: string;
  }> {
    const refreshToken = body?.refreshToken ?? req.cookies?.["refresh_token"];
    if (!refreshToken) throw new UnauthorizedException("No refresh token");

    const result = await this.loginService.refresh(refreshToken);
    if (!result?.access_token || !result?.refresh_token)
      throw new UnauthorizedException("Failed to refresh");

    // Set new cookies
    res.cookie("access_token", result.access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 1000, // 1 hour
    });
    res.cookie("refresh_token", result.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
    });

    // Return decoded user info
    const user = await this.userAuthService.getUser(result.access_token);

    return {
      user,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
    };
  }

  @Post("logout")
  async logout(@Res({ passthrough: true }) res: Response) {
    // Clear cookies
    res.clearCookie("access_token", { path: "/" });
    res.clearCookie("refresh_token", { path: "/" });

    return { message: "Logged out" };
  }

  @Get("user")
  @UseGuards(AuthGuard)
  getUser(@Req() req: Request): AuthenticatedUser {
    return (req as any).user;
  }
}
