import { configDefaults, defineConfig } from 'vitest/config';

// These suites pack full runtimes or fsync exhaustive recovery matrices.
// Recovery/self-update cases fit their deadlines alone but timed out in parallel.
const artifactTests = [
  'tests/hostClosure.test.ts',
  'tests/hostLifecycle.test.ts',
  'tests/hostStates.test.ts',
  'tests/mcpLifecycle.test.ts',
  'tests/runtimePack.test.ts',
  'tests/runtimeReader.test.ts',
  'tests/sweep/interruption.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'parallel',
          setupFiles: ['tests/setup/isolatedHome.ts', 'tests/setup/hostDiscovery.ts'],
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...artifactTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'artifacts',
          setupFiles: ['tests/setup/isolatedHome.ts', 'tests/setup/hostDiscovery.ts'],
          include: artifactTests,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
