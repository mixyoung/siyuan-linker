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

const expectedReadmes = {
    en_US: "README_en_US.md",
    zh_CN: "README.md",
};
for (const [locale, readmePath] of Object.entries(expectedReadmes)) {
    if (pluginJson.readme?.[locale] !== readmePath) {
        failures.push(`plugin.json readme.${locale} must point to ${readmePath}`);
    }
    if (!fs.existsSync(path.join(root, readmePath))) {
        failures.push(`Missing README file: ${readmePath}`);
    }
}

const chineseReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const englishReadme = fs.readFileSync(path.join(root, "README_en_US.md"), "utf8");
if (!chineseReadme.includes("README_en_US.md")) {
    failures.push("README.md must link to README_en_US.md");
}
if (!englishReadme.includes("README.md")) {
    failures.push("README_en_US.md must link to README.md");
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
