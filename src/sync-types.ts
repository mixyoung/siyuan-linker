import type {
    AssetFingerprint,
    MirrorConflictClassification,
    MirrorDocumentBaseline,
    MirrorDocumentSnapshot,
} from "./mirror-types";

export type SyncScope = "workspace" | "notebook" | "document";
export type SyncDirection = "push" | "pull" | "bidirectional";
export type SyncTrigger = "manual" | "scheduled";

export type ConflictPolicy =
    | "stop"
    | "authority-wins"
    | "manual";

export type ConflictAuthority =
    | "direction-source"
    | "local"
    | "remote";

export type DeletionPolicy =
    | "ignore"
    | "archive-and-delete"
    | "mirror-delete";

export interface NotebookMapping {
    localNotebookId: string;
    remoteNotebookId: string;
}

export interface DocumentRootSelection {
    documentId: string;
    includeDescendants: boolean;
}

export interface SyncProfile {
    id: string;
    name: string;

    scope: SyncScope;
    direction: SyncDirection;
    trigger: SyncTrigger;

    conflictPolicy: ConflictPolicy;
    conflictAuthority?: ConflictAuthority;
    deletionPolicy: DeletionPolicy;

    localWorkspaceId: string;
    remoteWorkspaceId: string;

    notebookMappings: NotebookMapping[];
    documentRoots: DocumentRootSelection[];
}

export type SyncActionType = "create" | "update" | "move" | "delete" | "noop";
export type SyncObjectType = "notebook" | "document" | "asset";

export interface SyncAction {
    id: string;
    type: SyncActionType;
    objectType: SyncObjectType;
    objectId: string;
    title?: string;
    logicalPath: string;
    sourcePath?: string;
    destinationPath?: string;
    sourceNotebookId?: string;
    destinationNotebookId?: string;
    direction: "push" | "pull";
    reason?: string;
    sourceSnapshot?: MirrorDocumentSnapshot;
    destinationSnapshot?: MirrorDocumentSnapshot;
    baseline?: MirrorDocumentBaseline;
}

export type ExtendedConflictClassification =
    | MirrorConflictClassification
    | "delete-modify"
    | "modify-delete"
    | "diverged";

export interface SyncConflict {
    objectId: string;
    objectType: SyncObjectType;
    logicalPath: string;
    title?: string;
    classification: ExtendedConflictClassification;
    sourceFingerprint?: string;
    destinationFingerprint?: string;
    baselineFingerprint?: string;
    reasons: string[];
    resolution?: "skip" | "source-wins" | "destination-wins";
}

export interface SyncPlan {
    profile: SyncProfile;
    effectiveSourceWorkspaceId: string;
    effectiveDestinationWorkspaceId: string;
    creates: SyncAction[];
    updates: SyncAction[];
    moves: SyncAction[];
    deletes: SyncAction[];
    noops: SyncAction[];
    conflicts: SyncConflict[];
    totalActions: number;
}

export interface DeletionTombstone {
    objectType: SyncObjectType;
    objectId: string;
    logicalPath?: string;
    deletedByWorkspaceId: string;
    deletedAt: string;
    previousFingerprint: string;
    resolved?: boolean;
}

export interface ScopeSnapshotItem {
    id: string;
    objectType: SyncObjectType;
    notebookId: string;
    path: string;
    logicalPath: string;
    hpath?: string;
    title?: string;
    depth: number;
    parentId: string;
    snapshot?: MirrorDocumentSnapshot;
}

export interface ScopeSnapshot {
    scope: SyncScope;
    workspaceId: string;
    notebooks: Array<{ id: string; name: string; closed?: boolean }>;
    items: Map<string, ScopeSnapshotItem>;
    assets: Map<string, AssetFingerprint & { content?: Blob }>;
}

export interface SyncScopeAdapter {
    captureSource(): Promise<ScopeSnapshot>;
    captureDestination(): Promise<ScopeSnapshot>;
    buildLogicalPath(notebookId: string, path: string): string;
    validateCapabilities(): Promise<void>;
}
