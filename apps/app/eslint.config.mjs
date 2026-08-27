// @ts-check
import eslint from '@eslint/js';
import angular from 'angular-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // El flat config de ESLint 9 NO lee .gitignore.
    //
    // `src/index.html` va fuera a proposito: es la pagina anfitriona, no una
    // plantilla de Angular, y el parser de plantillas no sabe leerla.
    ignores: [
      'eslint.config.mjs',
      'www/**',
      'dist/**',
      '.angular/**',
      'android/**',
      'src/index.html',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...angular.configs.tsRecommended,
      eslintPluginPrettierRecommended,
    ],
    // Sin esto, las plantillas escritas con backticks dentro del componente no
    // se analizan: 26 de los 92 ficheros usan `template:` y solo 9 usan
    // `templateUrl`, asi que se quedaria fuera la mayor parte de las plantillas.
    processor: angular.processInlineTemplates,
    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // El prefijo _ es la convencion para "esto existe porque la firma lo exige,
      // pero no se usa": un callback que solo necesita el tercer argumento, un
      // override que ignora uno. Borrarlos cambiaria la firma; marcarlos como
      // fallo seria mentir.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `async ngOnInit()` es la forma idiomatica en Angular, y OnInit declara
      // `void`. La comprobacion de metodos heredados solo produciria ruido en
      // cada pagina; el resto de la regla sigue activa.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { inheritedMethods: false } },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: ['app', 'ui'], style: 'kebab-case' },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended],
    rules: {},
  },
);
