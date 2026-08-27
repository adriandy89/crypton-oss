// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // El flat config de ESLint 9 NO lee .gitignore: hay que decirlo aqui.
    ignores: ['eslint.config.mjs', 'dist/**', 'generated/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
      parserOptions: {
        // tsconfig.lint.json y no tsconfig.json: el de compilacion excluye los
        // specs, y sin ellos en el proyecto el analisis con tipos falla.
        project: ['./tsconfig.lint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.spec.ts'],
    languageOptions: { globals: { ...globals.jest } },
    rules: {
      // Un mock `async` que no espera nada es lo normal, no un fallo.
      '@typescript-eslint/require-await': 'off',
      // `jest.spyOn(obj, 'metodo')` y comparar contra `obj.metodo` referencian
      // el metodo suelto por definicion: es como se escribe una asercion, no un
      // `this` perdido. En produccion la regla sigue activa.
      '@typescript-eslint/unbound-method': 'off',
      // `require()` dentro de un test suele ser carga tardia deliberada, para
      // reimportar un modulo con el registro limpio o evitar un ESM que Jest no
      // sabe cargar.
      '@typescript-eslint/no-require-imports': 'off',
      // La familia no-unsafe-* existe para que `any` no se cuele en el codigo
      // que mueve dinero. En un test, el `any` viene de la propia herramienta
      // —lo que devuelve un `require()` dinamico, el cuerpo de una respuesta de
      // supertest, un helper de fixtures— y exigir tipos ahi solo produce
      // aserciones mas largas, no mas seguras. En produccion siguen activas.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
      // El prefijo _ es la convencion para "esto existe porque la firma lo exige,
      // pero no se usa": un callback que solo necesita el tercer argumento, un
      // override que ignora uno. Borrarlos cambiaria la firma; marcarlos como
      // fallo seria mentir.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
