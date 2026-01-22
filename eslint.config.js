import globals from "globals";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                ...globals.jest,
                Alpine: "readonly", // Global for Alpine.js
                Chart: "readonly"   // Global for Chart.js
            },
            sourceType: "module",
            ecmaVersion: 2022
        },
        ignores: [
            "public/css/style.css",
            "node_modules/**",
            "coverage/**"
        ]
    },
    pluginJs.configs.recommended,
    eslintConfigPrettier,
    {
        rules: {
            "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
            "no-console": "off",
            "no-undef": "error"
        }
    }
];
