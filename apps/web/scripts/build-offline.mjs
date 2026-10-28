import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "tailwindcss";
import autoprefixer from "autoprefixer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public/offline");
const compiled = await build({
  absWorkingDir: root,
  entryPoints: ["offline/index.tsx"],
  bundle: true,
  jsx: "automatic",
  minify: true,
  write: false,
  outfile: "app.js",
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  define: { "process.env.NODE_ENV": '"production"' },
  tsconfig: path.join(root, "tsconfig.json"),
});
const javascript = compiled.outputFiles[0].text;
const cssFile = path.join(root, "styles/globals.css");
const css =
  (
    await postcss([
      tailwind({ config: path.join(root, "tailwind.config.ts") }),
      autoprefixer(),
    ]).process(await readFile(cssFile, "utf8"), { from: cssFile })
  ).css +
  "\n:root{--font-inter:Arial;--font-dm-sans:Arial}body{margin:0}button:disabled{cursor:not-allowed}\n";
const htmlTemplate = await readFile(
  path.join(root, "offline/index.html"),
  "utf8",
);
const workerTemplate = await readFile(
  path.join(root, "offline/worker.js"),
  "utf8",
);
const digest = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
const script = `/offline/app.${digest(javascript)}.js`,
  style = `/offline/style.${digest(css)}.css`;
const html = htmlTemplate
  .replace("__STYLE__", style)
  .replace("__SCRIPT__", script);
const version = digest(javascript + css + html + workerTemplate);
const worker = workerTemplate
  .replace("__VERSION__", version)
  .replace(
    "__ASSETS__",
    JSON.stringify(["/offline/index.html", script, style]),
  );
// Only generated files live here; source and credentials never enter this directory.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(path.join(root, "public", script), javascript),
  writeFile(path.join(root, "public", style), css),
  writeFile(path.join(output, "index.html"), html),
  writeFile(path.join(output, "sw.js"), worker),
]);
console.log(
  `Offline public shell built (${version}); no patient or account data included.`,
);
