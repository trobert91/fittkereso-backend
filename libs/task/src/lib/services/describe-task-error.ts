import { isProductSourceConfigInvalidError } from '@fittkereso-backend/database';

/**
 * What goes into a failed task's `error` jsonb column.
 *
 * An OBJECT, not a JSON string. Both task managers used to assign
 * `JSON.stringify({message, stack})` to a jsonb column, which stores a JSON
 * string scalar rather than an object — so every reader got back a string that
 * still needed parsing. That is why the MCP tool branches on `typeof` before
 * printing it, and why the admin UI renders an escaped one-line blob with
 * literal \n in place of the stack. Writing the object means a reader can
 * index into it.
 *
 * A structured failure keeps its structure: a config-invalid error carries the
 * source it belongs to and every bad path, so the task row says what to fix
 * rather than pointing at the guard that threw.
 */
export function describeTaskError(error: unknown): Record<string, unknown> {
  if (isProductSourceConfigInvalidError(error)) {
    return { ...error.detail };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      ...(error.name ? { name: error.name } : {}),
    };
  }

  // A non-Error throw — a string, or anything else. Wrapped rather than stored
  // bare so every error row has a `message` to read.
  return { message: typeof error === 'string' ? error : JSON.stringify(error) };
}
