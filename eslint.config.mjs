import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // supabase/.temp holds the local CLI's runtime scratch — including a
    // bundled edge-runtime index.ts that is minified onto one line. It is
    // gitignored, but eslint does not read .gitignore, so linting it produced
    // 150+ errors about generated code nobody wrote.
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts", "supabase/.temp/**"],
  },
];

export default eslintConfig;
