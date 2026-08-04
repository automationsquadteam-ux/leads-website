// eslint-config-next 16 ships native flat configs, so no FlatCompat bridge.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'import-report*.json',
      // Editor/agent tooling that ships its own scripts not application code.
      '.claude/**',
      '.Claude/**',
      '.vscode/**',
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `_name` marks a deliberately unused binding used by placeholder
      // actions whose signature is fixed by their future implementation.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
];

export default eslintConfig;
