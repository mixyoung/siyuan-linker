export interface TargetConnection {
    url: string;
    token: string;
}

export interface DocumentLocation {
    path: string;
    notebookId: string;
}

type SiYuanResponse<T = unknown> = {
    code: number;
    msg?: string;
    data: T;
};

const normalizeDocId = (docId: string) => docId.endsWith(".sy") ? docId.slice(0, -3) : docId;

const endpoint = (path: string, target?: TargetConnection) => `${target?.url ?? ""}${path}`;

const headers = (target?: TargetConnection, json = false) => {
    const result: Record<string, string> = {};
    if (json) {
        result["Content-Type"] = "application/json";
    }
    if (target?.token) {
        result.Authorization = `token ${target.token}`;
    }
    return result;
};

async function readApiResponse<T>(response: Response, action: string): Promise<T> {
    if (!response.ok) {
        throw new Error(`${action}: HTTP ${response.status} ${response.statusText}`);
    }
    const result = await response.json() as SiYuanResponse<T>;
    if (result.code !== 0) {
        throw new Error(`${action}: ${result.msg || `SiYuan error ${result.code}`}`);
    }
    return result.data;
}

export async function isconnect(target: TargetConnection): Promise<boolean> {
    try {
        const response = await fetch(endpoint("/api/notebook/lsNotebooks", target), {
            method: "POST",
            headers: headers(target, true),
            body: JSON.stringify({}),
        });
        await readApiResponse(response, "Connect to target");
        return true;
    } catch (error) {
        console.error("Failed to connect to target:", error);
        return false;
    }
}

export async function getDocumentLocation(docId: string, target?: TargetConnection): Promise<DocumentLocation> {
    const response = await fetch(endpoint("/api/filetree/getDoc", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({ id: normalizeDocId(docId) }),
    });
    const data = await readApiResponse<{ box: string; path: string }>(response, "Get document location");
    return {
        notebookId: data.box,
        path: `data/${data.box}${data.path}`,
    };
}

export async function getNoteData(notePath: string, target?: TargetConnection): Promise<string> {
    const response = await fetch(endpoint("/api/file/getFile", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({ path: notePath }),
    });
    if (response.status !== 200) {
        throw new Error(`Get note data: HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
}

export async function getNotebookName(notebookId: string, target?: TargetConnection): Promise<string> {
    const response = await fetch(endpoint("/api/notebook/getNotebookConf", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({ notebook: notebookId }),
    });
    const data = await readApiResponse<{ conf: { name: string } }>(response, "Get notebook name");
    return data.conf.name;
}

export async function setNotebookConf(
    notebookId: string,
    name: string,
    target?: TargetConnection,
): Promise<void> {
    const response = await fetch(endpoint("/api/notebook/setNotebookConf", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({
            notebook: notebookId,
            conf: { name, closed: false },
        }),
    });
    await readApiResponse(response, "Set notebook configuration");
}

export async function getResourceLinks(docId: string, target?: TargetConnection): Promise<string[]> {
    const response = await fetch(endpoint("/api/export/exportMdContent", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({ id: normalizeDocId(docId) }),
    });
    const data = await readApiResponse<{ content: string }>(response, "Export Markdown content");
    return extractResourceLinks(data.content);
}

export function extractResourceLinks(content: string): string[] {
    const regex = /\[.*?\]\((assets\/.*?)\)/g;
    const links = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        links.add(`data/${match[1]}`);
    }
    return [...links];
}

export async function downloadFile(filePath: string, target?: TargetConnection): Promise<Blob> {
    const response = await fetch(endpoint("/api/file/getFile", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({ path: filePath }),
    });
    if (response.status !== 200) {
        throw new Error(`Download file: HTTP ${response.status} ${response.statusText}`);
    }
    return response.blob();
}

export async function putTextFile(filePath: string, content: string, target?: TargetConnection): Promise<void> {
    await putFile(filePath, new Blob([content], { type: "text/plain" }), target);
}

export async function putBinaryFile(filePath: string, content: Blob, target?: TargetConnection): Promise<void> {
    await putFile(filePath, content, target);
}

async function putFile(filePath: string, content: Blob, target?: TargetConnection): Promise<void> {
    const formData = new FormData();
    formData.append("path", filePath);
    formData.append("file", content);
    formData.append("isDir", "false");

    const response = await fetch(endpoint("/api/file/putFile", target), {
        method: "POST",
        headers: headers(target),
        body: formData,
    });
    await readApiResponse(response, `Write file ${filePath}`);
}

const extractDatabaseResourcePaths = (content: string): string[] => {
    const regex = /"AttributeViewID":\s*"([^"]+)"/g;
    const paths = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        paths.add(`data/storage/av/${match[1]}.json`);
    }
    return [...paths];
};

export async function transferDatabaseResources(
    noteContent: string,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<number> {
    const paths = extractDatabaseResourcePaths(noteContent);
    for (const path of paths) {
        const data = await getNoteData(path, source);
        await putTextFile(path, data, destination);
    }
    return paths.length;
}

export function markTransferredReadonly(jsonString: string): string {
    const document = JSON.parse(jsonString);
    document.Properties ??= {};
    document.Properties["custom-sy-readonly"] = "true";
    return JSON.stringify(document);
}

export async function refreshFileTree(target?: TargetConnection): Promise<void> {
    const response = await fetch(endpoint("/api/filetree/refreshFiletree", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({}),
    });
    await readApiResponse(response, "Refresh file tree");
}

export async function exportAllData(target?: TargetConnection): Promise<string> {
    const response = await fetch(endpoint("/api/export/exportData", target), {
        method: "POST",
        headers: headers(target, true),
        body: JSON.stringify({}),
    });
    const data = await readApiResponse<{ zip: string }>(response, "Export all data");
    return decodeURIComponent(`/temp${data.zip}`);
}

export async function importAllData(blob: Blob, target?: TargetConnection): Promise<void> {
    const formData = new FormData();
    formData.append("file", new File([blob], "data.zip", { type: "application/zip" }));
    const response = await fetch(endpoint("/api/import/importData", target), {
        method: "POST",
        headers: headers(target),
        body: formData,
    });
    await readApiResponse(response, "Import all data");
}
