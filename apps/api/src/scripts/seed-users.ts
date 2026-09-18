/**
 * Seeds the admin accounts.
 *
 *   npm run seed:users:dev
 *   npm run seed:users:prod
 *
 * npm run seed:dev runs the dev variant and then seed-dev-data.ts, which adds
 * the brands, product category, sellers and product sources a dev database
 * needs on top of the accounts.
 *
 * There is deliberately no .sql seed here, unlike the control-plane project
 * this was ported from. That project's app tables and GoTrue's auth.users live
 * in the same Supabase Postgres, so its seeds could INSERT straight into
 * auth.users. Ours is a separate local Postgres with no auth schema in it, so
 * accounts have to be created through the Supabase Admin API and mirrored into
 * app_user afterwards - which is what this script does.
 *
 * Idempotent by default: an existing account is never re-passworded and an
 * existing local row is never rewritten, so a re-run cannot silently re-promote
 * someone who was deliberately demoted.
 *
 * Pass --reset-password to deliberately put an existing account back on the
 * temporary password and re-apply the hold:
 *
 *   npm run seed:users:dev -- --reset-password
 *
 * That overwrites a real credential, which is why it is opt-in rather than
 * something a plain re-run does.
 */
import { NestFactory } from '@nestjs/core';
import { ConflictException, INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module';
import { User, UserRepository, UserRole } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import {
  AppSettingsConfigService,
  SupabaseConfigService,
} from '@fittkereso-backend/config';
import { AppConfigService } from '../modules/app-config/services/app-config.service';

type SeedEnvironment = 'dev' | 'prod';

interface SeedAccount {
  email: string;
  name: string;
  role: UserRole;
  password: string;
}

interface SeedOptions {
  environment: SeedEnvironment;
  resetPassword: boolean;
}

/**
 * A published password. It only stays safe because every seeded account is
 * created with passwordChangeRequired set, which holds it at the set-password
 * page until its owner picks their own.
 */
const TEMPORARY_PASSWORD = 'password123';

const SUPERADMIN: SeedAccount = {
  email: 'torzsok.robert1@gmail.com',
  name: 'Robert Torzsok',
  role: UserRole.superadmin,
  password: TEMPORARY_PASSWORD,
};

const ACCOUNTS_BY_ENVIRONMENT: Record<SeedEnvironment, SeedAccount[]> = {
  dev: [SUPERADMIN],
  prod: [SUPERADMIN],
};

function parseArguments(): SeedOptions {
  const args = process.argv.slice(2);
  const environment = args.find((value) => !value.startsWith('--'));
  const resetPassword = args.includes('--reset-password');

  if (environment !== 'dev' && environment !== 'prod') {
    throw new Error(
      'Usage: seed-users.ts <dev|prod> [--reset-password]\n' +
        'The environment is required, not defaulted: this creates accounts on a ' +
        'real Supabase project and which one is not something to guess.',
    );
  }

  return { environment, resetPassword };
}

function assertEnvironmentMatchesConfig(
  app: INestApplicationContext,
  requested: SeedEnvironment,
): void {
  const configured = app.get(AppConfigService).environment;

  // 'prod' is the only value that must line up exactly; dev configs also use
  // 'test' and 'uat', none of which should ever accept the prod account set.
  if ((configured === 'prod') !== (requested === 'prod')) {
    throw new Error(
      `Refusing to seed "${requested}" against a config with environment ` +
        `"${configured}". Check API_CONFIG_PATH points at the right config.yaml.`,
    );
  }
}

async function resolveAuthAccount(
  app: INestApplicationContext,
  account: SeedAccount,
  supabaseUrl: string,
  resetPassword: boolean,
): Promise<string> {
  const authAdmin = app.get(SupabaseAuthAdminService);
  const email = account.email.trim().toLowerCase();

  try {
    const createdAuthUserId = await authAdmin.createAccount({
      email,
      password: account.password,
      name: account.name,
      role: account.role,
    });
    console.log(
      `Created Supabase account for ${email} (${createdAuthUserId}).`,
    );

    return createdAuthUserId;
  } catch (error) {
    if (!(error instanceof ConflictException)) {
      throw error;
    }
  }

  const existing = await authAdmin.findAccountByEmail(email);
  if (!existing) {
    throw new Error(
      `Supabase reported ${email} already exists but it could not be found.`,
    );
  }

  if (resetPassword) {
    await authAdmin.updateAccountPassword(existing.authUserId, account.password);
    await authAdmin.updateAccountMetadata(existing.authUserId, {
      role: account.role,
      passwordChangeRequired: true,
    });
    console.log(
      `${email} already existed on ${supabaseUrl} - reset to the temporary password.`,
    );
  } else {
    console.log(
      `${email} already exists on ${supabaseUrl} - not overwriting its password. ` +
        'Pass --reset-password to put it back on the temporary password.',
    );
  }

  return existing.authUserId;
}

async function ensureUser(
  app: INestApplicationContext,
  account: SeedAccount,
  supabaseUrl: string,
  resetPassword: boolean,
): Promise<void> {
  const userRepository = app.get(UserRepository);
  const email = account.email.trim().toLowerCase();

  const authUserId = await resolveAuthAccount(
    app,
    account,
    supabaseUrl,
    resetPassword,
  );

  const existingUser = await userRepository.findByAuthUserId(authUserId);
  if (existingUser) {
    if (resetPassword && !existingUser.passwordChangeRequired) {
      // Keep the local hold in step with the password we just reset.
      existingUser.passwordChangeRequired = true;
      await userRepository.save(existingUser);
    }
    console.log(
      `Local app_user row for ${email} already present ` +
        `(${existingUser.id}, role: ${existingUser.role}).`,
    );

    return;
  }

  const user = new User();
  user.authUserId = authUserId;
  user.email = email;
  user.name = account.name;
  user.role = account.role;
  user.passwordChangeRequired = true;

  const saved = await userRepository.save(user);
  console.log(
    `Created app_user row for ${email} (${saved.id}, role: ${saved.role}).`,
  );
}

async function bootstrap(): Promise<void> {
  const { environment, resetPassword } = parseArguments();
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    assertEnvironmentMatchesConfig(app, environment);

    const supabaseUrl = app.get(SupabaseConfigService).url;
    const adminUrl = app.get(AppSettingsConfigService).adminUrl;

    console.log(`Seeding "${environment}" accounts on ${supabaseUrl}.`);

    for (const account of ACCOUNTS_BY_ENVIRONMENT[environment]) {
      await ensureUser(app, account, supabaseUrl, resetPassword);
    }

    console.log('');
    console.log(
      `Seeded accounts use the temporary password "${TEMPORARY_PASSWORD}".`,
    );
    console.log(
      `Each is held at ${adminUrl}/auth/set-password until it is replaced.`,
    );

    if (environment === 'prod') {
      console.log(
        'This password is documented and therefore public - sign in and ' +
          'replace it now.',
      );
    }
  } finally {
    await app.close();
  }
}

bootstrap()
  .then(() => {
    // Supabase's client keeps handles open that app.close() knows nothing
    // about, so the script would otherwise sit here long after its work is
    // committed, looking like a hang - and npm run seed:dev would never reach
    // its second step.
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      'Failed to seed users:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
