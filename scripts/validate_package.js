import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

const root = process.cwd();
const archivePath = path.join(root, "package.zip");
const distPath = path.join(root, "dist");
const failures = [];
const fail = (message) => failures.push(message);

if (!fs.existsSync(archivePath)) fail("package.zip was not created");
if (!fs.existsSync(distPath)) fail("dist directory was not created");

const expected = new Set([
    "README.md",
    "README_en_US.md",
    "i18n/en.json",
    "i18n/zh-CN.json",
    "icon.png",
    "index.css",
    "index.js",
    "plugin.json",
    "preview.png",
]);

if (fs.existsSync(archivePath)) {
    const zip = new AdmZip(archivePath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName.replace(/\\/g, "/"));
    for (const entry of entries) {
        if (!expected.has(entry)) fail(`Unexpected file in package.zip: ${entry}`);
        if (/\.map$|(^|\/)node_modules\/|(^|\/)src\/|(^|\/)\.env/.test(entry)) fail(`Forbidden file in package.zip: ${entry}`);
    }
    for (const entry of expected) {
        if (!entries.includes(entry)) fail(`Missing file in package.zip: ${entry}`);
    }

    const sourceManifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
    const packagedManifest = JSON.parse(zip.readAsText("plugin.json"));
    if (JSON.stringify(sourceManifest) !== JSON.stringify(packagedManifest)) fail("Packaged plugin.json does not match source plugin.json");
    const bundle = zip.readAsText("index.js");
    if (!bundle.trim()) fail("Packaged index.js is empty");
    if (bundle.includes("/api/filetree/refreshFiletree")) fail("Packaged bundle contains obsolete refreshFiletree route");
    if (bundle.includes("/temp/export/")) fail("Packaged bundle contains obsolete export archive path");
}

if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME) {
    const version = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).version;
    if (process.env.GITHUB_REF_NAME !== `v${version}`) {
        fail(`Release tag ${process.env.GITHUB_REF_NAME} does not match plugin version v${version}`);
    }
}

if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
}
console.log(`Validated package.zip with ${expected.size} expected files`);
