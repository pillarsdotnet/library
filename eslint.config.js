import js from '@eslint/js';
import globals from 'globals';

const noUnused = ['error', {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
}];

export default [
  { ignores: ['node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    // Server-side: Node ESM.
    files: ['server.js', 'db.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: { 'no-unused-vars': noUnused },
  },
  {
    // Test suite: Node ESM (node:test). Browser globals are allowed too because
    // puppeteer page.evaluate() callbacks run in the browser context.
    files: ['test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-unused-vars': noUnused },
  },
  {
    // Browser: classic script, plus globals from the vendored scanner library.
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Html5Qrcode: 'readonly',
        Html5QrcodeSupportedFormats: 'readonly',
        Quagga: 'readonly',
      },
    },
    rules: { 'no-unused-vars': noUnused },
  },
];
