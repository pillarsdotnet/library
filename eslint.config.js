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
    // Server-side: Node ESM. A glob rather than a list of names — `covers.js`
    // was linted without Node globals purely because nobody remembered to add
    // it, and only a `process` reference made that visible. `*.js` matches the
    // repository root only, so the browser and test configs below still win for
    // public/ and test/.
    files: ['*.js'],
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
    // Agent tooling: the run skill's driver. Same shape as the test suite — Node
    // ESM that also passes callbacks to puppeteer, which runs them in the page.
    files: ['.claude/**/*.mjs'],
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
        Cropper: 'readonly',
      },
    },
    rules: { 'no-unused-vars': noUnused },
  },
];
