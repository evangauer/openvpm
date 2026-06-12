import type { Config } from "tailwindcss";
import sharedConfig from "@openpims/config/tailwind";
import typography from "@tailwindcss/typography";

const config: Config = {
  presets: [sharedConfig],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./content/**/*.{md,mdx}",
  ],
  plugins: [typography],
};

export default config;
