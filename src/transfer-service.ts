import {
    compareVersions,
    downloadExportArchive,
    ensureNotebook,
    exportAllData,
    exportDocuments,
    getDocumentLocation,
    getNotebookName,
    getSystemVersion,
    importAllData,
    importDocuments,
    readTextFile,
    reloadFileTree,
    type TargetConnection,
} from "./siyuan-api";
import { mirrorDocumentsExact } from "./mirror-service";

export const MIN_SIYUAN_VERSION = "3.8.2";
const PLUGIN_SETTINGS_PATH = "data/storage/petal/siyuan-linker/menu-config.json";

export type TransferMode = "safe" | "preserve-ids";

export interface TransferResult {
    count: number;
    warnings: string[];
}

export interface CompatibilityResult {
    sourceVersion: string;
    destinationVersion: string;
}

export async function assertCompatible(
    source?: TargetConnection,
    destination?: TargetConnection,
    exact = false,
): Promise<CompatibilityResult> {
    const [sourceVersion, destinationVersion] = await Promise.all([
        getSystemVersion(source),
        getSystemVersion(destination),
    ]);
    if (compareVersions(sourceVersion, MIN_SIYUAN_VERSION) < 0) {
        throw new Error(`Source SiYuan ${sourceVersion} is older than required ${MIN_SIYUAN_VERSION}`);
    }
    if (compareVersions(destinationVersion, MIN_SIYUAN_VERSION) < 0) {
        throw new Error(`Destination SiYuan ${destinationVersion} is older than required ${MIN_SIYUAN_VERSION}`);
    }
    if (exact && compareVersions(sourceVersion, destinationVersion) !== 0) {
        throw new Error(`This operation requires matching SiYuan versions (${sourceVersion} vs ${destinationVersion})`);
    }
    return { sourceVersion, destinationVersion };
}

type DocumentGroup = {
    notebookId: string;
    notebookName: string;
    ids: string[];
};

async function reloadWarning(target?: TargetConnection): Promise<string[]> {
    try {
        await reloadFileTree(target);
        return [];
    } catch (error) {
        console.warn("Transfer completed but the SiYuan file tree could not be reloaded", error);
        return ["The transfer completed, but the SiYuan file tree could not be reloaded automatically"];
    }
}

async function groupDocuments(docIds: string[], source?: TargetConnection): Promise<DocumentGroup[]> {
    const groups = new Map<string, DocumentGroup>();
    for (const id of [...new Set(docIds)]) {
        const location = await getDocumentLocation(id, source);
        let group = groups.get(location.notebookId);
        if (!group) {
            group = {
                notebookId: location.notebookId,
                notebookName: await getNotebookName(location.notebookId, source),
                ids: [],
            };
            groups.set(location.notebookId, group);
        }
        group.ids.push(id);
    }
    return [...groups.values()];
}

export async function transferDocumentsSafely(
    docIds: string[],
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<TransferResult> {
    if (!docIds.length) return { count: 0, warnings: [] };
    await assertCompatible(source, destination);
    const groups = await groupDocuments(docIds, source);
    let transferred = 0;
    for (const group of groups) {
        const destinationName = `${group.notebookName} (${group.notebookId})`;
        const destinationNotebook = await ensureNotebook(destinationName, destination);
        const exportPath = await exportDocuments(group.ids, source);
        const archive = await downloadExportArchive(exportPath, source);
        await importDocuments(archive, destinationNotebook.id, destination);
        transferred += group.ids.length;
    }
    return { count: transferred, warnings: await reloadWarning(destination) };
}

export async function transferDocumentsPreservingIds(
    docIds: string[],
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<TransferResult> {
    const uniqueDocIds = [...new Set(docIds)];
    if (!uniqueDocIds.length) return { count: 0, warnings: [] };
    await assertCompatible(source, destination, true);
    const result = await mirrorDocumentsExact(uniqueDocIds, source, destination);
    return { count: result.count, warnings: result.warnings };
}

export async function transferDocuments(
    docIds: string[],
    mode: TransferMode,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<TransferResult> {
    return mode === "preserve-ids"
        ? transferDocumentsPreservingIds(docIds, source, destination)
        : transferDocumentsSafely(docIds, source, destination);
}

export async function sourceHasLegacyTokens(source?: TargetConnection): Promise<boolean> {
    let content: string;
    try {
        content = await readTextFile(PLUGIN_SETTINGS_PATH, source);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/file does not exist|not found/i.test(message)) return false;
        throw error;
    }
    try {
        const data = JSON.parse(content) as Record<string, unknown>;
        return [data.sykey, data.sykey2].some((value) => typeof value === "string" && value.trim() !== "");
    } catch {
        throw new Error("Full transfer blocked: the source plugin settings file is not valid JSON");
    }
}

export async function transferAllData(
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<void> {
    await assertCompatible(source, destination, true);
    if (await sourceHasLegacyTokens(source)) {
        throw new Error("Full transfer blocked: migrate legacy plaintext API tokens to SiYuan Secrets first");
    }
    const exportPath = await exportAllData(source);
    const archive = await downloadExportArchive(exportPath, source);
    await importAllData(archive, destination);
}
