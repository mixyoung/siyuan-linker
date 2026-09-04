import { resolve } from "path";
import { defineConfig } from "vite";
import minimist from "minimist";
import { viteStaticCopy } from "vite-plugin-static-copy";
import livereload from "rollup-plugin-livereload";
import zipPack from "vite-plugin-zip-pack";
import fg from "fast-glob";
import vue from "@vitejs/plugin-vue";

const args = minimist(process.argv.slice(2));
const isWatch = args.watch || args.w || false;
const devDistDir = "dev";
const distDir = isWatch ? devDistDir : "dist";

export default defineConfig({
    resolve: {
        alias: {
            "@": resolve(__dirname, "src"),
        },
    },
    plugins: [
        vue(),
        viteStaticCopy({
            targets: [
                { src: "./README*.md", dest: "./" },
                { src: "./plugin.json", dest: "./" },
                { src: "./preview.png", dest: "./" },
                { src: "./icon.png", dest: "./" },
            ],
        }),
    ],
    define: {
        "process.env.DEV_MODE": `"${isWatch}"`,
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
    },
    build: {
        outDir: distDir,
        emptyOutDir: true,
        sourcemap: isWatch ? "inline" : false,
        minify: !isWatch,
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            fileName: "index",
            formats: ["cjs"],
        },
        rollupOptions: {
            plugins: [
                ...(isWatch
                    ? [
                        livereload(devDistDir),
                        {
                            name: "watch-external",
                            async buildStart() {
                                const files = await fg([
                                    "public/i18n/**",
                                    "./README*.md",
                                    "./plugin.json",
                                ]);
                                for (const file of files) {
                                    this.addWatchFile(file);
                                }
                            },
                        },
                    ]
                    : [
                        zipPack({
                            inDir: "./dist",
                            outDir: "./",
                            outFileName: "package.zip",
                        }),
                    ]),
            ],
            external: ["siyuan", "process"],
            output: {
                entryFileNames: "[name].js",
                assetFileNames: (assetInfo) => assetInfo.name === "style.css" ? "index.css" : assetInfo.name,
                exports: "named",
            },
        },
    },
});
