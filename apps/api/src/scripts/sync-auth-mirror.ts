/**
 * Re-pushes every account's role and temporary-password hold into its
 * Supabase app_metadata.
 *
 *   npm run sync:auth-mirror:dev
 *   npm run sync:auth-mirror:prod
 *
 * The local app_user row is the authority on both; app_metadata is only a
 * mirror, written whenever the API changes either, which the admin app and
 * the partner portal read off the JWT for their redirects. Anything that
 * changes app_user without going through the API - a hand-written UPDATE, an
 * enum migration such as superadmin -> admin - leaves the mirror stale until
 * this is run. Idempotent: running it twice writes the same values twice.
 *
 * A signed-in session keeps its old claims until its access token is next
 * refreshed (at most an hour), or until its owner signs in again.
 */
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../app.module';
import { UserRepository } from '@fittkereso-backend/database';
import { SupabaseAuthAdminService } from '@fittkereso-backend/supabase';
import { SupabaseConfigService } from '@fittkereso-backend/config';
import { AppConfigService } from '../modules/app-config/services/app-config.service';

type SyncEnvironment = 'dev' | 'prod';

function parseEnvironment(): SyncEnvironment {
  const environment = process.argv.slice(2).find((value) => !value.startsWith('--'));

  if (environment !== 'dev' && environment !== 'prod') {
    throw new Error(
      'Usage: sync-auth-mirror.ts <dev|prod>\n' +
        'The environment is required, not defaulted: this writes to a real ' +
        'Supabase project and which one is not something to guess.',
    );
  }

  return environment;
}

/** Same check as seed-users.ts: a dev run must never reach a prod config. */
function assertEnvironmentMatchesConfig(
  app: INestApplicationContext,
  requested: SyncEnvironment,
): void {
  const configured = app.get(AppConfigService).environment;

  if ((configured === 'prod') !== (requested === 'prod')) {
    throw new Error(
      `Refusing to sync "${requested}" against a config with environment ` +
        `"${configured}". Check API_CONFIG_PATH points at the right config.yaml.`,
    );
  }
}

async function bootstrap(): Promise<void> {
  const environment = parseEnvironment();
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    assertEnvironmentMatchesConfig(app, environment);

    const users = await app.get(UserRepository).getAll();
    const authAdmin = app.get(SupabaseAuthAdminService);
    const supabaseUrl = app.get(SupabaseConfigService).url;

    console.log(`Syncing ${users.length} account(s) to ${supabaseUrl}.`);

    let failed = 0;
    for (const user of users) {
      try {
        await authAdmin.updateAccountMetadata(user.authUserId, {
          role: user.role,
          passwordChangeRequired: user.passwordChangeRequired,
        });
        console.log(
          `${user.email}: role ${user.role}, ` +
            `passwordChangeRequired ${user.passwordChangeRequired}.`,
        );
      } catch (error) {
        // One account missing from Supabase must not stop the others.
        failed += 1;
        console.error(
          `${user.email}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (failed > 0) {
      throw new Error(`${failed} account(s) could not be synced.`);
    }
  } finally {
    await app.close();
  }
}

bootstrap()
  .then(() => {
    // See seed-users.ts: Supabase's client keeps handles open that
    // app.close() knows nothing about.
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      'Failed to sync the auth mirror:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
