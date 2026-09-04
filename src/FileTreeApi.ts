import type { TargetConnection } from "./myapi";

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

type SiYuanResponse<T> = {
    code: number;
    msg?: string;
    data: T;
};

const request = async <T>(target: TargetConnection, path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${target.url}${path}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `token ${target.token}`,
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const result = await response.json() as SiYuanResponse<T>;
    if (result.code !== 0) {
        throw new Error(result.msg || `SiYuan error ${result.code}`);
    }
    return result.data;
};

export async function listNotebooks(target: TargetConnection): Promise<NotebookOption[]> {
    const data = await request<{ notebooks: NotebookOption[] }>(
        target,
        "/api/notebook/lsNotebooks",
        {},
    );
    return data.notebooks;
}

export async function listDocuments(
    target: TargetConnection,
    notebookId: string,
    path = "/",
): Promise<FileTreeNode[]> {
    const data = await request<{
        box: string;
        files: Array<{
            id: string;
            path: string;
            name: string;
            subFileCount: number;
            hidden?: boolean;
        }>;
    }>(target, "/api/filetree/listDocsByPath", {
        notebook: notebookId,
        path,
        maxListCount: 0,
        flashcard: false,
    });

    return data.files
        .filter((file) => !file.hidden)
        .map((file) => ({
            box: data.box || notebookId,
            id: file.id,
            path: file.path,
            name: file.name.replace(/\.sy$/, ""),
            hasChildren: file.subFileCount > 0,
            children: [],
            expanded: false,
            loaded: file.subFileCount === 0,
            loading: false,
        }));
}
