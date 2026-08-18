/**
 * Loads a repo-root `.env` into the environment before any config is read.
 *
 * Uses Node's own env-file support rather than a dependency, which brings one
 * property worth stating out loud: a variable already present in the real
 * environment is left alone. The file is a default, not an override. That is the
 * order an operator expects — a value passed to `docker compose`, or set for a
 * single run on the command line, still beats a `.env` somebody edited weeks ago
 * and forgot.
 */

import { join } from 'node:path';

/**
 * The repo root, resolved from this module rather than from the working directory.
 *
 * The two ways this server starts disagree about cwd: `pnpm dev` runs it from
 * `apps/api`, while the end-to-end harness runs it from the repo root. A
 * cwd-relative path would therefore work in one and silently do nothing in the
 * other — and "silently do nothing" is the worst possible failure for a config
 * file, because the symptom is a default value with no explanation attached.
 */
const ENV_PATH = join(import.meta.dirname, '..', '..', '..', '.env');

/**
 * Load the file if it exists. Returns the path loaded, or null if there was none.
 *
 * A missing `.env` is the normal case and must stay silent. A `.env` that exists
 * but cannot be read is not — that is somebody's configuration failing to apply,
 * so anything other than "no such file" is rethrown.
 */
export function loadDotEnv(): string | null {
  try {
    process.loadEnvFile(ENV_PATH);
    return ENV_PATH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
