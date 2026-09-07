import type { BlockAttrs, BlockIdentityRow } from "./siyuan-api";

export const MIRROR_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_IDENTITY_PATH = "data/storage/petal/siyuan-linker/workspace-identity.json";
export const MIRROR_LINEAGES_PATH = "data/storage/petal/siyuan-linker/mirror-lineages.json";

export interface WorkspaceIdentity {
    schemaVersion: typeof MIRROR_SCHEMA_VERSION;
    workspaceId: string;
    createdAt: string;
}

export interface AssetFingerprint {
    path: string;
    sha256: string;
}

// Bump when the fingerprint inputs change so baselines computed with older
// inputs are treated as absent instead of producing false conflicts after
// an upgrade (e.g. v1 did not normalize volatile DOM metadata).
export const BASELINE_HASH_VERSION = 4;

export interface MirrorDocumentBaseline {
    hashVersion: number;
    documentId: string;
    notebookId: string;
    path: string;
    hpath: string;
    domSha256: string;
    identityRowsSha256: string;
    attrsSha256: string;
    assetsSha256: string;
    fingerprint: string;
    blockIds: string[];
    assets: AssetFingerprint[];
}

export type MirrorConflictClassification =
    | "missing-destination"
    | "unchanged"
    | "source-changed"
    | "destination-changed"
    | "converged"
    | "conflict";

export interface PendingMirrorOperation {
    operationId: string;
    pairId: string;
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    documentIds: string[];
    startedAt: string;
}

export interface MirrorPeerRecord {
    pairId: string;
    localWorkspaceId: string;
    peerWorkspaceId: string;
    notebookIds: string[];
    createdAt: string;
    updatedAt: string;
    baselines: Record<string, MirrorDocumentBaseline>;
    pendingOperation?: PendingMirrorOperation;
}

export interface MirrorLineageStore {
    schemaVersion: typeof MIRROR_SCHEMA_VERSION;
    workspaceId: string;
    peers: Record<string, MirrorPeerRecord>;
}

export type MirrorPairStatusState = "loading" | "ready" | "unknown";

export interface MirrorPairStatus {
    state: MirrorPairStatusState;
    valid: boolean;
    reasons: string[];
    sourceIdentity: WorkspaceIdentity | null;
    destinationIdentity: WorkspaceIdentity | null;
    sourceRecord: MirrorPeerRecord | null;
    destinationRecord: MirrorPeerRecord | null;
    allowedNotebookIds: string[];
    pending: boolean;
}

export interface MirrorPairingResult {
    sourceIdentity: WorkspaceIdentity;
    destinationIdentity: WorkspaceIdentity;
    pairId: string;
    allowedNotebookIds: string[];
    destinationIdentityRotated: boolean;
}

export interface MirrorDocumentSnapshot {
    documentId: string;
    notebookId: string;
    path: string;
    hpath: string;
    dom: string;
    attrs: BlockAttrs;
    managedAttrs: BlockAttrs;
    identityRows: BlockIdentityRow[];
    blockIds: string[];
    assets: Array<AssetFingerprint & { content: Blob }>;
    baseline: MirrorDocumentBaseline;
}

export type MirrorFailureState = "before-write" | "rolled-back" | "partial" | "metadata-commit";

export interface MirrorErrorDetails {
    state: MirrorFailureState;
    operationId?: string;
    cause: string;
    rollbackErrors?: string[];
    residualAssetPaths?: string[];
    /** Document IDs whose no-baseline (first-sync) content conflicts blocked the batch. */
    firstSyncConflicts?: string[];
}

export class MirrorOperationError extends Error {
    readonly details: MirrorErrorDetails;

    constructor(message: string, details: MirrorErrorDetails) {
        super(message);
        this.name = "MirrorOperationError";
        this.details = details;
    }
}
