import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const typeScriptFiles = ['src/**/*.ts', '*.config.ts'];
const codeFiles = ['**/*.{js,mjs,ts}'];

export default tseslint.config(
  {
    ignores: ['coverage/**', 'data/**', 'dist/**', 'node_modules/**', 'vendor/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: typeScriptFiles,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: typeScriptFiles,
  })),
  {
    files: codeFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      sourceType: 'module',
    },
    rules: {
      'max-lines': [
        'error',
        {
          max: 1000,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      'max-lines-per-function': [
        'error',
        {
          IIFEs: true,
          max: 400,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      'no-alert': 'error',
      'no-console': ['error', { allow: ['error', 'info', 'warn'] }],
      'no-duplicate-imports': 'error',
      'no-implicit-coercion': 'error',
      'no-promise-executor-return': 'error',
      'no-warning-comments': [
        'error',
        {
          location: 'anywhere',
          terms: ['fixme', 'hack', 'todo', 'xxx'],
        },
      ],
    },
  },
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: true,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowHigherOrderFunctions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowBoolean: true,
          allowNumber: true,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression',
          message:
            'Type assertions bypass validation. Narrow the value or validate it with a schema.',
        },
        {
          selector: 'TSNonNullExpression',
          message:
            'Non-null assertions bypass strict null checks. Handle the missing case explicitly.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '**/*.test.mjs'],
    rules: {
      'no-console': 'off',
      'preserve-caught-error': 'off',
    },
  },
);
