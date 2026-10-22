// ESLint flat config — NestJS idiomatic rules + Prettier compat.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "contract/**", "prisma/migrations/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-empty-object-type": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        exports: "readonly",
        require: "readonly",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
