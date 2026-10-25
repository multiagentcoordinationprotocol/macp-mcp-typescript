import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

const baseRules = {
  ...tseslint.configs.recommended.rules,
  '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
  '@typescript-eslint/consistent-type-imports': 'error',
};

export default [
  { ignores: ['dist/', 'coverage/'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: { ...baseRules, '@typescript-eslint/no-floating-promises': 'error' },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: baseRules,
  },
];
