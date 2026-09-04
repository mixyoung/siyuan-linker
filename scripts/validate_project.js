import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const failures = [];
const fail = (message) => failures.push(message);

const packageJson = readJson("package.json");
const pluginJson = readJson("plugin.json");
const en = readJson("public/i18n/en.json");
const zh = readJson("public/i18n/zh-CN.json");

if (packageJson.name !== pluginJson.name) fail(`Package name ${packageJson.name} does not match plugin name ${pluginJson.name}`);
if (packageJson.version !== pluginJson.version) fail(`Package version ${packageJson.version} does not match plugin version ${pluginJson.version}`);
if (pluginJson.minAppVersion !== "3.8.2") fail("plugin.json minAppVersion must be 3.8.2");
if (pluginJson.disabledInPublish !== true) fail("plugin.json disabledInPublish must be true");

const expectedMetadata = {
    displayName: ["default", "zh-CN"],
    description: ["default", "zh-CN"],
    readme: ["default", "zh-CN"],
};
for (const [field, locales] of Object.entries(expectedMetadata)) {
    for (const locale of locales) {
        if (typeof pluginJson[field]?.[locale] !== "string" || !pluginJson[field][locale].trim()) {
            fail(`plugin.json ${field}.${locale} must be a non-empty string`);
        }
    }
    for (const locale of Object.keys(pluginJson[field] ?? {})) {
        if (locale !== "default" && !/^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/.test(locale)) {
            fail(`plugin.json ${field} locale ${locale} is not a supported BCP 47 tag`);
        }
    }
}

const expectedReadmes = { default: "README_en_US.md", "zh-CN": "README.md" };
for (const [locale, readmePath] of Object.entries(expectedReadmes)) {
    if (pluginJson.readme?.[locale] !== readmePath) fail(`plugin.json readme.${locale} must point to ${readmePath}`);
    if (!fs.existsSync(path.join(root, readmePath))) fail(`Missing README file: ${readmePath}`);
}

const chineseReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const englishReadme = fs.readFileSync(path.join(root, "README_en_US.md"), "utf8");
if (!chineseReadme.includes("README_en_US.md")) fail("README.md must link to README_en_US.md");
if (!englishReadme.includes("README.md")) fail("README_en_US.md must link to README.md");

const allowedFrontends = new Set(["desktop", "desktop-window"]);
if (!Array.isArray(pluginJson.frontends) || !pluginJson.frontends.length) fail("plugin.json frontends must not be empty");
for (const frontend of pluginJson.frontends ?? []) {
    if (!allowedFrontends.has(frontend)) fail(`Unsupported or unverified frontend declared: ${frontend}`);
}
if (new Set(pluginJson.frontends ?? []).size !== (pluginJson.frontends ?? []).length) fail("plugin.json frontends contains duplicates");
if (JSON.stringify(pluginJson.backends) !== JSON.stringify(["all"])) fail('plugin.json backends must be ["all"]');

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();
const missingInZh = enKeys.filter((key) => !(key in zh));
const missingInEn = zhKeys.filter((key) => !(key in en));
if (missingInZh.length) fail(`Missing zh-CN keys: ${missingInZh.join(", ")}`);
if (missingInEn.length) fail(`Missing en keys: ${missingInEn.join(", ")}`);
for (const [locale, messages] of [["en", en], ["zh-CN", zh]]) {
    for (const [key, value] of Object.entries(messages)) {
        if (typeof value !== "string" || !value.trim()) fail(`${locale}.${key} must be a non-empty string`);
    }
}
if (fs.existsSync(path.join(root, "public/i18n/en_US.json")) || fs.existsSync(path.join(root, "public/i18n/zh_CN.json"))) {
    fail("Legacy underscore locale files must not remain");
}

const pngInfo = (relativePath) => {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
        fail(`Missing image: ${relativePath}`);
        return null;
    }
    const buffer = fs.readFileSync(filePath);
    const signature = "89504e470d0a1a0a";
    if (buffer.subarray(0, 8).toString("hex") !== signature) {
        fail(`${relativePath} must be a PNG file`);
        return null;
    }
    return { size: buffer.length, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};
const icon = pngInfo("icon.png");
if (icon && (icon.width !== 160 || icon.height !== 160)) fail(`icon.png must be 160x160, got ${icon.width}x${icon.height}`);
if (icon && icon.size > 64 * 1024) fail(`icon.png must not exceed 64 KiB, got ${icon.size} bytes`);
const preview = pngInfo("preview.png");
if (preview && (preview.width !== 1024 || preview.height !== 768)) fail(`preview.png must be 1024x768, got ${preview.width}x${preview.height}`);
if (preview && preview.size > 512 * 1024) fail(`preview.png must not exceed 512 KiB, got ${preview.size} bytes`);

const sourceFiles = [];
const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(fullPath);
        else if (/\.(ts|vue)$/.test(entry.name)) sourceFiles.push(fullPath);
    }
};
collect(path.join(root, "src"));
for (const filePath of sourceFiles) {
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("/api/filetree/refreshFiletree")) fail(`Obsolete refreshFiletree route found in ${path.relative(root, filePath)}`);
}

if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exit(1);
}
console.log(`Validated ${enKeys.length} locale keys, SiYuan ${pluginJson.minAppVersion}, and plugin ${pluginJson.version}`);
