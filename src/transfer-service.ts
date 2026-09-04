import {
    compareVersions,
    downloadExportArchive,
    downloadWorkspaceFile,
    downloadWorkspaceFileIfExists,
    ensureNotebook,
    exportAllData,
    exportDocuments,
    getDocumentAssets,
    getDocumentLocation,
    getNotebookName,
    getSystemVersion,
    importAllData,
    importDocuments,
    isEncryptedNotebook,
    listNotebooks,
    openNotebook,
    readTextFile,
    reloadFileTree,
    updateIndexes,
    writeFile,
    type TargetConnection,
} from "./siyuan-api";

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

const containsAttributeView = (content: string): boolean => {
    let document: unknown;
    try {
        document = JSON.parse(content);
    } catch {
        throw new Error("Preserve IDs: source document is not valid JSON");
    }
    const visit = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        if (Array.isArray(value)) return value.some(visit);
        const record = value as Record<string, unknown>;
        if (typeof record.AttributeViewID === "string" && record.AttributeViewID) return true;
        return Object.values(record).some(visit);
    };
    return visit(document);
};

async function blobsEqual(left: Blob, right: Blob): Promise<boolean> {
    if (left.size !== right.size) return false;
    const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
    const leftView = new Uint8Array(leftBytes);
    const rightView = new Uint8Array(rightBytes);
    return leftView.every((value, index) => value === rightView[index]);
}

function ancestorDocumentPaths(notePath: string): string[] {
    const normalized = notePath.replace(/\\/g, "/");
    const match = /^data\/([^/]+)\/(.+)\.sy$/.exec(normalized);
    if (!match) throw new Error(`Preserve IDs: unsupported document path ${notePath}`);
    const [, notebookId, relative] = match;
    const ids = relative.split("/");
    return ids.map((_, index) => `data/${notebookId}/${ids.slice(0, index + 1).join("/")}.sy`);
}

const documentIdFromPath = (path: string) => path.slice(path.lastIndexOf("/") + 1, -3);
const indexPath = (path: string) => `/${path.replace(/^data\//, "")}`;

export async function transferDocumentsPreservingIds(
    docIds: string[],
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<TransferResult> {
    const uniqueDocIds = [...new Set(docIds)];
    if (!uniqueDocIds.length) return { count: 0, warnings: [] };
    await assertCompatible(source, destination, true);
    const destinationNotebooks = await listNotebooks(destination);
    const paths = new Set<string>();
    const selectedPaths = new Set<string>();
    const checkedNotebookIds = new Set<string>();

    for (const docId of uniqueDocIds) {
        const location = await getDocumentLocation(docId, source);
        selectedPaths.add(location.path);
        const destinationNotebook = destinationNotebooks.find((notebook) => notebook.id === location.notebookId);
        if (!destinationNotebook) {
            throw new Error(`Preserve IDs requires destination notebook ${location.notebookId} to already exist`);
        }
        if (!checkedNotebookIds.has(location.notebookId)) {
            if (destinationNotebook.closed) await openNotebook(destinationNotebook.id, destination);
            if (await isEncryptedNotebook(location.notebookId, source) || await isEncryptedNotebook(location.notebookId, destination)) {
                throw new Error("Preserve IDs does not support encrypted notebooks; use safe transfer mode");
            }
            checkedNotebookIds.add(location.notebookId);
        }
        for (const path of ancestorDocumentPaths(location.path)) paths.add(path);
    }

    const documentsToWrite = new Map<string, string>();
    const assetPaths = new Set<string>();
    for (const path of paths) {
        const content = await readTextFile(path, source);
        if (containsAttributeView(content)) {
            throw new Error("Preserve IDs does not support documents containing attribute views; use safe transfer mode");
        }
        const destinationDocument = await downloadWorkspaceFileIfExists(path, destination);
        if (selectedPaths.has(path) || !destinationDocument) documentsToWrite.set(path, content);
        for (const asset of await getDocumentAssets(documentIdFromPath(path), source)) assetPaths.add(asset);
    }

    const assetsToWrite = new Map<string, Blob>();
    for (const assetPath of assetPaths) {
        const sourceAsset = await downloadWorkspaceFile(assetPath, source);
        const destinationAsset = await downloadWorkspaceFileIfExists(assetPath, destination);
        if (!destinationAsset) {
            assetsToWrite.set(assetPath, sourceAsset);
        } else if (!await blobsEqual(sourceAsset, destinationAsset)) {
            throw new Error(`Preserve IDs aborted before writing because destination asset differs: ${assetPath}`);
        }
    }

    for (const [assetPath, content] of assetsToWrite) await writeFile(assetPath, content, destination);
    for (const [path, content] of documentsToWrite) {
        await writeFile(path, new Blob([content], { type: "application/json" }), destination);
    }

    const indexPaths = [...documentsToWrite.keys()].map(indexPath);
    await updateIndexes(indexPaths, destination);
    return { count: uniqueDocIds.length, warnings: await reloadWarning(destination) };
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
