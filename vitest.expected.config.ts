import { availableParallelism } from 'node:os'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Owner-local assembled expected-output tests that do not use a recorded session as their input. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-proxy-environment.ts'],
    include: [
      'apps/cli/tests/**/*.expected.e2e.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Each file boots complete dsh process trees under a 30s process deadline, so
    // a worker needs about two cores: 5 workers on 10+ cores, 2 on a 4-core runner.
    maxWorkers: Math.min(5, Math.max(1, Math.floor(availableParallelism() / 2))),
  },
})
