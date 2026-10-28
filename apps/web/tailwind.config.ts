import type { Config } from "tailwindcss";
import sharedConfig from "@openpims/config/tailwind";

const config: Config = {
  presets: [sharedConfig],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./offline/**/*.{ts,tsx}",
  ],
};

export default config;
