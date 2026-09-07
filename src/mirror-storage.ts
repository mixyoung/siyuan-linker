import {
    createNotebook,
    downloadWorkspaceFileIfExists,
    listNotebooks,
    writeFile,
    type TargetConnection,
} from "./siyuan-api";
import {
    MIRROR_LINEAGES_PATH,
    MIRROR_SCHEMA_VERSION,
    WORKSPACE_IDENTITY_PATH,
    type DeletionTombstone,
    type MirrorDocumentBaseline,
    type MirrorLineageStore,
    type MirrorPairingResult,
    type MirrorPairStatus,
    type MirrorPeerRecord,
    type NotebookMapping,
    type PendingMirrorOperation,
    type SyncProfile,
    type WorkspaceIdentity,
} from "./mirror-types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const operationQueues = new Map<string, Promise<void>>();

function endpointLockId(target?: TargetConnection): string {
    if (target?.url) return target.url.replace(/\/+$/, "");
    if (typeof location !== "undefined" && location.origin) return location.origin.replace(/\/+$/, "");
    return "local";
}

export function mirrorEndpointPairKey(source?: TargetConnection, destination?: TargetConnection): string {
    return [endpointLockId(source), endpointLockId(destination)].sort().join(" <-> ");
}

export function assertDistinctMirrorEndpoints(source?: TargetConnection, destination?: TargetConnection): void {
    if (endpointLockId(source) === endpointLockId(destination)) {
        throw new Error("Mirror operation requires two distinct SiYuan endpoints and cannot target the current origin");
    }
}

export async function withMirrorOperationLock<T>(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    operation: () => Promise<T>,
): Promise<T> {
    const key = mirrorEndpointPairKey(source, destination);
    const previous = operationQueues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    operationQueues.set(key, tail);
    try { return await run; }
    finally { if (operationQueues.get(key) === tail) operationQueues.delete(key); }
}

const now = () => new Date().toISOString();
const newUuid = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    throw new Error("Secure random UUID generation is unavailable");
};

function sortedUnique(values: string[]): string[] {
    return [...new Set(values)].sort();
}

function parseIdentity(value: unknown): WorkspaceIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mirror identity: invalid JSON object");
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== MIRROR_SCHEMA_VERSION || typeof item.workspaceId !== "string" || !UUID_PATTERN.test(item.workspaceId)
        || typeof item.createdAt !== "string" || !item.createdAt) {
        throw new Error("Mirror identity: invalid workspace identity");
    }
    return { schemaVersion: MIRROR_SCHEMA_VERSION, workspaceId: item.workspaceId, createdAt: item.createdAt };
}

function parseBaseline(value: unknown, key: string): MirrorDocumentBaseline {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Mirror lineages: invalid baseline ${key}`);
    const item = value as Record<string, unknown>;
    const stringKeys = ["documentId", "notebookId", "path", "hpath", "domSha256", "identityRowsSha256", "attrsSha256", "assetsSha256", "fingerprint"];
    if (stringKeys.some((name) => typeof item[name] !== "string") || item.documentId !== key || !Array.isArray(item.blockIds)
        || item.blockIds.some((id) => typeof id !== "string") || !Array.isArray(item.assets)) {
        throw new Error(`Mirror lineages: invalid baseline ${key}`);
    }
    // Baselines written before hashVersion existed are treated as version 1;
    // the transfer service ignores baselines whose version is not current.
    const hashVersion = item.hashVersion === undefined ? 1 : item.hashVersion;
    if (typeof hashVersion !== "number" || !Number.isInteger(hashVersion) || hashVersion < 1) {
        throw new Error(`Mirror lineages: invalid baseline ${key}`);
    }
    const assets = item.assets.map((asset) => {
        if (!asset || typeof asset !== "object" || typeof (asset as Record<string, unknown>).path !== "string"
            || typeof (asset as Record<string, unknown>).sha256 !== "string") {
            throw new Error(`Mirror lineages: invalid asset baseline ${key}`);
        }
        return { path: String((asset as Record<string, unknown>).path), sha256: String((asset as Record<string, unknown>).sha256) };
    });
    return {
        hashVersion,
        documentId: String(item.documentId), notebookId: String(item.notebookId), path: String(item.path), hpath: String(item.hpath),
        domSha256: String(item.domSha256), identityRowsSha256: String(item.identityRowsSha256), attrsSha256: String(item.attrsSha256),
        assetsSha256: String(item.assetsSha256), fingerprint: String(item.fingerprint), blockIds: [...item.blockIds] as string[], assets,
    };
}

function parsePending(value: unknown): PendingMirrorOperation | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mirror lineages: invalid pending operation");
    const item = value as Record<string, unknown>;
    if (["operationId", "pairId", "sourceWorkspaceId", "destinationWorkspaceId", "startedAt"].some((key) => typeof item[key] !== "string")
        || !Array.isArray(item.documentIds) || item.documentIds.some((id) => typeof id !== "string")) {
        throw new Error("Mirror lineages: invalid pending operation");
    }
    const result: PendingMirrorOperation = {
        operationId: String(item.operationId), pairId: String(item.pairId), sourceWorkspaceId: String(item.sourceWorkspaceId),
        destinationWorkspaceId: String(item.destinationWorkspaceId), documentIds: [...item.documentIds] as string[], startedAt: String(item.startedAt),
    };
    if (typeof item.scope === "string") result.scope = item.scope as any;
    if (Array.isArray(item.notebookIds)) result.notebookIds = [...item.notebookIds] as string[];
    if (typeof item.actionsCount === "number") result.actionsCount = item.actionsCount;
    return result;
}

function parseNotebookMappings(value: unknown): NotebookMapping[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new Error("Mirror lineages: invalid notebook mappings");
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).localNotebookId !== "string"
            || typeof (item as Record<string, unknown>).remoteNotebookId !== "string") {
            throw new Error(`Mirror lineages: invalid notebook mapping at index ${index}`);
        }
        return {
            localNotebookId: String((item as Record<string, unknown>).localNotebookId),
            remoteNotebookId: String((item as Record<string, unknown>).remoteNotebookId),
        };
    });
}

function parseTombstones(value: unknown): Record<string, DeletionTombstone> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mirror lineages: invalid tombstones");
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Mirror lineages: invalid tombstone ${key}`);
        const t = item as Record<string, unknown>;
        if (typeof t.objectType !== "string" || typeof t.objectId !== "string"
            || typeof t.deletedByWorkspaceId !== "string" || typeof t.deletedAt !== "string"
            || typeof t.previousFingerprint !== "string") {
            throw new Error(`Mirror lineages: invalid tombstone ${key}`);
        }
        return [key, {
            objectType: t.objectType as "notebook" | "document" | "asset",
            objectId: String(t.objectId),
            logicalPath: typeof t.logicalPath === "string" ? t.logicalPath : undefined,
            deletedByWorkspaceId: String(t.deletedByWorkspaceId),
            deletedAt: String(t.deletedAt),
            previousFingerprint: String(t.previousFingerprint),
            resolved: typeof t.resolved === "boolean" ? t.resolved : undefined,
        }];
    }));
}

function parseGeneration(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error("Mirror lineages: invalid generation");
    }
    return value;
}

function parseRecord(value: unknown, localId: string, peerId: string): MirrorPeerRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Mirror lineages: invalid peer ${peerId}`);
    const item = value as Record<string, unknown>;
    if (["pairId", "localWorkspaceId", "peerWorkspaceId", "createdAt", "updatedAt"].some((key) => typeof item[key] !== "string")
        || item.localWorkspaceId !== localId || item.peerWorkspaceId !== peerId || !Array.isArray(item.notebookIds)
        || item.notebookIds.some((id) => typeof id !== "string") || !item.baselines || typeof item.baselines !== "object" || Array.isArray(item.baselines)) {
        throw new Error(`Mirror lineages: invalid peer ${peerId}`);
    }
    const baselines = Object.fromEntries(Object.entries(item.baselines as Record<string, unknown>).map(([key, baseline]) => [key, parseBaseline(baseline, key)]));
    const notebookMappings = parseNotebookMappings(item.notebookMappings);
    const tombstones = parseTombstones(item.tombstones);
    const generation = parseGeneration(item.generation);
    const record: MirrorPeerRecord = {
        pairId: String(item.pairId), localWorkspaceId: localId, peerWorkspaceId: peerId,
        notebookIds: sortedUnique(item.notebookIds as string[]), createdAt: String(item.createdAt), updatedAt: String(item.updatedAt),
        baselines, pendingOperation: parsePending(item.pendingOperation),
    };
    if (notebookMappings) record.notebookMappings = notebookMappings;
    if (tombstones) record.tombstones = tombstones;
    if (generation !== undefined) record.generation = generation;
    return record;
}

function parseStore(value: unknown, workspaceId: string): MirrorLineageStore {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Mirror lineages: invalid JSON object");
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== MIRROR_SCHEMA_VERSION || item.workspaceId !== workspaceId || !item.peers || typeof item.peers !== "object" || Array.isArray(item.peers)) {
        throw new Error("Mirror lineages: invalid lineage store");
    }
    const peers = Object.fromEntries(Object.entries(item.peers as Record<string, unknown>).map(([peerId, record]) => [peerId, parseRecord(record, workspaceId, peerId)]));
    return { schemaVersion: MIRROR_SCHEMA_VERSION, workspaceId, peers };
}

async function readJson(path: string, target?: TargetConnection): Promise<unknown | null> {
    const blob = await downloadWorkspaceFileIfExists(path, target);
    if (!blob) return null;
    try {
        return JSON.parse(await blob.text());
    } catch {
        throw new Error(`Mirror metadata ${path}: invalid JSON`);
    }
}

async function writeJsonVerified(path: string, value: unknown, target?: TargetConnection): Promise<void> {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(path, new Blob([text], { type: "application/json" }), target);
    const readBack = await downloadWorkspaceFileIfExists(path, target);
    if (!readBack || await readBack.text() !== text) throw new Error(`Mirror metadata ${path}: read verification failed`);
}

export async function readWorkspaceIdentity(target?: TargetConnection): Promise<WorkspaceIdentity | null> {
    const value = await readJson(WORKSPACE_IDENTITY_PATH, target);
    return value === null ? null : parseIdentity(value);
}

export async function ensureWorkspaceIdentity(target?: TargetConnection, rotate = false): Promise<WorkspaceIdentity> {
    const existing = await readWorkspaceIdentity(target);
    if (existing && !rotate) return existing;
    const identity: WorkspaceIdentity = { schemaVersion: MIRROR_SCHEMA_VERSION, workspaceId: newUuid(), createdAt: now() };
    await writeJsonVerified(WORKSPACE_IDENTITY_PATH, identity, target);
    if (rotate) await writeJsonVerified(MIRROR_LINEAGES_PATH, emptyLineageStore(identity.workspaceId), target);
    return identity;
}

export function emptyLineageStore(workspaceId: string): MirrorLineageStore {
    return { schemaVersion: MIRROR_SCHEMA_VERSION, workspaceId, peers: {} };
}

export async function readMirrorLineages(identity: WorkspaceIdentity, target?: TargetConnection): Promise<MirrorLineageStore> {
    const value = await readJson(MIRROR_LINEAGES_PATH, target);
    return value === null ? emptyLineageStore(identity.workspaceId) : parseStore(value, identity.workspaceId);
}

export async function writeMirrorLineages(store: MirrorLineageStore, target?: TargetConnection): Promise<void> {
    parseStore(store, store.workspaceId);
    await writeJsonVerified(MIRROR_LINEAGES_PATH, store, target);
}

function pendingMatches(actual: PendingMirrorOperation | undefined, expected: PendingMirrorOperation): boolean {
    return JSON.stringify(actual ?? null) === JSON.stringify(expected);
}

function canonicalMappings(record: MirrorPeerRecord): string {
    const mappings = record.notebookMappings ?? [];
    const isLocalSmaller = record.localWorkspaceId < record.peerWorkspaceId;
    const pairs = mappings.map((m) =>
        isLocalSmaller
            ? `${m.localNotebookId}=>${m.remoteNotebookId}`
            : `${m.remoteNotebookId}=>${m.localNotebookId}`
    );
    return JSON.stringify(sortedUnique(pairs));
}

function canonicalTombstones(record: MirrorPeerRecord): string {
    const tombstones = record.tombstones ?? {};
    return JSON.stringify(
        Object.fromEntries(Object.entries(tombstones).sort(([a], [b]) => a.localeCompare(b)))
    );
}

function notebooksMatch(left: MirrorPeerRecord, right: MirrorPeerRecord): boolean {
    if (JSON.stringify(sortedUnique(left.notebookIds)) === JSON.stringify(sortedUnique(right.notebookIds))) {
        return true;
    }
    const mappingMap = new Map<string, string>();
    for (const m of left.notebookMappings ?? []) {
        mappingMap.set(m.localNotebookId, m.remoteNotebookId);
    }
    const translatedLeft = sortedUnique(left.notebookIds.map((id) => mappingMap.get(id) ?? id));
    return JSON.stringify(translatedLeft) === JSON.stringify(sortedUnique(right.notebookIds));
}

function recordsMatch(left: MirrorPeerRecord, right: MirrorPeerRecord): boolean {
    const canonicalBaselines = (record: MirrorPeerRecord) => JSON.stringify(
        Object.fromEntries(Object.entries(record.baselines).sort(([leftId], [rightId]) => leftId.localeCompare(rightId))),
    );
    return left.pairId === right.pairId && left.localWorkspaceId === right.peerWorkspaceId && left.peerWorkspaceId === right.localWorkspaceId
        && notebooksMatch(left, right)
        && canonicalBaselines(left) === canonicalBaselines(right)
        && canonicalMappings(left) === canonicalMappings(right)
        && canonicalTombstones(left) === canonicalTombstones(right)
        && JSON.stringify(left.pendingOperation ?? null) === JSON.stringify(right.pendingOperation ?? null);
}

export async function inspectMirrorPair(source?: TargetConnection, destination?: TargetConnection): Promise<MirrorPairStatus> {
    const reasons: string[] = [];
    let sourceIdentity: WorkspaceIdentity | null = null;
    let destinationIdentity: WorkspaceIdentity | null = null;
    let sourceRecord: MirrorPeerRecord | null = null;
    let destinationRecord: MirrorPeerRecord | null = null;
    try { sourceIdentity = await readWorkspaceIdentity(source); } catch (error) { reasons.push(String(error)); }
    try { destinationIdentity = await readWorkspaceIdentity(destination); } catch (error) { reasons.push(String(error)); }
    if (!sourceIdentity) reasons.push("Source workspace identity is missing");
    if (!destinationIdentity) reasons.push("Destination workspace identity is missing");
    if (sourceIdentity && destinationIdentity) {
        if (sourceIdentity.workspaceId === destinationIdentity.workspaceId) reasons.push("Workspaces have a duplicated identity");
        try { sourceRecord = (await readMirrorLineages(sourceIdentity, source)).peers[destinationIdentity.workspaceId] ?? null; }
        catch (error) { reasons.push(String(error)); }
        try { destinationRecord = (await readMirrorLineages(destinationIdentity, destination)).peers[sourceIdentity.workspaceId] ?? null; }
        catch (error) { reasons.push(String(error)); }
        if (!sourceRecord) reasons.push("Source peer lineage is missing");
        if (!destinationRecord) reasons.push("Destination peer lineage is missing");
        if (sourceRecord && destinationRecord && !recordsMatch(sourceRecord, destinationRecord)) reasons.push("Peer lineage records do not match");
        if (sourceRecord?.pendingOperation || destinationRecord?.pendingOperation) reasons.push("A previous mirror operation is still pending");
    }
    return {
        state: "ready", valid: reasons.length === 0, reasons, sourceIdentity, destinationIdentity, sourceRecord, destinationRecord,
        allowedNotebookIds: sourceRecord && destinationRecord && recordsMatch(sourceRecord, destinationRecord) ? sortedUnique(sourceRecord.notebookIds) : [],
        pending: Boolean(sourceRecord?.pendingOperation || destinationRecord?.pendingOperation),
    };
}

async function pairMirrorWorkspacesUnlocked(source?: TargetConnection, destination?: TargetConnection): Promise<MirrorPairingResult> {
    assertDistinctMirrorEndpoints(source, destination);
    const sourceIdentity = await ensureWorkspaceIdentity(source);
    const destinationIdentity = await ensureWorkspaceIdentity(destination);
    const destinationIdentityRotated = false;
    if (destinationIdentity.workspaceId === sourceIdentity.workspaceId) {
        throw new Error("Workspaces have a duplicated identity; use the explicitly confirmed adopt-full-clone destination action before pairing");
    }
    const [sourceStore, destinationStore] = await Promise.all([
        readMirrorLineages(sourceIdentity, source), readMirrorLineages(destinationIdentity, destination),
    ]);
    const existingSourceRecord = sourceStore.peers[destinationIdentity.workspaceId];
    const existingDestinationRecord = destinationStore.peers[sourceIdentity.workspaceId];
    if (existingSourceRecord || existingDestinationRecord) {
        if (existingSourceRecord && existingDestinationRecord && recordsMatch(existingSourceRecord, existingDestinationRecord)
            && !existingSourceRecord.pendingOperation && !existingDestinationRecord.pendingOperation) {
            return {
                sourceIdentity, destinationIdentity, pairId: existingSourceRecord.pairId,
                allowedNotebookIds: sortedUnique(existingSourceRecord.notebookIds), destinationIdentityRotated,
            };
        }
        throw new Error("Mirror pairing refused to overwrite existing, pending, or divergent peer lineage records");
    }
    const [sourceNotebooks, destinationNotebooks] = await Promise.all([listNotebooks(source), listNotebooks(destination)]);
    const destinationIds = new Set(destinationNotebooks.map(({ id }) => id));
    const notebookIds = sortedUnique(sourceNotebooks.map(({ id }) => id).filter((id) => destinationIds.has(id)));
    const previousSourceStore = structuredClone(sourceStore);
    const pairId = newUuid();
    const timestamp = now();
    const notebookMappings: NotebookMapping[] = notebookIds.map((id) => ({
        localNotebookId: id,
        remoteNotebookId: id,
    }));
    const sourceRecord: MirrorPeerRecord = {
        pairId, localWorkspaceId: sourceIdentity.workspaceId, peerWorkspaceId: destinationIdentity.workspaceId,
        notebookIds, notebookMappings, createdAt: timestamp, updatedAt: timestamp, baselines: {},
    };
    const destinationRecord: MirrorPeerRecord = {
        ...sourceRecord, localWorkspaceId: destinationIdentity.workspaceId, peerWorkspaceId: sourceIdentity.workspaceId,
    };
    sourceStore.peers[destinationIdentity.workspaceId] = sourceRecord;
    destinationStore.peers[sourceIdentity.workspaceId] = destinationRecord;
    await writeMirrorLineages(sourceStore, source);
    try {
        await writeMirrorLineages(destinationStore, destination);
    } catch (error) {
        try { await writeMirrorLineages(previousSourceStore, source); } catch { /* Inspection will conservatively report any unilateral record. */ }
        throw error;
    }
    const status = await inspectMirrorPair(source, destination);
    if (!status.valid) throw new Error(`Mirror pairing verification failed: ${status.reasons.join("; ")}`);
    return { sourceIdentity, destinationIdentity, pairId, allowedNotebookIds: notebookIds, destinationIdentityRotated };
}

export async function pairMirrorWorkspaces(source?: TargetConnection, destination?: TargetConnection): Promise<MirrorPairingResult> {
    return withMirrorOperationLock(source, destination, () => pairMirrorWorkspacesUnlocked(source, destination));
}

export async function updateMatchingPeerRecords(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    mutate: (sourceRecord: MirrorPeerRecord, destinationRecord: MirrorPeerRecord) => void,
): Promise<void> {
    const status = await inspectMirrorPair(source, destination);
    const structuralReasons = status.reasons.filter((reason) => reason !== "A previous mirror operation is still pending");
    if (structuralReasons.length || !status.sourceIdentity || !status.destinationIdentity || !status.sourceRecord || !status.destinationRecord
        || !recordsMatch(status.sourceRecord, status.destinationRecord)) {
        throw new Error(`Mirror lineage is not valid: ${structuralReasons.join("; ")}`);
    }
    const [sourceStore, destinationStore] = await Promise.all([
        readMirrorLineages(status.sourceIdentity, source), readMirrorLineages(status.destinationIdentity, destination),
    ]);
    const oldSource = structuredClone(sourceStore);
    const oldDestination = structuredClone(destinationStore);
    const sourceRecord = sourceStore.peers[status.destinationIdentity.workspaceId];
    const destinationRecord = destinationStore.peers[status.sourceIdentity.workspaceId];
    mutate(sourceRecord, destinationRecord);
    sourceRecord.updatedAt = now();
    destinationRecord.updatedAt = sourceRecord.updatedAt;
    await writeMirrorLineages(sourceStore, source);
    try {
        await writeMirrorLineages(destinationStore, destination);
    } catch (error) {
        try { await writeMirrorLineages(oldSource, source); } catch { /* Keep conservative invalid/pending metadata for inspection. */ }
        try { await writeMirrorLineages(oldDestination, destination); } catch { /* Keep conservative invalid/pending metadata for inspection. */ }
        throw error;
    }
}

export async function persistPendingOperation(
    pending: PendingMirrorOperation,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<void> {
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        if (sourceRecord.pendingOperation || destinationRecord.pendingOperation) throw new Error("A mirror operation is already pending");
        sourceRecord.pendingOperation = pending;
        destinationRecord.pendingOperation = pending;
    });
    const status = await inspectMirrorPair(source, destination);
    if (!status.sourceRecord?.pendingOperation || !status.destinationRecord?.pendingOperation
        || status.sourceRecord.pendingOperation.operationId !== pending.operationId
        || status.destinationRecord.pendingOperation.operationId !== pending.operationId) {
        throw new Error("Pending mirror operation was not verified on both workspaces");
    }
}

export async function assertPendingOperationOwnership(
    pending: PendingMirrorOperation,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<void> {
    const status = await inspectMirrorPair(source, destination);
    if (!status.sourceIdentity || !status.destinationIdentity || !status.sourceRecord || !status.destinationRecord
        || status.sourceIdentity.workspaceId !== pending.sourceWorkspaceId
        || status.destinationIdentity.workspaceId !== pending.destinationWorkspaceId
        || status.sourceRecord.pairId !== pending.pairId || status.destinationRecord.pairId !== pending.pairId
        || !pendingMatches(status.sourceRecord.pendingOperation, pending)
        || !pendingMatches(status.destinationRecord.pendingOperation, pending)) {
        throw new Error("Pending mirror operation ownership is not an exact bilateral match");
    }
}

export async function commitMirrorBaselines(
    baselines: Record<string, MirrorDocumentBaseline>,
    pending: PendingMirrorOperation,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<void> {
    await assertPendingOperationOwnership(pending, source, destination);
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        if (!pendingMatches(sourceRecord.pendingOperation, pending) || !pendingMatches(destinationRecord.pendingOperation, pending)) {
            throw new Error("Pending mirror operation no longer matches exactly");
        }
        sourceRecord.baselines = { ...sourceRecord.baselines, ...baselines };
        destinationRecord.baselines = { ...destinationRecord.baselines, ...baselines };
        delete sourceRecord.pendingOperation;
        delete destinationRecord.pendingOperation;
    });
}

export function resolveNotebookMapping(record: MirrorPeerRecord, localNotebookId: string): string | undefined {
    if (record.notebookMappings && record.notebookMappings.length > 0) {
        const found = record.notebookMappings.find((m) => m.localNotebookId === localNotebookId);
        if (found) return found.remoteNotebookId;
    }
    if (record.notebookIds.includes(localNotebookId)) {
        return localNotebookId;
    }
    return undefined;
}

export function resolveReverseNotebookMapping(record: MirrorPeerRecord, remoteNotebookId: string): string | undefined {
    if (record.notebookMappings && record.notebookMappings.length > 0) {
        const found = record.notebookMappings.find((m) => m.remoteNotebookId === remoteNotebookId);
        if (found) return found.localNotebookId;
    }
    if (record.notebookIds.includes(remoteNotebookId)) {
        return remoteNotebookId;
    }
    return undefined;
}

export async function addNotebookMapping(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    mapping: NotebookMapping,
): Promise<void> {
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        const sourceMappings = sourceRecord.notebookMappings ?? [];
        const destinationMappings = destinationRecord.notebookMappings ?? [];

        if (sourceMappings.some((m) => m.localNotebookId === mapping.localNotebookId && m.remoteNotebookId !== mapping.remoteNotebookId)) {
            throw new Error(`Notebook mapping conflict: local notebook ${mapping.localNotebookId} is already mapped`);
        }
        if (sourceMappings.some((m) => m.remoteNotebookId === mapping.remoteNotebookId && m.localNotebookId !== mapping.localNotebookId)) {
            throw new Error(`Notebook mapping conflict: remote notebook ${mapping.remoteNotebookId} is already mapped`);
        }

        const filteredSource = sourceMappings.filter((m) => m.localNotebookId !== mapping.localNotebookId);
        filteredSource.push(mapping);
        sourceRecord.notebookMappings = filteredSource;
        if (!sourceRecord.notebookIds.includes(mapping.localNotebookId)) {
            sourceRecord.notebookIds = sortedUnique([...sourceRecord.notebookIds, mapping.localNotebookId]);
        }

        const invertedMapping: NotebookMapping = {
            localNotebookId: mapping.remoteNotebookId,
            remoteNotebookId: mapping.localNotebookId,
        };
        const filteredDest = destinationMappings.filter((m) => m.localNotebookId !== invertedMapping.localNotebookId);
        filteredDest.push(invertedMapping);
        destinationRecord.notebookMappings = filteredDest;
        if (!destinationRecord.notebookIds.includes(mapping.remoteNotebookId)) {
            destinationRecord.notebookIds = sortedUnique([...destinationRecord.notebookIds, mapping.remoteNotebookId]);
        }
    });
}

export async function createAndMapNotebook(
    sourceNotebookId: string,
    destinationNotebookName: string,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<{ id: string; name: string }> {
    const status = await inspectMirrorPair(source, destination);
    if (!status.valid || !status.sourceRecord) {
        throw new Error("Cannot create and map notebook: pairing is not valid");
    }
    const existing = resolveNotebookMapping(status.sourceRecord, sourceNotebookId);
    if (existing && existing !== sourceNotebookId) {
        throw new Error(`Source notebook ${sourceNotebookId} is already mapped to ${existing}`);
    }
    const notebook = await createNotebook(destinationNotebookName, destination);
    await addNotebookMapping(source, destination, {
        localNotebookId: sourceNotebookId,
        remoteNotebookId: notebook.id,
    });
    return notebook;
}

export async function recordDeletionTombstones(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    tombstones: DeletionTombstone[],
): Promise<void> {
    if (!tombstones.length) return;
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        const sourceTombstones = { ...(sourceRecord.tombstones ?? {}) };
        const destTombstones = { ...(destinationRecord.tombstones ?? {}) };
        for (const t of tombstones) {
            sourceTombstones[t.objectId] = t;
            destTombstones[t.objectId] = t;
        }
        sourceRecord.tombstones = sourceTombstones;
        destinationRecord.tombstones = destTombstones;
    });
}

export async function clearDeletionTombstones(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    objectIds: string[],
): Promise<void> {
    if (!objectIds.length) return;
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        const sourceTombstones = { ...(sourceRecord.tombstones ?? {}) };
        const destTombstones = { ...(destinationRecord.tombstones ?? {}) };
        for (const id of objectIds) {
            delete sourceTombstones[id];
            delete destTombstones[id];
        }
        sourceRecord.tombstones = sourceTombstones;
        destinationRecord.tombstones = destTombstones;
    });
}

export async function commitSyncBaselines(
    baselines: Record<string, MirrorDocumentBaseline>,
    pending: PendingMirrorOperation,
    source?: TargetConnection,
    destination?: TargetConnection,
    options?: {
        tombstonesToRecord?: DeletionTombstone[];
        tombstonesToClear?: string[];
        advanceGeneration?: boolean;
    },
): Promise<void> {
    await assertPendingOperationOwnership(pending, source, destination);
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        if (!pendingMatches(sourceRecord.pendingOperation, pending) || !pendingMatches(destinationRecord.pendingOperation, pending)) {
            throw new Error("Pending mirror operation no longer matches exactly");
        }
        sourceRecord.baselines = { ...sourceRecord.baselines, ...baselines };
        destinationRecord.baselines = { ...destinationRecord.baselines, ...baselines };

        if (options?.tombstonesToRecord?.length) {
            const sTomb = { ...(sourceRecord.tombstones ?? {}) };
            const dTomb = { ...(destinationRecord.tombstones ?? {}) };
            for (const t of options.tombstonesToRecord) {
                sTomb[t.objectId] = t;
                dTomb[t.objectId] = t;
            }
            sourceRecord.tombstones = sTomb;
            destinationRecord.tombstones = dTomb;
        }
        if (options?.tombstonesToClear?.length) {
            const sTomb = { ...(sourceRecord.tombstones ?? {}) };
            const dTomb = { ...(destinationRecord.tombstones ?? {}) };
            for (const id of options.tombstonesToClear) {
                delete sTomb[id];
                delete dTomb[id];
            }
            sourceRecord.tombstones = sTomb;
            destinationRecord.tombstones = dTomb;
        }
        if (options?.advanceGeneration) {
            const nextGen = (sourceRecord.generation ?? 0) + 1;
            sourceRecord.generation = nextGen;
            destinationRecord.generation = nextGen;
        }

        delete sourceRecord.pendingOperation;
        delete destinationRecord.pendingOperation;
    });
}

export async function clearPendingAfterVerifiedRollback(
    pending: PendingMirrorOperation,
    source?: TargetConnection,
    destination?: TargetConnection,
): Promise<void> {
    await assertPendingOperationOwnership(pending, source, destination);
    await updateMatchingPeerRecords(source, destination, (sourceRecord, destinationRecord) => {
        if (!pendingMatches(sourceRecord.pendingOperation, pending) || !pendingMatches(destinationRecord.pendingOperation, pending)) {
            throw new Error("Pending mirror operation no longer matches the verified rollback");
        }
        delete sourceRecord.pendingOperation;
        delete destinationRecord.pendingOperation;
    });
    const status = await inspectMirrorPair(source, destination);
    if (!status.valid || status.pending) throw new Error("Rolled-back mirror pending state was not cleared and verified on both workspaces");
}

async function resetMirrorPeerUnlocked(
    source?: TargetConnection,
    destination?: TargetConnection,
    options?: { force?: boolean },
): Promise<void> {
    assertDistinctMirrorEndpoints(source, destination);
    const [sourceIdentity, destinationIdentity] = await Promise.all([readWorkspaceIdentity(source), readWorkspaceIdentity(destination)]);
    if (!sourceIdentity || !destinationIdentity) return;
    const [sourceStore, destinationStore] = await Promise.all([
        readMirrorLineages(sourceIdentity, source), readMirrorLineages(destinationIdentity, destination),
    ]);
    const sourceRecord = sourceStore.peers[destinationIdentity.workspaceId];
    const destinationRecord = destinationStore.peers[sourceIdentity.workspaceId];
    const pending = Boolean(sourceRecord?.pendingOperation || destinationRecord?.pendingOperation);
    if (pending && !options?.force) {
        throw new Error("Mirror peer reset refused: a pending operation requires recovery or verified rollback before lineage can be reset");
    }
    if (pending && options?.force) {
        // Force reset breaks the pending safety marker; archive the full
        // stores first so the interrupted operation remains reconstructable.
        const stamp = `${Date.now()}-${newUuid().slice(0, 8)}`;
        await writeJsonVerified(`data/storage/petal/siyuan-linker/mirror-lineages.reset-source-${stamp}.json`, {
            archivedAt: now(), reason: "forced-reset-with-pending", lineage: sourceStore,
        }, source);
        await writeJsonVerified(`data/storage/petal/siyuan-linker/mirror-lineages.reset-destination-${stamp}.json`, {
            archivedAt: now(), reason: "forced-reset-with-pending", lineage: destinationStore,
        }, destination);
    }
    delete sourceStore.peers[destinationIdentity.workspaceId];
    delete destinationStore.peers[sourceIdentity.workspaceId];
    const failures: string[] = [];
    try { await writeMirrorLineages(sourceStore, source); } catch (error) { failures.push(`source: ${String(error)}`); }
    try { await writeMirrorLineages(destinationStore, destination); } catch (error) { failures.push(`destination: ${String(error)}`); }
    if (failures.length) throw new Error(`Mirror peer reset incomplete; inspect both workspaces before pairing again (${failures.join("; ")})`);
}

export async function resetMirrorPeer(
    source?: TargetConnection,
    destination?: TargetConnection,
    options?: { force?: boolean },
): Promise<void> {
    return withMirrorOperationLock(source, destination, () => resetMirrorPeerUnlocked(source, destination, options));
}

export const ADOPT_FULL_CLONE_CONFIRMATION = "ADOPT_FULL_CLONE_DESTINATION";

export interface AdoptFullCloneResult {
    previousWorkspaceId: string;
    destinationIdentity: WorkspaceIdentity;
    archivePath: string;
}

async function adoptFullCloneDestinationUnlocked(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    confirmation: string,
): Promise<AdoptFullCloneResult> {
    assertDistinctMirrorEndpoints(source, destination);
    if (confirmation !== ADOPT_FULL_CLONE_CONFIRMATION) throw new Error("Adopt full clone requires the exact strong confirmation token");
    const [sourceIdentity, destinationIdentity] = await Promise.all([readWorkspaceIdentity(source), readWorkspaceIdentity(destination)]);
    if (!sourceIdentity || !destinationIdentity) throw new Error("Adopt full clone requires identities on both endpoints");
    if (sourceIdentity.workspaceId !== destinationIdentity.workspaceId) {
        throw new Error("Adopt full clone is only valid when the chosen destination still has the source workspace's duplicated identity");
    }
    const copiedLineage = await readMirrorLineages(destinationIdentity, destination);
    const archivePath = `data/storage/petal/siyuan-linker/mirror-lineages.adopted-${Date.now()}-${newUuid().slice(0, 8)}.json`;
    await writeJsonVerified(archivePath, {
        archivedAt: now(),
        reason: "explicit-adopt-full-clone-destination",
        previousIdentity: destinationIdentity,
        lineage: copiedLineage,
    }, destination);
    const rotated = await ensureWorkspaceIdentity(destination, true);
    return { previousWorkspaceId: destinationIdentity.workspaceId, destinationIdentity: rotated, archivePath };
}

export async function adoptFullCloneDestination(
    source: TargetConnection | undefined,
    destination: TargetConnection | undefined,
    confirmation: string,
): Promise<AdoptFullCloneResult> {
    return withMirrorOperationLock(source, destination, () => adoptFullCloneDestinationUnlocked(source, destination, confirmation));
}
