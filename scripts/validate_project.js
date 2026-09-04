import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
);

const packageJson = readJson("package.json");
const pluginJson = readJson("plugin.json");
const en = readJson("public/i18n/en_US.json");
const zh = readJson("public/i18n/zh_CN.json");

const failures = [];

if (packageJson.name !== pluginJson.name) {
    failures.push(`Package name ${packageJson.name} does not match plugin name ${pluginJson.name}`);
}
if (packageJson.version !== pluginJson.version) {
    failures.push(`Package version ${packageJson.version} does not match plugin version ${pluginJson.version}`);
}

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
const missingInZh = enKeys.filter((key) => !(key in zh));
const missingInEn = zhKeys.filter((key) => !(key in en));
if (missingInZh.length) failures.push(`Missing zh_CN keys: ${missingInZh.join(", ")}`);
if (missingInEn.length) failures.push(`Missing en_US keys: ${missingInEn.join(", ")}`);

for (const [locale, messages] of [["en_US", en], ["zh_CN", zh]]) {
    for (const [key, value] of Object.entries(messages)) {
        if (typeof value !== "string" || value.trim() === "") {
            failures.push(`${locale}.${key} must be a non-empty string`);
        }
    }
}

if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
}

console.log(`Validated ${enKeys.length} locale keys and version ${pluginJson.version}`);
