import {
    assertNodeId,
    getDocumentLocation,
    listNotebooks,
    readonlySql,
    type TargetConnection,
} from "./siyuan-api";
import {
    captureDocumentSnapshot,
} from "./mirror-service";
import {
    inspectMirrorPair,
    readWorkspaceIdentity,
} from "./mirror-storage";
import type {
    DocumentRootSelection,
    NotebookMapping,
    ScopeSnapshot,
    ScopeSnapshotItem,
    SyncProfile,
    SyncScopeAdapter,
} from "./sync-types";

export function buildLogicalPath(notebookId: string, rawPath: string): string {
    let p = rawPath.trim();
    if (p.startsWith("data/")) {
        const segments = p.split("/");
        if (segments.length >= 3 && segments[1] === notebookId) {
            return segments.slice(2).join("/");
        }
    }
    if (p.startsWith("/")) {
        p = p.slice(1);
    }
    return p;
}

export function ancestorEntries(path: string): Array<{ documentId: string; path: string; parentId: string; depth: number }> {
    const match = /^data\/([^/]+)\/(.+\.sy)$/.exec(path);
    if (!match) {
        const clean = path.replace(/^\/+/, "");
        const segments = clean.split("/");
        return segments.map((segment, index) => {
            const documentId = segment.replace(/\.sy$/, "");
            assertNodeId(documentId, "document path ID");
            const parentId = index ? segments[index - 1].replace(/\.sy$/, "") : "";
            const documentSegments = segments.slice(0, index + 1);
            return { documentId, path: `data/unknown/${documentSegments.join("/")}`, parentId, depth: index };
        });
    }
    const [, notebookId, relative] = match;
    const segments = relative.split("/");
    return segments.map((segment, index) => {
        const documentId = segment.replace(/\.sy$/, "");
        assertNodeId(documentId, "document path ID");
        const parentId = index ? segments[index - 1].replace(/\.sy$/, "") : "";
        const documentSegments = segments.slice(0, index + 1);
        return { documentId, path: `data/${notebookId}/${documentSegments.join("/")}`, parentId, depth: index };
    });
}

interface DocSqlRow {
    id: string;
    parent_id: string;
    root_id: string;
    box: string;
    path: string;
    hpath: string;
}

async function fetchNotebookDocRows(notebookId: string, target?: TargetConnection): Promise<DocSqlRow[]> {
    try {
        const rows = await readonlySql(
            `SELECT id, parent_id, root_id, box, path, hpath FROM blocks WHERE type = 'd' AND box = '${notebookId}'`,
            target,
        );
        return rows.map((r) => ({
            id: String(r.id),
            parent_id: String(r.parent_id ?? ""),
            root_id: String(r.root_id ?? ""),
            box: String(r.box ?? ""),
            path: String(r.path ?? ""),
            hpath: String(r.hpath ?? ""),
        }));
    } catch {
        return [];
    }
}

export function collectDescendantIds(rootDocId: string, rows: DocSqlRow[]): string[] {
    const childrenByParent = new Map<string, string[]>();
    for (const r of rows) {
        if (r.parent_id) {
            const list = childrenByParent.get(r.parent_id) ?? [];
            list.push(r.id);
            childrenByParent.set(r.parent_id, list);
        }
    }

    const descendants: string[] = [];
    const queue = [rootDocId];
    while (queue.length > 0) {
        const current = queue.shift()!;
        const children = childrenByParent.get(current) ?? [];
        for (const childId of children) {
            if (!descendants.includes(childId)) {
                descendants.push(childId);
                queue.push(childId);
            }
        }
    }
    return descendants;
}

export class BaseScopeAdapter {
    constructor(
        protected readonly source: TargetConnection | undefined,
        protected readonly destination: TargetConnection | undefined,
        protected readonly notebookMappings: NotebookMapping[] = [],
    ) {}

    public buildLogicalPath(notebookId: string, path: string): string {
        return buildLogicalPath(notebookId, path);
    }

    public async validateCapabilities(): Promise<void> {
        const [sourceIdentity, destIdentity] = await Promise.all([
            readWorkspaceIdentity(this.source),
            readWorkspaceIdentity(this.destination),
        ]);
        if (!sourceIdentity) throw new Error("Source workspace identity is missing");
        if (!destIdentity) throw new Error("Destination workspace identity is missing");

        const status = await inspectMirrorPair(this.source, this.destination);
        if (!status.valid) {
            throw new Error(`Sync adapter requires a valid pair: ${status.reasons.join("; ")}`);
        }
    }

    protected resolveDestinationNotebookId(sourceNotebookId: string): string {
        const mapping = this.notebookMappings.find((m) => m.localNotebookId === sourceNotebookId);
        return mapping ? mapping.remoteNotebookId : sourceNotebookId;
    }

    protected resolveSourceNotebookId(destNotebookId: string): string {
        const mapping = this.notebookMappings.find((m) => m.remoteNotebookId === destNotebookId);
        return mapping ? mapping.localNotebookId : destNotebookId;
    }
}

export class DocumentScopeAdapter extends BaseScopeAdapter implements SyncScopeAdapter {
    constructor(
        source: TargetConnection | undefined,
        destination: TargetConnection | undefined,
        private readonly documentRoots: DocumentRootSelection[],
        notebookMappings: NotebookMapping[] = [],
    ) {
        super(source, destination, notebookMappings);
    }

    public async captureSource(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.source);
        const notebooks = await listNotebooks(this.source);
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        const selectedDocIds = new Set<string>();
        const ancestorDocEntries = new Map<string, { documentId: string; path: string; parentId: string; depth: number }>();

        for (const root of this.documentRoots) {
            assertNodeId(root.documentId, "document root ID");
            selectedDocIds.add(root.documentId);

            const loc = await getDocumentLocation(root.documentId, this.source);
            for (const anc of ancestorEntries(loc.path)) {
                if (!ancestorDocEntries.has(anc.documentId)) {
                    ancestorDocEntries.set(anc.documentId, anc);
                }
            }

            if (root.includeDescendants) {
                const rows = await fetchNotebookDocRows(loc.notebookId, this.source);
                const descendantIds = collectDescendantIds(root.documentId, rows);
                for (const descId of descendantIds) {
                    selectedDocIds.add(descId);
                }
            }
        }

        const allDocIdsToCapture = new Set<string>([...ancestorDocEntries.keys(), ...selectedDocIds]);

        for (const docId of allDocIdsToCapture) {
            const snapshot = await captureDocumentSnapshot(docId, this.source);
            const logicalPath = this.buildLogicalPath(snapshot.notebookId, snapshot.path);
            const ancestorEntry = ancestorDocEntries.get(docId);
            const depth = ancestorEntry?.depth ?? (snapshot.path.split("/").length - 2);
            const parentId = ancestorEntry?.parentId ?? "";

            items.set(docId, {
                id: docId,
                objectType: "document",
                notebookId: snapshot.notebookId,
                path: snapshot.path,
                logicalPath,
                hpath: snapshot.hpath,
                depth,
                parentId,
                snapshot,
            });

            for (const asset of snapshot.assets) {
                assets.set(asset.path, asset);
            }
        }

        return {
            scope: "document",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }

    public async captureDestination(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.destination);
        const notebooks = await listNotebooks(this.destination);
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        // Capture source first to know which document IDs to query in destination
        const sourceSnapshot = await this.captureSource();

        for (const [docId, sourceItem] of sourceSnapshot.items) {
            try {
                const snapshot = await captureDocumentSnapshot(docId, this.destination);
                const logicalPath = this.buildLogicalPath(snapshot.notebookId, snapshot.path);

                items.set(docId, {
                    id: docId,
                    objectType: "document",
                    notebookId: snapshot.notebookId,
                    path: snapshot.path,
                    logicalPath,
                    hpath: snapshot.hpath,
                    depth: sourceItem.depth,
                    parentId: sourceItem.parentId,
                    snapshot,
                });

                for (const asset of snapshot.assets) {
                    assets.set(asset.path, asset);
                }
            } catch {
                // Document does not exist on destination
            }
        }

        return {
            scope: "document",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }
}

export class NotebookScopeAdapter extends BaseScopeAdapter implements SyncScopeAdapter {
    constructor(
        source: TargetConnection | undefined,
        destination: TargetConnection | undefined,
        notebookMappings: NotebookMapping[],
    ) {
        super(source, destination, notebookMappings);
    }

    public async captureSource(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.source);
        const allNotebooks = await listNotebooks(this.source);
        const sourceNbIds = new Set(this.notebookMappings.map((m) => m.localNotebookId));
        const notebooks = allNotebooks.filter((nb) => sourceNbIds.has(nb.id));
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        for (const nb of notebooks) {
            const rows = await fetchNotebookDocRows(nb.id, this.source);
            for (const r of rows) {
                try {
                    const snapshot = await captureDocumentSnapshot(r.id, this.source);
                    const logicalPath = this.buildLogicalPath(nb.id, snapshot.path);
                    const depth = snapshot.path.split("/").length - 2;

                    items.set(r.id, {
                        id: r.id,
                        objectType: "document",
                        notebookId: nb.id,
                        path: snapshot.path,
                        logicalPath,
                        hpath: snapshot.hpath,
                        depth,
                        parentId: r.parent_id,
                        snapshot,
                    });

                    for (const asset of snapshot.assets) {
                        assets.set(asset.path, asset);
                    }
                } catch {
                    // Skip unreadable doc
                }
            }
        }

        return {
            scope: "notebook",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }

    public async captureDestination(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.destination);
        const allNotebooks = await listNotebooks(this.destination);
        const destNbIds = new Set(this.notebookMappings.map((m) => m.remoteNotebookId));
        const notebooks = allNotebooks.filter((nb) => destNbIds.has(nb.id));
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        for (const nb of notebooks) {
            const rows = await fetchNotebookDocRows(nb.id, this.destination);
            for (const r of rows) {
                try {
                    const snapshot = await captureDocumentSnapshot(r.id, this.destination);
                    const logicalPath = this.buildLogicalPath(nb.id, snapshot.path);
                    const depth = snapshot.path.split("/").length - 2;

                    items.set(r.id, {
                        id: r.id,
                        objectType: "document",
                        notebookId: nb.id,
                        path: snapshot.path,
                        logicalPath,
                        hpath: snapshot.hpath,
                        depth,
                        parentId: r.parent_id,
                        snapshot,
                    });

                    for (const asset of snapshot.assets) {
                        assets.set(asset.path, asset);
                    }
                } catch {
                    // Skip unreadable doc
                }
            }
        }

        return {
            scope: "notebook",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }
}

export class WorkspaceScopeAdapter extends BaseScopeAdapter implements SyncScopeAdapter {
    public async captureSource(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.source);
        const notebooks = await listNotebooks(this.source);
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        for (const nb of notebooks) {
            const rows = await fetchNotebookDocRows(nb.id, this.source);
            for (const r of rows) {
                try {
                    const snapshot = await captureDocumentSnapshot(r.id, this.source);
                    const logicalPath = this.buildLogicalPath(nb.id, snapshot.path);
                    const depth = snapshot.path.split("/").length - 2;

                    items.set(r.id, {
                        id: r.id,
                        objectType: "document",
                        notebookId: nb.id,
                        path: snapshot.path,
                        logicalPath,
                        hpath: snapshot.hpath,
                        depth,
                        parentId: r.parent_id,
                        snapshot,
                    });

                    for (const asset of snapshot.assets) {
                        assets.set(asset.path, asset);
                    }
                } catch {
                    // Skip unreadable doc
                }
            }
        }

        return {
            scope: "workspace",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }

    public async captureDestination(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.destination);
        const notebooks = await listNotebooks(this.destination);
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        for (const nb of notebooks) {
            const rows = await fetchNotebookDocRows(nb.id, this.destination);
            for (const r of rows) {
                try {
                    const snapshot = await captureDocumentSnapshot(r.id, this.destination);
                    const logicalPath = this.buildLogicalPath(nb.id, snapshot.path);
                    const depth = snapshot.path.split("/").length - 2;

                    items.set(r.id, {
                        id: r.id,
                        objectType: "document",
                        notebookId: nb.id,
                        path: snapshot.path,
                        logicalPath,
                        hpath: snapshot.hpath,
                        depth,
                        parentId: r.parent_id,
                        snapshot,
                    });

                    for (const asset of snapshot.assets) {
                        assets.set(asset.path, asset);
                    }
                } catch {
                    // Skip unreadable doc
                }
            }
        }

        return {
            scope: "workspace",
            workspaceId: identity?.workspaceId ?? "",
            notebooks,
            items,
            assets,
        };
    }
}

export function createScopeAdapter(
    profile: SyncProfile,
    source?: TargetConnection,
    destination?: TargetConnection,
): SyncScopeAdapter {
    switch (profile.scope) {
        case "document":
            return new DocumentScopeAdapter(source, destination, profile.documentRoots, profile.notebookMappings);
        case "notebook":
            return new NotebookScopeAdapter(source, destination, profile.notebookMappings);
        case "workspace":
            return new WorkspaceScopeAdapter(source, destination, profile.notebookMappings);
        default:
            throw new Error(`Unsupported sync scope: ${(profile as { scope: string }).scope}`);
    }
}
