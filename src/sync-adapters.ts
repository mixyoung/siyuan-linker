import {
    assertNodeId,
    assertNotebookId,
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

// SQL block paths keep intermediate parents without the ".sy" suffix
// ("/root/child.sy") while workspace paths carry it on every segment
// ("root.sy/child.sy"). Normalize SQL paths to the workspace form so logical
// comparisons use one canonical shape.
export function sqlPathToLogical(sqlPath: string): string {
    return sqlPath
        .split("/")
        .filter(Boolean)
        .map((segment) => (segment.endsWith(".sy") ? segment : `${segment}.sy`))
        .join("/");
}

export function ancestorEntries(path: string): Array<{ documentId: string; path: string; parentId: string; depth: number }> {    const match = /^data\/([^/]+)\/(.+\.sy)$/.exec(path);
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

// Enumerates the documents of one notebook on one endpoint. Errors MUST
// propagate: swallowing them would present a real notebook as empty and,
// under a propagating deletion policy, plan a mass delete (engine fix E5).
async function fetchNotebookDocRows(notebookId: string, target?: TargetConnection): Promise<DocSqlRow[]> {
    const safeNotebookId = assertNotebookId(notebookId);
    const rows = await readonlySql(
        `SELECT id, parent_id, root_id, box, path, hpath FROM blocks WHERE type = 'd' AND box = '${safeNotebookId}'`,
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

async function captureRowsIntoSnapshot(
    rows: DocSqlRow[],
    notebookId: string,
    target: TargetConnection | undefined,
    items: Map<string, ScopeSnapshotItem>,
    assets: Map<string, { path: string; sha256: string; content?: Blob }>,
): Promise<void> {
    for (const r of rows) {
        // Capture failures propagate: a doc that cannot be read is an error,
        // not an absent document (engine fix E5).
        const snapshot = await captureDocumentSnapshot(r.id, target);
        const logicalPath = buildLogicalPath(notebookId, snapshot.path);
        const depth = snapshot.path.split("/").length - 2;

        items.set(r.id, {
            id: r.id,
            objectType: "document",
            notebookId,
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
    }
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
    private selectedDocIds = new Set<string>();
    private selectedSubtrees: Array<{ logicalPath: string; includeDescendants: boolean }> = [];

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

        this.selectedDocIds = new Set<string>();
        this.selectedSubtrees = [];
        const ancestorDocEntries = new Map<string, { documentId: string; path: string; parentId: string; depth: number }>();

        for (const root of this.documentRoots) {
            assertNodeId(root.documentId, "document root ID");
            this.selectedDocIds.add(root.documentId);

            const loc = await getDocumentLocation(root.documentId, this.source);
            for (const anc of ancestorEntries(loc.path)) {
                if (!ancestorDocEntries.has(anc.documentId)) {
                    ancestorDocEntries.set(anc.documentId, anc);
                }
            }
            this.selectedSubtrees.push({
                logicalPath: buildLogicalPath(loc.notebookId, loc.path),
                includeDescendants: root.includeDescendants,
            });

            if (root.includeDescendants) {
                const rows = await fetchNotebookDocRows(loc.notebookId, this.source);
                const descendantIds = collectDescendantIds(root.documentId, rows);
                for (const descId of descendantIds) {
                    this.selectedDocIds.add(descId);
                }
            }
        }

        const allDocIdsToCapture = new Set<string>([...ancestorDocEntries.keys(), ...this.selectedDocIds]);

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

    // The destination snapshot must be enumerated INDEPENDENTLY of the source
    // ID set: destination-only descendants (the pull direction) and genuinely
    // absent documents must be distinguishable, and enumeration errors must
    // surface instead of masquerading as "document missing" (engine fix E1).
    public async captureDestination(): Promise<ScopeSnapshot> {
        const identity = await readWorkspaceIdentity(this.destination);
        const notebooks = await listNotebooks(this.destination);
        const items = new Map<string, ScopeSnapshotItem>();
        const assets = new Map<string, { path: string; sha256: string; content?: Blob }>();

        // Selection subtrees were recorded in logical (notebook-independent)
        // form during captureSource; translate each through the mapping to
        // the destination notebook and enumerate that notebook directly.
        const requiredNotebooks = new Map<string, string>(); // source notebook -> destination notebook
        for (const root of this.documentRoots) {
            const loc = await getDocumentLocation(root.documentId, this.source);
            requiredNotebooks.set(loc.notebookId, this.resolveDestinationNotebookId(loc.notebookId));
        }

        const includedIds = new Set<string>(this.selectedDocIds);
        for (const [sourceNotebookId, destNotebookId] of requiredNotebooks) {
            const rows = await fetchNotebookDocRows(destNotebookId, this.destination);
            const rowsById = new Map(rows.map((row) => [row.id, row]));
            const rowsByLogical = new Map(rows.map((row) => [sqlPathToLogical(row.path), row]));

            for (const subtree of this.selectedSubtrees) {
                const subtreeRoot = subtree.logicalPath;
                const rootRow = rowsByLogical.get(subtreeRoot);
                if (rootRow) includedIds.add(rootRow.id);
                if (!subtree.includeDescendants) continue;
                for (const [logical, row] of rowsByLogical) {
                    if (logical === subtreeRoot || logical.startsWith(`${subtreeRoot}/`)) {
                        includedIds.add(row.id);
                    }
                }
            }

            // Ancestors of any included document must be captured as well so
            // the planner can reason about the full tree shape.
            for (const row of rows) {
                if (!includedIds.has(row.id)) continue;
                let walker = row.parent_id;
                const guard = new Set<string>();
                while (walker && !guard.has(walker)) {
                    guard.add(walker);
                    includedIds.add(walker);
                    walker = rowsById.get(walker)?.parent_id ?? "";
                }
            }

            const selectedRows = rows.filter((row) => includedIds.has(row.id));
            await captureRowsIntoSnapshot(selectedRows, destNotebookId, this.destination, items, assets);
            void sourceNotebookId;
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
            await captureRowsIntoSnapshot(rows, nb.id, this.source, items, assets);
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
            await captureRowsIntoSnapshot(rows, nb.id, this.destination, items, assets);
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
            await captureRowsIntoSnapshot(rows, nb.id, this.source, items, assets);
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
            await captureRowsIntoSnapshot(rows, nb.id, this.destination, items, assets);
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
