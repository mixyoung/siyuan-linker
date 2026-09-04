export interface TargetConnection {
    url: string;
    token: string;
}

export interface NotebookInfo {
    id: string;
    name: string;
    closed?: boolean;
}

export interface DocumentLocation {
    path: string;
    notebookId: string;
}

type SiYuanResponse<T> = {
    code: number;
    msg?: string;
    data: T;
};

const RESPONSE_PREVIEW_LIMIT = 300;

export const endpoint = (path: string, target?: TargetConnection) => `${target?.url ?? ""}${path}`;

export function validateTargetUrl(value: string, allowInsecureHttp = false): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid target URL: ${value}`);
    }
    if (url.username || url.password) throw new Error("Target URL must not contain embedded credentials");
    if (url.search || url.hash) throw new Error("Target URL must not contain a query string or fragment");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Target URL must use HTTPS or HTTP");
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (url.protocol === "http:" && !loopback && !allowInsecureHttp) {
        throw new Error("Remote HTTP is disabled because it exposes tokens and note data; use HTTPS or explicitly allow insecure HTTP");
    }
    return url.toString().replace(/\/+$/, "");
}

export const requestHeaders = (target?: TargetConnection, json = false): Record<string, string> => {
    const result: Record<string, string> = {};
    if (json) result["Content-Type"] = "application/json";
    if (target?.token) result.Authorization = `Token ${target.token}`;
    return result;
};

const responsePreview = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, RESPONSE_PREVIEW_LIMIT);

export async function readApiResponse<T>(response: Response, action: string): Promise<T> {
    let raw: string;
    try {
        raw = await response.text();
    } catch (error) {
        throw new Error(`${action}: failed to read HTTP ${response.status} response (${String(error)})`);
    }

    const preview = responsePreview(raw);
    if (!response.ok) {
        const suffix = preview ? `: ${preview}` : " (empty response)";
        throw new Error(`${action}: HTTP ${response.status} ${response.statusText}${suffix}`);
    }
    if (!raw.trim()) {
        throw new Error(`${action}: HTTP ${response.status} returned an empty response from ${response.url || "the SiYuan API"}`);
    }

    let result: SiYuanResponse<T>;
    try {
        result = JSON.parse(raw) as SiYuanResponse<T>;
    } catch {
        throw new Error(`${action}: invalid JSON from ${response.url || "the SiYuan API"}: ${preview || "empty response"}`);
    }
    if (typeof result.code !== "number") {
        throw new Error(`${action}: invalid SiYuan response from ${response.url || "the SiYuan API"}`);
    }
    if (result.code !== 0) {
        throw new Error(`${action}: ${result.msg || `SiYuan error ${result.code}`}`);
    }
    return result.data;
}

export async function requestJson<T>(
    path: string,
    body: unknown,
    action: string,
    target?: TargetConnection,
): Promise<T> {
    let response: Response;
    try {
        response = await fetch(endpoint(path, target), {
            method: "POST",
            headers: requestHeaders(target, true),
            body: JSON.stringify(body),
        });
    } catch (error) {
        throw new Error(`${action}: network request failed (${error instanceof Error ? error.message : String(error)})`);
    }
    return readApiResponse<T>(response, action);
}

async function readRawResponse(response: Response, action: string): Promise<Blob> {
    if (response.status !== 200) {
        let detail = "";
        try {
            const raw = await response.text();
            detail = responsePreview(raw);
            try {
                const parsed = JSON.parse(raw) as { msg?: unknown };
                if (typeof parsed.msg === "string" && parsed.msg) detail = parsed.msg;
            } catch {
                // Keep the text preview for non-JSON proxy errors.
            }
        } catch {
            detail = "";
        }
        throw new Error(`${action}: HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
    }
    return response.blob();
}

async function requestForm(
    path: string,
    formData: FormData,
    action: string,
    target?: TargetConnection,
): Promise<void> {
    let response: Response;
    try {
        response = await fetch(endpoint(path, target), {
            method: "POST",
            headers: requestHeaders(target),
            body: formData,
        });
    } catch (error) {
        throw new Error(`${action}: network request failed (${error instanceof Error ? error.message : String(error)})`);
    }
    await readApiResponse(response, action);
}

const fetchWorkspaceFile = async (filePath: string, target?: TargetConnection): Promise<Response> => {
    try {
        return await fetch(endpoint("/api/file/getFile", target), {
            method: "POST",
            headers: requestHeaders(target, true),
            body: JSON.stringify({ path: filePath }),
        });
    } catch (error) {
        throw new Error(`Download ${filePath}: network request failed (${error instanceof Error ? error.message : String(error)})`);
    }
};

export async function downloadWorkspaceFile(filePath: string, target?: TargetConnection): Promise<Blob> {
    return readRawResponse(await fetchWorkspaceFile(filePath, target), `Download ${filePath}`);
}

export async function downloadWorkspaceFileIfExists(
    filePath: string,
    target?: TargetConnection,
): Promise<Blob | null> {
    const response = await fetchWorkspaceFile(filePath, target);
    if (response.status === 200) return response.blob();
    if (response.status === 202) {
        const raw = await response.text();
        try {
            const result = JSON.parse(raw) as { code?: unknown; msg?: unknown };
            if (result.code === 404) return null;
            const detail = typeof result.msg === "string" ? result.msg : responsePreview(raw);
            throw new Error(`Download ${filePath}: HTTP 202 Accepted${detail ? `: ${detail}` : ""}`);
        } catch (error) {
            if (error instanceof Error && error.message.startsWith(`Download ${filePath}:`)) throw error;
            throw new Error(`Download ${filePath}: invalid JSON in HTTP 202 response`);
        }
    }
    return readRawResponse(response, `Download ${filePath}`);
}

export async function downloadExportArchive(exportPath: string, target?: TargetConnection): Promise<Blob> {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(exportPath);
    } catch {
        throw new Error(`Download export archive: invalid export path ${exportPath}`);
    }
    const invalidSegments = decodedPath.split("/").some((segment) => segment === "..");
    if (!exportPath.startsWith("/export/") || invalidSegments || /[\\\0\r\n?#]/.test(decodedPath)) {
        throw new Error(`Download export archive: invalid export path ${exportPath}`);
    }
    let response: Response;
    try {
        response = await fetch(endpoint(exportPath, target), {
            method: "GET",
            headers: requestHeaders(target),
        });
    } catch (error) {
        throw new Error(`Download export archive: network request failed (${error instanceof Error ? error.message : String(error)})`);
    }
    const blob = await readRawResponse(response, "Download export archive");
    await assertZipArchive(blob, "Download export archive");
    return blob;
}

export async function assertZipArchive(blob: Blob, action: string): Promise<void> {
    if (blob.size < 4) throw new Error(`${action}: received an empty or truncated archive`);
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const valid = signature[0] === 0x50 && signature[1] === 0x4b && (
        (signature[2] === 0x03 && signature[3] === 0x04) ||
        (signature[2] === 0x05 && signature[3] === 0x06) ||
        (signature[2] === 0x07 && signature[3] === 0x08)
    );
    if (!valid) throw new Error(`${action}: response is not a ZIP archive`);
}

export async function getSystemVersion(target?: TargetConnection): Promise<string> {
    const data = await requestJson<unknown>("/api/system/version", {}, "Get SiYuan version", target);
    if (typeof data !== "string" || !data.trim()) throw new Error("Get SiYuan version: invalid version response");
    return data.trim().replace(/^v/i, "");
}

export function compareVersions(left: string, right: string): number {
    const parse = (value: string) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.replace(/^v/i, ""));
        if (!match) throw new Error(`Invalid SiYuan version: ${value}`);
        return {
            parts: match.slice(1, 4).map(Number),
            prerelease: match[4] ?? "",
        };
    };
    const leftVersion = parse(left);
    const rightVersion = parse(right);
    for (let index = 0; index < 3; index += 1) {
        const difference = leftVersion.parts[index] - rightVersion.parts[index];
        if (difference !== 0) return Math.sign(difference);
    }
    if (leftVersion.prerelease === rightVersion.prerelease) return 0;
    if (!leftVersion.prerelease) return 1;
    if (!rightVersion.prerelease) return -1;
    const leftIdentifiers = leftVersion.prerelease.split(".");
    const rightIdentifiers = rightVersion.prerelease.split(".");
    for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
        if (leftIdentifiers[index] === undefined) return -1;
        if (rightIdentifiers[index] === undefined) return 1;
        if (leftIdentifiers[index] === rightIdentifiers[index]) continue;
        const leftNumeric = /^\d+$/.test(leftIdentifiers[index]);
        const rightNumeric = /^\d+$/.test(rightIdentifiers[index]);
        if (leftNumeric && rightNumeric) return Math.sign(Number(leftIdentifiers[index]) - Number(rightIdentifiers[index]));
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifiers[index].localeCompare(rightIdentifiers[index]);
    }
    return 0;
}

export async function listNotebooks(target?: TargetConnection): Promise<NotebookInfo[]> {
    const data = await requestJson<{ notebooks?: unknown }>("/api/notebook/lsNotebooks", {}, "List notebooks", target);
    if (!Array.isArray(data?.notebooks)) throw new Error("List notebooks: invalid notebook list response");
    return data.notebooks.map((notebook) => {
        if (!notebook || typeof notebook !== "object") throw new Error("List notebooks: invalid notebook entry");
        const value = notebook as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.name !== "string") throw new Error("List notebooks: invalid notebook entry");
        return { id: value.id, name: value.name, closed: Boolean(value.closed) };
    });
}

export async function createNotebook(name: string, target?: TargetConnection): Promise<NotebookInfo> {
    const data = await requestJson<{ notebook?: unknown }>("/api/notebook/createNotebook", { name }, `Create notebook ${name}`, target);
    const notebook = data?.notebook;
    if (!notebook || typeof notebook !== "object") throw new Error(`Create notebook ${name}: invalid response`);
    const value = notebook as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.name !== "string") throw new Error(`Create notebook ${name}: invalid response`);
    return { id: value.id, name: value.name, closed: Boolean(value.closed) };
}

export async function openNotebook(notebookId: string, target?: TargetConnection): Promise<void> {
    await requestJson("/api/notebook/openNotebook", { notebook: notebookId }, `Open notebook ${notebookId}`, target);
}

export async function ensureNotebook(name: string, target?: TargetConnection): Promise<NotebookInfo> {
    const matches = (await listNotebooks(target)).filter((notebook) => notebook.name === name);
    if (matches.length > 1) throw new Error(`Multiple destination notebooks are named ${name}; rename duplicates before transferring`);
    const existing = matches[0];
    if (!existing) return createNotebook(name, target);
    if (existing.closed) {
        await openNotebook(existing.id, target);
        return { ...existing, closed: false };
    }
    return existing;
}

export async function getDocumentLocation(docId: string, target?: TargetConnection): Promise<DocumentLocation> {
    const id = docId.endsWith(".sy") ? docId.slice(0, -3) : docId;
    const data = await requestJson<{ box?: unknown; path?: unknown }>(
        "/api/filetree/getDoc",
        { id },
        "Get document location",
        target,
    );
    if (typeof data?.box !== "string" || typeof data?.path !== "string") {
        throw new Error("Get document location: invalid document response");
    }
    return { notebookId: data.box, path: `data/${data.box}${data.path}` };
}

export async function getNotebookName(notebookId: string, target?: TargetConnection): Promise<string> {
    const data = await requestJson<{ name?: unknown; conf?: { name?: unknown } }>(
        "/api/notebook/getNotebookConf",
        { notebook: notebookId },
        "Get notebook name",
        target,
    );
    const name = typeof data?.name === "string" ? data.name : data?.conf?.name;
    if (typeof name !== "string" || !name) throw new Error("Get notebook name: invalid notebook response");
    return name;
}

export async function isEncryptedNotebook(notebookId: string, target?: TargetConnection): Promise<boolean> {
    const data = await requestJson<{ boxes?: unknown }>(
        "/api/notebook/getEncryptedNotebookStatus",
        {},
        "Check encrypted notebooks",
        target,
    );
    if (!Array.isArray(data?.boxes)) throw new Error("Check encrypted notebooks: invalid response");
    return data.boxes.some((box) => box && typeof box === "object" && (box as Record<string, unknown>).id === notebookId);
}

export async function exportDocuments(docIds: string[], target?: TargetConnection): Promise<string> {
    if (!docIds.length) throw new Error("Export documents: no documents selected");
    const path = docIds.length === 1 ? "/api/export/exportSY" : "/api/export/exportSYs";
    const body = docIds.length === 1 ? { id: docIds[0] } : { ids: docIds };
    const data = await requestJson<{ zip?: unknown }>(path, body, "Export documents", target);
    if (typeof data?.zip !== "string") throw new Error("Export documents: invalid archive path");
    return data.zip;
}

export async function importDocuments(
    archive: Blob,
    notebookId: string,
    target?: TargetConnection,
    toPath = "/",
): Promise<void> {
    await assertZipArchive(archive, "Import documents");
    const formData = new FormData();
    formData.append("file", new File([archive], "documents.sy.zip", { type: "application/zip" }));
    formData.append("notebook", notebookId);
    formData.append("toPath", toPath);
    await requestForm("/api/import/importSY", formData, "Import documents", target);
}

export async function exportAllData(target?: TargetConnection): Promise<string> {
    const data = await requestJson<{ zip?: unknown }>("/api/export/exportData", {}, "Export all data", target);
    if (typeof data?.zip !== "string") throw new Error("Export all data: invalid archive path");
    return data.zip;
}

export async function importAllData(archive: Blob, target?: TargetConnection): Promise<void> {
    await assertZipArchive(archive, "Import all data");
    const formData = new FormData();
    formData.append("file", new File([archive], "data.zip", { type: "application/zip" }));
    await requestForm("/api/import/importData", formData, "Import all data", target);
}

export async function reloadFileTree(target?: TargetConnection): Promise<void> {
    await requestJson("/api/ui/reloadFiletree", {}, "Reload file tree", target);
}

export async function readTextFile(filePath: string, target?: TargetConnection): Promise<string> {
    return (await downloadWorkspaceFile(filePath, target)).text();
}

export async function writeFile(filePath: string, content: Blob, target?: TargetConnection): Promise<void> {
    const formData = new FormData();
    formData.append("path", filePath);
    formData.append("isDir", "false");
    formData.append("modTime", String(Date.now()));
    formData.append("file", content);
    await requestForm("/api/file/putFile", formData, `Write file ${filePath}`, target);
}

export function normalizeAssetPath(path: string): string {
    if (path.includes("\\") || path.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new Error(`List document assets: unsupported asset path ${path}`);
    }
    const normalized = path.replace(/^\/+/, "").replace(/^data\//, "");
    if (!normalized.startsWith("assets/") || normalized.split("/").includes("..")) {
        throw new Error(`List document assets: unsupported asset path ${path}`);
    }
    return `data/${normalized}`;
}

export async function getDocumentAssets(docId: string, target?: TargetConnection): Promise<string[]> {
    const data = await requestJson<unknown>(
        "/api/asset/getDocAssets",
        { id: docId, retainQueryStr: false },
        "List document assets",
        target,
    );
    if (!Array.isArray(data) || data.some((path) => typeof path !== "string")) {
        throw new Error("List document assets: invalid asset list response");
    }
    return [...new Set(data.map((path) => normalizeAssetPath(String(path))))];
}

export async function updateIndexes(paths: string[], target?: TargetConnection): Promise<void> {
    if (!paths.length) return;
    await requestJson("/api/filetree/removeIndexes", { paths }, "Remove old document indexes", target);
    await requestJson("/api/filetree/upsertIndexes", { paths }, "Update document indexes", target);
}
