/**
 * jose ships as pure ESM (package type: module, with no CommonJS export), so
 * Jest's CommonJS runtime cannot require it. It gets pulled into unit tests
 * transitively: SupabaseJwtService imports it, and that module sits behind the
 * @fittkereso-backend/supabase barrel that several services import from.
 *
 * Nothing under unit test actually verifies a JWT - SupabaseJwtService is only
 * ever reached through mocked collaborators - so the module is stubbed here
 * rather than transformed. That also keeps a large crypto library out of every
 * test run.
 *
 * Anything that needs real verification belongs in an integration suite with
 * ESM enabled, not in these unit tests.
 */
const stubbed = (name) => () => {
  throw new Error(
    `jose.${name} is stubbed in unit tests (see jest/jose-mock.js). ` +
      'Mock the collaborator instead of reaching for real JWT verification.',
  );
};

module.exports = {
  createRemoteJWKSet: stubbed('createRemoteJWKSet'),
  jwtVerify: stubbed('jwtVerify'),
};
