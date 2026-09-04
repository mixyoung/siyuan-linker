import { listNotebooks as listNotebookData, requestJson, type TargetConnection } from "./siyuan-api";

export interface NotebookOption {
    id: string;
    name: string;
}

export interface FileTreeNode {
    box: string;
    id: string;
    path: string;
    name: string;
    hasChildren: boolean;
    children: FileTreeNode[];
    expanded: boolean;
    loaded: boolean;
    loading: boolean;
}

export async function listNotebooks(target: TargetConnection): Promise<NotebookOption[]> {
    return (await listNotebookData(target)).map(({ id, name }) => ({ id, name }));
}

export async function listDocuments(
    target: TargetConnection,
    notebookId: string,
    path = "/",
): Promise<FileTreeNode[]> {
    const data = await requestJson<unknown>("/api/filetree/listDocsByPath", {
        notebook: notebookId,
        path,
        maxListCount: 0,
        flashcard: false,
    }, "List documents", target);

    if (!data || typeof data !== "object") throw new Error("List documents: invalid response");
    const value = data as Record<string, unknown>;
    if (!Array.isArray(value.files)) throw new Error("List documents: invalid file list");
    const box = typeof value.box === "string" && value.box ? value.box : notebookId;

    return value.files
        .map((file) => {
            if (!file || typeof file !== "object") throw new Error("List documents: invalid document entry");
            const item = file as Record<string, unknown>;
            if (typeof item.id !== "string" || typeof item.path !== "string" || typeof item.name !== "string") {
                throw new Error("List documents: invalid document entry");
            }
            const subFileCount = typeof item.subFileCount === "number" ? item.subFileCount : 0;
            return { item, subFileCount };
        })
        .filter(({ item }) => item.hidden !== true)
        .map(({ item, subFileCount }) => ({
            box,
            id: item.id as string,
            path: item.path as string,
            name: (item.name as string).replace(/\.sy$/, ""),
            hasChildren: subFileCount > 0,
            children: [],
            expanded: false,
            loaded: subFileCount <= 0,
            loading: false,
        }));
}

export type { TargetConnection } from "./siyuan-api";
