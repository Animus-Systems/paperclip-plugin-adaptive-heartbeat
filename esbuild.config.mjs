import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/worker.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/worker.js",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk", "@paperclipai/shared"],
});

await esbuild.build({
  entryPoints: ["src/manifest.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/manifest.js",
  sourcemap: true,
  external: ["@paperclipai/plugin-sdk", "@paperclipai/shared"],
});

await esbuild.build({
  entryPoints: ["src/ui/index.tsx"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  outfile: "dist/ui/index.js",
  sourcemap: true,
  external: ["react", "react-dom", "@paperclipai/plugin-sdk"],
  jsx: "automatic",
});

console.log("Build complete.");
