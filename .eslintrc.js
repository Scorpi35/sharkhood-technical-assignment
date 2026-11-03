// Legacy (eslintrc) config, as specified in T01. ESLint is pinned to v8.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, jest: true },
  settings: {
    // Lets import/no-restricted-paths resolve relative .ts imports to real files.
    'import/resolver': { node: { extensions: ['.ts', '.js', '.json'] } },
  },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Only src/config may read process.env; everything else injects AppConfig.
    'no-restricted-properties': [
      'error',
      { object: 'process', property: 'env', message: 'Inject AppConfig instead of reading process.env.' },
    ],
    // Persistence boundary (T07): only src/domain and src/infra talk to the driver.
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        paths: [{ name: 'mongodb', message: 'Only src/domain and src/infra may import mongodb. Use a port.' }],
        patterns: [{ group: ['mongodb/*'], message: 'Only src/domain and src/infra may import mongodb.' }],
      },
    ],
  },
  overrides: [
    {
      files: ['src/config/**/*.ts', 'test/**/*.ts', '**/*.spec.ts'],
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      files: ['src/domain/**/*.ts', 'src/infra/**/*.ts', 'test/**/*.ts'],
      rules: { '@typescript-eslint/no-restricted-imports': 'off' },
    },
    {
      // Core import restriction (CLAUDE.md > Conventions): src/core is provider-agnostic
      // and must not import providers, domain, mongodb, bullmq or @nestjs/* values.
      // Type-only @nestjs imports are allowed for DI tokens.
      files: ['src/core/**/*.ts'],
      rules: {
        '@typescript-eslint/no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'mongodb', message: 'src/core must not depend on the Mongo driver. Use a port interface.' },
              { name: 'bullmq', message: 'src/core must not depend on the queue. Use a port interface.' },
            ],
            patterns: [
              {
                group: ['@nestjs/*'],
                allowTypeImports: true,
                message: 'src/core may only import @nestjs types (for DI tokens), not values.',
              },
              { group: ['mongodb/*', 'bullmq/*'], message: 'src/core must not depend on infrastructure.' },
              {
                // No I/O and no randomness: core transforms are pure (CLAUDE.md > Conventions).
                group: ['node:*', 'fs', 'fs/*', 'http', 'https', 'net', 'tls', 'dns', 'dgram', 'child_process', 'worker_threads', 'os', 'crypto'],
                message: 'src/core is pure: no Node I/O, OS or crypto modules.',
              },
            ],
          },
        ],
        // Purity: no clock, no randomness, no process/timer globals in core.
        'no-restricted-properties': [
          'error',
          { object: 'process', property: 'env', message: 'Inject AppConfig instead of reading process.env.' },
          { object: 'Date', property: 'now', message: 'src/core is pure: timestamps come from the source document.' },
          { object: 'Math', property: 'random', message: 'src/core is pure: no randomness.' },
          { object: 'performance', property: 'now', message: 'src/core is pure: no clock.' },
        ],
        'no-restricted-globals': [
          'error',
          ...['process', 'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'fetch', 'performance'].map((name) => ({
            name,
            message: `src/core is pure: no ${name}.`,
          })),
        ],
        'no-restricted-syntax': [
          'error',
          {
            selector: "NewExpression[callee.name='Date'][arguments.length=0]",
            message: 'src/core is pure: new Date() reads the clock. Use the source timestamp.',
          },
          {
            selector: "CallExpression[callee.name='Date']",
            message: 'src/core is pure: Date() reads the clock.',
          },
        ],
        // src/providers and src/domain are checked by resolved path, not by import string:
        // a string pattern like '**/providers/**' would also block src/core/providers
        // (core's own adapter contracts), which the convention does not mean.
        'import/no-restricted-paths': [
          'error',
          {
            zones: [
              {
                target: './src/core',
                from: './src/providers',
                message: 'src/core is provider-agnostic: it must not import src/providers.',
              },
              {
                target: './src/core',
                from: './src/domain',
                message: 'src/core must not import src/domain.',
              },
            ],
          },
        ],
      },
    },
  ],
};
