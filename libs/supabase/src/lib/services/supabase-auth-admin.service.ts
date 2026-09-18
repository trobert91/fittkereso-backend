import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@fittkereso-backend/database';
import { CustomLogger } from '@fittkereso-backend/logger';
import { find, isEmpty, isUndefined } from 'lodash';
import { SupabaseAdminClientService } from './supabase-admin-client.service';

export interface CreateSupabaseAccountParams {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

export interface SupabaseAccountMetadata {
  role?: UserRole;
  passwordChangeRequired?: boolean;
}

export interface SupabaseAccountSummary {
  authUserId: string;
  email: string;
}

interface GoTrueError {
  code?: string;
  status?: number;
  message?: string;
}

const LIST_USERS_PAGE_SIZE = 1000;

/**
 * The single funnel for every Supabase GoTrue admin call.
 *
 * Keeping them together means GoTrue's error vocabulary is translated into
 * HTTP exactly once, so callers never have to interpret a raw AuthError.
 */
@Injectable()
export class SupabaseAuthAdminService {
  private readonly logger = new CustomLogger(SupabaseAuthAdminService.name);

  constructor(private readonly adminClient: SupabaseAdminClientService) {}

  /** Creates a GoTrue account and returns its id. */
  async createAccount(params: CreateSupabaseAccountParams): Promise<string> {
    const { data, error } = await this.adminClient
      .getClient()
      .auth.admin.createUser({
        email: params.email,
        password: params.password,
        // A superadmin vouches for the address, so skip the confirmation mail.
        email_confirm: true,
        user_metadata: { name: params.name },
        app_metadata: {
          role: params.role,
          password_change_required: true,
        },
      });

    if (error || !data?.user) {
      throw this.toHttpException('Account creation', error);
    }

    return data.user.id;
  }

  async updateAccountEmail(authUserId: string, email: string): Promise<void> {
    const { error } = await this.adminClient
      .getClient()
      .auth.admin.updateUserById(authUserId, { email, email_confirm: true });

    if (error) {
      throw this.toHttpException('Email change', error);
    }
  }

  /**
   * Mirrors role / password-change state into app_metadata so the admin
   * frontend can read them straight off the JWT it already verifies.
   *
   * The mirror is advisory only - the backend always reads the local row.
   * Only the keys being changed are sent, since GoTrue merges app_metadata
   * shallowly and a full replacement would drop unrelated keys.
   */
  async updateAccountMetadata(
    authUserId: string,
    metadata: SupabaseAccountMetadata,
  ): Promise<void> {
    const appMetadata: Record<string, unknown> = {};

    if (!isUndefined(metadata.role)) {
      appMetadata['role'] = metadata.role;
    }
    if (!isUndefined(metadata.passwordChangeRequired)) {
      appMetadata['password_change_required'] = metadata.passwordChangeRequired;
    }
    if (isEmpty(appMetadata)) {
      return;
    }

    const { error } = await this.adminClient
      .getClient()
      .auth.admin.updateUserById(authUserId, { app_metadata: appMetadata });

    if (error) {
      throw this.toHttpException('Account metadata update', error);
    }
  }

  async updateAccountPassword(
    authUserId: string,
    password: string,
  ): Promise<void> {
    const { error } = await this.adminClient
      .getClient()
      .auth.admin.updateUserById(authUserId, { password });

    if (error) {
      throw this.toHttpException('Password change', error);
    }
  }

  async deleteAccount(authUserId: string): Promise<void> {
    const { error } = await this.adminClient
      .getClient()
      .auth.admin.deleteUser(authUserId);

    if (error) {
      throw this.toHttpException('Account deletion', error);
    }
  }

  /**
   * supabase-js exposes no getUserByEmail, so this pages through listUsers.
   * Only repair paths (seeding, backfill) need it - never a request path.
   */
  async findAccountByEmail(
    email: string,
  ): Promise<SupabaseAccountSummary | null> {
    const normalizedEmail = email.trim().toLowerCase();

    for (let page = 1; ; page += 1) {
      const { data, error } = await this.adminClient
        .getClient()
        .auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });

      if (error) {
        throw this.toHttpException('Account lookup', error);
      }

      const accounts = data?.users ?? [];
      const match = find(
        accounts,
        (account) => (account.email ?? '').toLowerCase() === normalizedEmail,
      );

      if (match) {
        return { authUserId: match.id, email: match.email ?? normalizedEmail };
      }
      if (accounts.length < LIST_USERS_PAGE_SIZE) {
        return null;
      }
    }
  }

  /**
   * Returns the recovery token hash for an address, or null when no account
   * has it - callers must stay silent about which, so the endpoint can't be
   * used to probe for registered addresses.
   *
   * Only the hash is returned: GoTrue's own action_link bounces through
   * /verify and hands the session back in a URL fragment, which the server
   * can never read. We build our own link around this token instead.
   */
  async generateRecoveryToken(email: string): Promise<string | null> {
    const { data, error } = await this.adminClient
      .getClient()
      .auth.admin.generateLink({ type: 'recovery', email });

    if (error) {
      if (error.code === 'user_not_found' || error.status === 404) {
        return null;
      }
      throw this.toHttpException('Recovery link generation', error);
    }

    return data?.properties?.hashed_token ?? null;
  }

  private toHttpException(
    action: string,
    error: GoTrueError | null,
  ): HttpException {
    switch (error?.code) {
      case 'email_exists':
      case 'user_already_exists':
        return new ConflictException(
          'An account with this email already exists',
        );
      case 'weak_password':
      case 'validation_failed':
      case 'email_address_invalid':
        // GoTrue knows the project's own password and email policy, which may
        // be stricter than ours, so its wording is the useful one here.
        return new BadRequestException(error?.message ?? 'Invalid request');
      case 'user_not_found':
        return new NotFoundException('Resource not found');
      default:
        this.logger.error(`${action} failed`, undefined, {
          code: error?.code,
          status: error?.status,
          message: error?.message,
        });
        return new HttpException(`${action} failed`, HttpStatus.BAD_GATEWAY);
    }
  }
}
