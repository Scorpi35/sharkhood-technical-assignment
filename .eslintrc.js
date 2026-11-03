// Legacy (eslintrc) config, as specified in T01. ESLint is pinned to v8.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, jest: true },
  ignorePatterns: ['.eslintrc.js', 'dist', 'node_modules'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Only src/config may read process.env; everything else injects AppConfig.
    'no-restricted-properties': [
      'error',
      { object: 'process', property: 'env', message: 'Inject AppConfig instead of reading process.env.' },
    ],
  },
  overrides: [
    {
      files: ['src/config/**/*.ts', 'test/**/*.ts', '**/*.spec.ts'],
      rules: { 'no-restricted-properties': 'off' },
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
                group: ['**/providers', '**/providers/**', '**/domain', '**/domain/**'],
                message: 'src/core is provider-agnostic: it must not import src/providers or src/domain.',
              },
            ],
          },
        ],
      },
    },
  ],
};
