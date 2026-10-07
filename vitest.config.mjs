import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Git identity for every repository the tests create, set before any module loads, because
 * `src/git` copies the environment once at import. Global and system git configuration are
 * ignored and git may not guess an identity from the host, so a run here behaves as on CI.
 */
const GIT_TEST_ENVIRONMENT = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "user.useConfigOnly",
  GIT_CONFIG_VALUE_0: "true",
}

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30000, env: GIT_TEST_ENVIRONMENT },
})
