import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '.superpowers/**',
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: { KeyboardEvent: 'readonly', window: 'readonly' },
      parserOptions: { parser: tseslint.parser },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),
)
