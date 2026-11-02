// Kept dependency-free on purpose: only `eslint` and `prettier` are devDependencies,
// so this lists a focused rule set and the Node globals instead of importing
// `@eslint/js` and `globals`. Formatting is Prettier's job, so no style rules here.
const nodeGlobals = {
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  performance: 'readonly',
  process: 'readonly',
  queueMicrotask: 'readonly',
  setImmediate: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
};

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-empty': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-shadow-restricted-names': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-throw-literal': 'error',
      'require-atomic-updates': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
];
