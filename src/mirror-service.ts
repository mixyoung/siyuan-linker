import {
    assertNodeId,
    createDocWithMd,
    downloadWorkspaceFile,
    downloadWorkspaceFileIfExists,
    findBlockIdentityRows,
    flushSqlQueue,
    getBlockAttrs,
    getBlockDOM,
    getBlockIdentityRows,
    getDocumentAssets,
    getDocumentLocation,
    getHPathByID,
    isEncryptedNotebook,
    listNotebooks,
    openNotebook,
    reloadFileTree,
    removeDocById,
    setBlockAttrs,
    updateBlockDOM,
    writeFile,
    type BlockAttrs,
    type TargetConnection,
} from "./siyuan-api";
import {
    MirrorOperationError,
    BASELINE_HASH_VERSION,
    type MirrorConflictClassification,
    type MirrorDocumentBaseline,
    type MirrorDocumentSnapshot,
    type PendingMirrorOperation,
} from "./mirror-types";
import {
    assertPendingOperationOwnership,
    clearPendingAfterVerifiedRollback,
    commitMirrorBaselines,
    inspectMirrorPair,
    persistPendingOperation,
    withMirrorOperationLock,
} from "./mirror-storage";

const MANAGED_ROOT_ATTRS = new Set([
    "id", "title", "updated", "type", "subtype", "box", "path", "hpath", "rootid", "root_id", "parentid", "parent_id",
]);

const sortedObject = (value: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function sha256(value: string | Blob): Promise<string> {
    const buffer = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
    return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

export function filterManagedRootAttrs(attrs: BlockAttrs): BlockAttrs {
    return Object.fromEntries(Object.entries(attrs).filter(([key]) => !MANAGED_ROOT_ATTRS.has(key.toLowerCase())));
}

function comparableAttrs(attrs: BlockAttrs): BlockAttrs {
    return sortedObject(Object.fromEntries(Object.entries(filterManagedRootAttrs(attrs)).filter(([, value]) => value !== "")));
}

function sameAttrs(left: BlockAttrs, right: BlockAttrs): boolean {
    return JSON.stringify(comparableAttrs(left)) === JSON.stringify(comparableAttrs(right));
}

export function extractBlockIds(dom: string, documentId: string): string[] {
    const ids = new Set<string>([assertNodeId(documentId, "document ID")]);
    const pattern = /\bdata-node-id\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(dom))) ids.add(assertNodeId(match[1] ?? match[2]));
    return [...ids].sort();
}

function hasAttributeView(snapshot: MirrorDocumentSnapshot): boolean {
    return snapshot.identityRows.some((row) => row.type === "av" || row.subtype === "av"
        || /\bcustom-avs\s*=\s*(?:"[^"]+"|'[^']+')/.test(row.ial))
        || /data-type\s*=\s*["']NodeAttributeView["']/.test(snapshot.dom);
}

function workspacePathToDocumentPath(path: string): string {
    const match = /^data\/[^/]+(\/.*\.sy)$/.exec(path);
    if (!match) throw new Error(`Exact mirror: unsupported document path ${path}`);
    return match[1];
}

function ancestorEntries(path: string): Array<{ documentId: string; path: string; parentId: string; depth: number }> {
    const match = /^data\/([^/]+)\/(.+\.sy)$/.exec(path);
    if (!match) throw new Error(`Exact mirror: unsupported document path ${path}`);
    const [, notebookId, relative] = match;
    const segments = relative.split("/");
    return segments.map((segment, index) => {
        const documentId = segment.replace(/\.sy$/, "");
        assertNodeId(documentId, "document path ID");
        const parentId = index ? segments[index - 1].replace(/\.sy$/, "") : "";
        const documentSegments = [...segments.slice(0, index), `${documentId}.sy`];
        return { documentId, path: `data/${notebookId}/${documentSegments.join("/")}`, parentId, depth: index };
    });
}

// `updated` is kernel-managed per-instance metadata, and SiYuan does not
// guarantee a stable attribute order for IALs across instances, so identity
// hashing uses a canonical sorted form without `updated`.
function normalizeIal(ial: string): string {
    const pairs = [...(ial ?? "").matchAll(/([\w-]+)="([^"]*)"/g)]
        .map((match) => ({ key: match[1], value: match[2] }))
        .filter((pair) => pair.key !== "updated")
        .sort((left, right) => left.key.localeCompare(right.key));
    return pairs.map((pair) => `${pair.key}="${pair.value}"`).join(" ");
}

// The kernel refreshes per-node `updated` timestamps on its own schedule
// (CreatedUpdated/RefreshUpdated during transactions), so rendered DOM can
// differ across instances purely in volatile metadata. Identity hashing and
// ownership comparisons use the DOM with those attributes removed.
export function normalizeDom(dom: string): string {
    return (dom ?? "").replace(/\s+updated="\d{14}"/g, "");
}

function sameRenderedDom(left: string, right: string): boolean {
    return left === right || normalizeDom(left) === normalizeDom(right);
}

async function buildBaseline(
    documentId: string,
    notebookId: string,
    path: string,
    hpath: string,
    dom: string,
    attrs: BlockAttrs,
    identityRows: Awaited<ReturnType<typeof getBlockIdentityRows>>,
    assets: Array<{ path: string; sha256: string }>,
): Promise<MirrorDocumentBaseline> {
    // `updated` timestamps inside block IALs are kernel-managed per-instance
    // metadata; converged documents legitimately differ on them, so they are
    // excluded from the cross-instance identity hash.
    const normalizedRows = [...identityRows]
        .map((row) => ({ ...row, ial: normalizeIal(row.ial ?? "") }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const normalizedAttrs = comparableAttrs(attrs);
    const normalizedAssets = assets.map(({ path: assetPath, sha256: assetSha256 }) => ({ path: assetPath, sha256: assetSha256 }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const blockIds = normalizedRows.map(({ id }) => id).sort();
    if (!blockIds.includes(documentId)) blockIds.push(documentId);
    blockIds.sort();
    const [domSha256, identityRowsSha256, attrsSha256, assetsSha256] = await Promise.all([
        sha256(normalizeDom(dom)), sha256(JSON.stringify(normalizedRows)), sha256(JSON.stringify(normalizedAttrs)), sha256(JSON.stringify(normalizedAssets)),
    ]);
    const fingerprint = await sha256(JSON.stringify({
        hashVersion: BASELINE_HASH_VERSION, notebookId, path, hpath, domSha256, identityRowsSha256, attrsSha256, assetsSha256,
    }));
    return {
        hashVersion: BASELINE_HASH_VERSION,
        documentId, notebookId, path, hpath, domSha256, identityRowsSha256, attrsSha256, assetsSha256, fingerprint,
        blockIds, assets: normalizedAssets,
    };
}

const SNAPSHOT_CONSISTENCY_ATTEMPTS = 12;
const SNAPSHOT_RETRY_DELAY_MS = 600;
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Removing a document queues index work; conclude "gone" only after the
// kernel's SQL view has caught up.
async function identityRowsEventuallyAbsent(documentId: string, target?: TargetConnection): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!(await findBlockIdentityRows([documentId], target)).length) return true;
        await flushSqlQueue(target).catch(() => undefined);
        await sleep(SNAPSHOT_RETRY_DELAY_MS);
    }
    return !(await findBlockIdentityRows([documentId], target)).length;
}

export async function captureDocumentSnapshot(documentId: string, target?: TargetConnection): Promise<MirrorDocumentSnapshot> {
    assertNodeId(documentId, "document ID");
    // The kernel queues SQL index and tree-write work, so a snapshot taken
    // right after a write can transiently disagree with itself; flush first
    // and retry until DOM and indexed block rows agree.
    for (let attempt = 1; ; attempt += 1) {
        if (attempt > 1) {
            await flushSqlQueue(target).catch(() => undefined);
            await sleep(SNAPSHOT_RETRY_DELAY_MS);
        }
        const [location, dom, attrs, hpath, identityRows, assetPaths] = await Promise.all([
            getDocumentLocation(documentId, target), getBlockDOM(documentId, target), getBlockAttrs(documentId, target),
            getHPathByID(documentId, target), getBlockIdentityRows(documentId, target), getDocumentAssets(documentId, target),
        ]);
        const assets = await Promise.all([...assetPaths].sort().map(async (path) => {
            const content = await downloadWorkspaceFile(path, target);
            return { path, content, sha256: await sha256(content) };
        }));
        const baseline = await buildBaseline(documentId, location.notebookId, location.path, hpath, dom, attrs, identityRows, assets);
        const domBlockIds = extractBlockIds(dom, documentId);
        if (sameStrings(domBlockIds, baseline.blockIds)) {
            return {
                documentId, notebookId: location.notebookId, path: location.path, hpath, dom, attrs,
                managedAttrs: filterManagedRootAttrs(attrs), identityRows, blockIds: baseline.blockIds, assets, baseline,
            };
        }
        if (attempt >= SNAPSHOT_CONSISTENCY_ATTEMPTS) {
            throw new Error(`Exact mirror: DOM and SQL block ID sets differ for ${documentId}`);
        }
    }
}

export function classifyThreeWay(
    source: MirrorDocumentBaseline,
    destination: MirrorDocumentBaseline | null,
    baseline?: MirrorDocumentBaseline,
): MirrorConflictClassification {
    if (!destination) return "missing-destination";
    if (!baseline) return source.fingerprint === destination.fingerprint ? "unchanged" : "conflict";
    const sourceChanged = source.fingerprint !== baseline.fingerprint;
    const destinationChanged = destination.fingerprint !== baseline.fingerprint;
    if (!sourceChanged && !destinationChanged) return "unchanged";
    if (sourceChanged && !destinationChanged) return "source-changed";
    if (!sourceChanged && destinationChanged) return "destination-changed";
    if (source.fingerprint === destination.fingerprint) return "converged";
    return "conflict";
}

export function buildAttributePatch(source: BlockAttrs, destination: BlockAttrs): BlockAttrs {
    const patch: BlockAttrs = { ...source };
    for (const key of Object.keys(destination)) if (!(key in source)) patch[key] = "";
    return patch;
}

function sameStrings(left: string[], right: string[]): boolean {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameAssets(left: MirrorDocumentBaseline["assets"], right: MirrorDocumentBaseline["assets"]): boolean {
    const sort = (assets: MirrorDocumentBaseline["assets"]) => [...assets].sort((a, b) => a.path.localeCompare(b.path));
    return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function assertCommonSnapshot(source: MirrorDocumentSnapshot, destination: MirrorDocumentSnapshot): void {
    const differing: string[] = [];
    for (const key of Object.keys(source.baseline) as Array<keyof MirrorDocumentBaseline>) {
        if (JSON.stringify(source.baseline[key]) !== JSON.stringify(destination.baseline[key])) differing.push(String(key));
    }
    if (differing.length
        || !sameStrings(source.blockIds, destination.blockIds)
        || !sameAssets(source.baseline.assets, destination.baseline.assets)) {
        const rowsPart = differing.includes("identityRowsSha256")
            ? `; sourceRows=${JSON.stringify(source.identityRows.map((row) => ({ ...row, ial: normalizeIal(row.ial ?? "") })))}`
                + ` destinationRows=${JSON.stringify(destination.identityRows.map((row) => ({ ...row, ial: normalizeIal(row.ial ?? "") })))}`
            : "";
        throw new Error(
            `Exact mirror final verification differs for ${source.documentId} in [${differing.join(", ") || "block ID set"}]${rowsPart}`,
        );
    }
}

type UpdatedDocumentWrite = {
    before: MirrorDocumentSnapshot;
    expected: MirrorDocumentSnapshot;
    inverseAttrs: BlockAttrs;
    domApplied: boolean;
    attrsApplied: boolean;
};

type CreatedDocumentWrite = {
    documentId: string;
    notebookId: string;
    path: string;
    depth: number;
    expectedDom: string;
    expectedAttrs: BlockAttrs;
    placeholderDom?: string;
    placeholderAttrs?: BlockAttrs;
    createConfirmed: boolean;
    domApplied: boolean;
    attrsApplied: boolean;
};

type CreatedAssetWrite = { path: string; sha256: string; confirmed: boolean; residual: boolean };

async function inspectAssetWrite(item: CreatedAssetWrite, destination?: TargetConnection): Promise<"expected" | "absent" | "other"> {
    const current = await downloadWorkspaceFileIfExists(item.path, destination);
    if (!current) return "absent";
    return await sha256(current) === item.sha256 ? "expected" : "other";
}

interface RollbackResult {
    failures: string[];
    residualAssetPaths: string[];
}

async function rollback(
    updated: UpdatedDocumentWrite[],
    created: CreatedDocumentWrite[],
    createdAssets: CreatedAssetWrite[],
    ownershipErrors: string[],
    assertOwnership: () => Promise<void>,
    destination?: TargetConnection,
): Promise<RollbackResult> {
    const errors = [...ownershipErrors];
    const residualAssetPaths: string[] = [];
    for (const item of [...updated].reverse()) {
        try {
            const currentDom = await getBlockDOM(item.before.documentId, destination);
            const currentAttrs = await getBlockAttrs(item.before.documentId, destination);
            if (item.attrsApplied) {
                if (sameAttrs(currentAttrs, item.expected.managedAttrs)) {
                    try {
                        await assertOwnership();
                        await setBlockAttrs(item.before.documentId, item.inverseAttrs, destination);
                    }
                    catch (error) {
                        const afterFailure = await getBlockAttrs(item.before.documentId, destination).catch(() => ({}));
                        if (!sameAttrs(afterFailure, item.before.managedAttrs)) throw error;
                    }
                } else if (!sameAttrs(currentAttrs, item.before.managedAttrs)) {
                    errors.push(`restore ${item.before.documentId}: attributes no longer match operation-owned or original state`);
                    continue;
                }
            }
            if (item.domApplied) {
                if (sameRenderedDom(currentDom, item.expected.dom)) {
                    try {
                        await assertOwnership();
                        await updateBlockDOM(item.before.documentId, item.before.dom, destination);
                    }
                    catch (error) {
                        const afterFailure = await getBlockDOM(item.before.documentId, destination).catch(() => "");
                        if (!sameRenderedDom(afterFailure, item.before.dom)) throw error;
                    }
                } else if (!sameRenderedDom(currentDom, item.before.dom)) {
                    errors.push(`restore ${item.before.documentId}: DOM no longer matches operation-owned or original content`);
                    continue;
                }
            }
            const restored = await captureDocumentSnapshot(item.before.documentId, destination);
            if (restored.baseline.fingerprint !== item.before.baseline.fingerprint) {
                errors.push(`restore ${item.before.documentId}: inverse rollback fingerprint verification failed`);
            }
        } catch (error) { errors.push(`restore ${item.before.documentId}: ${errorText(error)}`); }
    }
    for (const item of [...created].sort((left, right) => right.depth - left.depth)) {
        if (!item.createConfirmed) continue;
        try {
            const location = await getDocumentLocation(item.documentId, destination);
            const currentDom = await getBlockDOM(item.documentId, destination);
            const currentAttrs = await getBlockAttrs(item.documentId, destination);
            const expectedDom = item.domApplied ? item.expectedDom : item.placeholderDom;
            const expectedAttrs = item.attrsApplied ? item.expectedAttrs : item.placeholderAttrs;
            if (location.notebookId !== item.notebookId || location.path !== item.path
                || !expectedDom || !sameRenderedDom(currentDom, expectedDom) || !expectedAttrs || !sameAttrs(currentAttrs, expectedAttrs)) {
                errors.push(`delete ${item.documentId}: current document does not match operation-owned path, DOM, and attributes`);
                continue;
            }
            try {
                await assertOwnership();
                await removeDocById(item.documentId, destination);
            }
            catch (error) {
                if (await identityRowsEventuallyAbsent(item.documentId, destination)) throw error;
            }
            if (!(await identityRowsEventuallyAbsent(item.documentId, destination))) {
                errors.push(`delete ${item.documentId}: document still exists after rollback`);
            }
        } catch (error) { errors.push(`delete ${item.documentId}: ${errorText(error)}`); }
    }
    for (const item of createdAssets) {
        if (!item.confirmed && !item.residual) continue;
        try {
            if (await inspectAssetWrite(item, destination) !== "absent") residualAssetPaths.push(item.path);
        } catch {
            residualAssetPaths.push(item.path);
        }
    }
    return { failures: errors, residualAssetPaths: [...new Set(residualAssetPaths)].sort() };
}

export interface ExactMirrorResult {
    count: number;
    warnings: string[];
    operationId: string;
}

export interface ExactMirrorOptions {
    /**
     * Overwrite destination content for documents that have no usable
     * baseline and currently differ from the source (first-sync conflicts,
     * e.g. after re-pairing or a hashVersion migration). Must only be set
     * after the user explicitly confirmed the destructive overwrite; the
     * default stays a conservative before-write abort.
     */
    adoptFirstBaselineConflicts?: boolean;
}

async function mirrorDocumentsExactUnlocked(
    docIds: string[],
    source?: TargetConnection,
    destination?: TargetConnection,
    options?: ExactMirrorOptions,
): Promise<ExactMirrorResult> {
    const selectedIds = [...new Set(docIds)];
    if (!selectedIds.length) return { count: 0, warnings: [], operationId: "" };
    selectedIds.forEach((id) => assertNodeId(id, "document ID"));
    let operationId: string | undefined;
    let pending: PendingMirrorOperation | undefined;
    let pendingPersisted = false;
    const updatedWrites: UpdatedDocumentWrite[] = [];
    const createdWrites: CreatedDocumentWrite[] = [];
    const assetWrites: CreatedAssetWrite[] = [];
    const ownershipErrors: string[] = [];

    const verifyPendingOwnership = async (): Promise<void> => {
        if (!pendingPersisted || !pending) throw new Error("Mirror data mutation attempted without an owned bilateral pending operation");
        await assertPendingOperationOwnership(pending, source, destination);
    };

    const rollbackAndMaybeClearPending = async (): Promise<RollbackResult> => {
        const result = await rollback(updatedWrites, createdWrites, assetWrites, ownershipErrors, verifyPendingOwnership, destination);
        if (!result.failures.length && pendingPersisted && pending) {
            try { await clearPendingAfterVerifiedRollback(pending, source, destination); }
            catch (error) { result.failures.push(`clear pending operation: ${errorText(error)}`); }
        }
        return result;
    };

    try {
        const status = await inspectMirrorPair(source, destination);
        if (!status.valid || !status.sourceIdentity || !status.destinationIdentity || !status.sourceRecord || !status.destinationRecord) {
            throw new Error(`Exact mirror requires a valid matching lineage: ${status.reasons.join("; ")}`);
        }
        const allowedNotebooks = new Set(status.allowedNotebookIds);
        const destinationNotebooks = await listNotebooks(destination);
        const destinationNotebookMap = new Map(destinationNotebooks.map((notebook) => [notebook.id, notebook]));
        const required = new Map<string, { documentId: string; path: string; parentId: string; depth: number; selected: boolean }>();
        for (const documentId of selectedIds) {
            const location = await getDocumentLocation(documentId, source);
            if (!allowedNotebooks.has(location.notebookId)) throw new Error(`Exact mirror notebook ${location.notebookId} is not allowed by the peer lineage`);
            for (const entry of ancestorEntries(location.path)) {
                const existing = required.get(entry.documentId);
                required.set(entry.documentId, { ...entry, selected: existing?.selected === true || entry.documentId === documentId });
            }
        }
        const notebookIds = [...new Set([...required.values()].map(({ path }) => path.split("/")[1]))];
        for (const notebookId of notebookIds) {
            const notebook = destinationNotebookMap.get(notebookId);
            if (!notebook) throw new Error(`Exact mirror requires destination notebook ${notebookId} to exist`);
            if (notebook.closed) await openNotebook(notebookId, destination);
            if (await isEncryptedNotebook(notebookId, source) || await isEncryptedNotebook(notebookId, destination)) {
                throw new Error("Exact mirror does not support encrypted notebooks");
            }
        }
        const sourceSnapshots = new Map<string, MirrorDocumentSnapshot>();
        for (const entry of [...required.values()].sort((left, right) => left.depth - right.depth)) {
            const snapshot = await captureDocumentSnapshot(entry.documentId, source);
            if (snapshot.path !== entry.path) throw new Error(`Exact mirror source path changed during preflight for ${entry.documentId}`);
            if (hasAttributeView(snapshot)) throw new Error(`Exact mirror does not support attribute-view-bound document ${entry.documentId}`);
            sourceSnapshots.set(entry.documentId, snapshot);
        }
        const allSourceBlockIds = [...new Set([...sourceSnapshots.values()].flatMap(({ blockIds }) => blockIds))];
        const destinationRows = await findBlockIdentityRows(allSourceBlockIds, destination);
        const rowsById = new Map(destinationRows.map((row) => [row.id, row]));
        const missingIds = new Set<string>();
        const existingIds = new Set<string>();
        for (const entry of required.values()) {
            const root = rowsById.get(entry.documentId);
            const notebookId = entry.path.split("/")[1];
            const apiPath = workspacePathToDocumentPath(entry.path);
            if (!root) missingIds.add(entry.documentId);
            else {
                existingIds.add(entry.documentId);
                if (root.root_id !== entry.documentId || root.box !== notebookId || root.path !== apiPath) {
                    throw new Error(`Exact mirror path or notebook mismatch for ${entry.documentId}`);
                }
                const destinationHPath = await getHPathByID(entry.documentId, destination);
                if (destinationHPath !== sourceSnapshots.get(entry.documentId)!.hpath) {
                    throw new Error(`Exact mirror rename or move is unsupported; HPath differs for ${entry.documentId}`);
                }
            }
        }
        for (const [id, row] of rowsById) {
            const owners = [...sourceSnapshots.values()].filter((snapshot) => snapshot.blockIds.includes(id));
            if (owners.length !== 1) throw new Error(`Exact mirror source block ID ${id} occurs in multiple documents`);
            const owner = owners[0];
            if (missingIds.has(owner.documentId) || row.root_id !== owner.documentId) throw new Error(`Exact mirror global block ID collision: ${id}`);
        }
        const destinationSnapshots = new Map<string, MirrorDocumentSnapshot>();
        const firstSyncConflicts: string[] = [];
        for (const entry of required.values()) {
            if (!entry.selected || !existingIds.has(entry.documentId)) continue;
            const snapshot = await captureDocumentSnapshot(entry.documentId, destination);
            destinationSnapshots.set(entry.documentId, snapshot);
            // Baselines computed by older plugin versions used different
            // fingerprint inputs; treat them as absent and require adoption.
            const storedBaseline = status.sourceRecord.baselines[entry.documentId];
            const usableBaseline = storedBaseline?.hashVersion === BASELINE_HASH_VERSION ? storedBaseline : undefined;
            const classification = classifyThreeWay(sourceSnapshots.get(entry.documentId)!.baseline, snapshot.baseline, usableBaseline);
            if (classification === "destination-changed" || classification === "conflict") {
                if (classification === "conflict" && !usableBaseline) {
                    // No baseline: destination may legitimately hold the last
                    // interrupted write. Never overwrite silently; report so
                    // the UI can offer an explicit source-authoritative adopt.
                    firstSyncConflicts.push(entry.documentId);
                    continue;
                }
                throw new Error(`Exact mirror conflict for ${entry.documentId}: ${classification}`);
            }
        }
        if (firstSyncConflicts.length && !options?.adoptFirstBaselineConflicts) {
            throw new MirrorOperationError(
                `Exact mirror first-sync conflict: destination content differs from the source for ${firstSyncConflicts.join(", ")} and no sync baseline exists; adopt the source version explicitly to proceed`,
                { state: "before-write", cause: "first-sync content conflict without baseline", firstSyncConflicts },
            );
        }
        const sourceAssets = new Map<string, { content: Blob; sha256: string }>();
        for (const entry of required.values()) {
            if (!entry.selected && !missingIds.has(entry.documentId)) continue;
            for (const asset of sourceSnapshots.get(entry.documentId)!.assets) {
                const previous = sourceAssets.get(asset.path);
                if (previous && previous.sha256 !== asset.sha256) throw new Error(`Exact mirror source asset hash conflict: ${asset.path}`);
                sourceAssets.set(asset.path, asset);
            }
        }
        const assetsToCreate = new Map<string, { content: Blob; sha256: string }>();
        for (const [path, sourceAsset] of sourceAssets) {
            const destinationAsset = await downloadWorkspaceFileIfExists(path, destination);
            if (!destinationAsset) assetsToCreate.set(path, sourceAsset);
            else if (await sha256(destinationAsset) !== sourceAsset.sha256) throw new Error(`Exact mirror destination asset hash conflict: ${path}`);
        }
        operationId = crypto.randomUUID();
        pending = {
            operationId, pairId: status.sourceRecord.pairId, sourceWorkspaceId: status.sourceIdentity.workspaceId,
            destinationWorkspaceId: status.destinationIdentity.workspaceId, documentIds: selectedIds.sort(), startedAt: new Date().toISOString(),
        };
        await persistPendingOperation(pending, source, destination);
        pendingPersisted = true;

        for (const [path, sourceAsset] of assetsToCreate) {
            const intended: CreatedAssetWrite = { path, sha256: sourceAsset.sha256, confirmed: false, residual: false };
            assetWrites.push(intended);
            try {
                await verifyPendingOwnership();
                await writeFile(path, sourceAsset.content, destination);
                intended.confirmed = true;
            } catch (error) {
                const state = await inspectAssetWrite(intended, destination).catch(() => "other" as const);
                if (state === "expected") intended.confirmed = true;
                else if (state === "other") intended.residual = true;
                throw error;
            }
        }
        for (const entry of [...required.values()].filter(({ documentId }) => missingIds.has(documentId)).sort((left, right) => left.depth - right.depth)) {
            const snapshot = sourceSnapshots.get(entry.documentId)!;
            const intended: CreatedDocumentWrite = {
                documentId: entry.documentId, notebookId: snapshot.notebookId, path: entry.path, depth: entry.depth,
                expectedDom: snapshot.dom, expectedAttrs: snapshot.managedAttrs, createConfirmed: false, domApplied: false, attrsApplied: false,
            };
            createdWrites.push(intended);
            try {
                await verifyPendingOwnership();
                await createDocWithMd({ notebookId: snapshot.notebookId, id: entry.documentId, parentId: entry.parentId, path: snapshot.hpath, markdown: "" }, destination);
                intended.createConfirmed = true;
                [intended.placeholderDom, intended.placeholderAttrs] = await Promise.all([
                    getBlockDOM(entry.documentId, destination),
                    getBlockAttrs(entry.documentId, destination).then(filterManagedRootAttrs),
                ]);
            } catch (error) {
                const rows = await findBlockIdentityRows([entry.documentId], destination).catch(() => []);
                if (rows.length) ownershipErrors.push(`create ${entry.documentId}: ambiguous failure left a document whose operation ownership cannot be verified`);
                throw error;
            }
        }
        for (const entry of [...required.values()].sort((left, right) => left.depth - right.depth)) {
            if (!entry.selected && !missingIds.has(entry.documentId)) continue;
            const expected = sourceSnapshots.get(entry.documentId)!;
            const before = destinationSnapshots.get(entry.documentId);
            const created = createdWrites.find((item) => item.documentId === entry.documentId);
            let updated: UpdatedDocumentWrite | undefined;
            if (before) {
                updated = {
                    before, expected, inverseAttrs: buildAttributePatch(before.managedAttrs, expected.managedAttrs), domApplied: false, attrsApplied: false,
                };
                updatedWrites.push(updated);
            }
            try {
                await verifyPendingOwnership();
                await updateBlockDOM(entry.documentId, expected.dom, destination);
                if (updated) updated.domApplied = true;
                if (created) created.domApplied = true;
            } catch (error) {
                const current = await getBlockDOM(entry.documentId, destination).catch(() => "");
                if (updated) {
                    if (sameRenderedDom(current, expected.dom)) updated.domApplied = true;
                    else if (!sameRenderedDom(current, before!.dom)) ownershipErrors.push(`update ${entry.documentId}: ambiguous DOM failure left unknown content`);
                } else if (created) {
                    if (sameRenderedDom(current, expected.dom)) created.domApplied = true;
                    else if (!sameRenderedDom(current, created.placeholderDom ?? "")) ownershipErrors.push(`update ${entry.documentId}: ambiguous DOM failure left unknown content`);
                }
                throw error;
            }
            const forwardAttrs = buildAttributePatch(expected.managedAttrs, before?.managedAttrs ?? {});
            try {
                await verifyPendingOwnership();
                await setBlockAttrs(entry.documentId, forwardAttrs, destination);
                if (updated) updated.attrsApplied = true;
                if (created) created.attrsApplied = true;
            } catch (error) {
                const current = await getBlockAttrs(entry.documentId, destination).catch(() => ({}));
                if (updated) {
                    if (sameAttrs(current, expected.managedAttrs)) updated.attrsApplied = true;
                    else if (!sameAttrs(current, before!.managedAttrs)) ownershipErrors.push(`update ${entry.documentId}: ambiguous attribute failure left unknown attributes`);
                } else if (created) {
                    if (sameAttrs(current, expected.managedAttrs)) created.attrsApplied = true;
                    else if (!sameAttrs(current, created.placeholderAttrs ?? {})) ownershipErrors.push(`update ${entry.documentId}: ambiguous attribute failure left unknown attributes`);
                }
                throw error;
            }
        }

        const baselines: Record<string, MirrorDocumentBaseline> = {};
        for (const entry of required.values()) {
            if (!entry.selected && !missingIds.has(entry.documentId)) continue;
            const sourceSnapshot = sourceSnapshots.get(entry.documentId)!;
            const destinationSnapshot = await captureDocumentSnapshot(entry.documentId, destination);
            assertCommonSnapshot(sourceSnapshot, destinationSnapshot);
            baselines[entry.documentId] = destinationSnapshot.baseline;
        }
        try {
            await verifyPendingOwnership();
            await commitMirrorBaselines(baselines, pending!, source, destination);
        } catch (error) {
            const rollbackResult = await rollbackAndMaybeClearPending();
            throw new MirrorOperationError("Exact mirror could not commit a verified common baseline after destination writes", {
                state: "metadata-commit", operationId, cause: errorText(error), rollbackErrors: rollbackResult.failures,
                residualAssetPaths: rollbackResult.residualAssetPaths,
            });
        }
        const warnings: string[] = [];
        try { await reloadFileTree(destination); }
        catch (error) {
            console.warn("Exact mirror completed but the SiYuan file tree could not be reloaded", error);
            warnings.push("The mirror completed, but the SiYuan file tree could not be reloaded automatically");
        }
        return { count: selectedIds.length, warnings, operationId };
    } catch (error) {
        if (error instanceof MirrorOperationError) throw error;
        if (!pendingPersisted) {
            throw new MirrorOperationError(`Exact mirror aborted before writing: ${errorText(error)}`, {
                state: "before-write", operationId, cause: errorText(error),
            });
        }
        const rollbackResult = await rollbackAndMaybeClearPending();
        throw new MirrorOperationError(
            rollbackResult.failures.length ? "Exact mirror failed and rollback or ownership verification was partial" : "Exact mirror failed and destination documents were fully verified as rolled back",
            {
                state: rollbackResult.failures.length ? "partial" : "rolled-back", operationId, cause: errorText(error),
                rollbackErrors: rollbackResult.failures, residualAssetPaths: rollbackResult.residualAssetPaths,
            },
        );
    }
}

export async function mirrorDocumentsExact(
    docIds: string[],
    source?: TargetConnection,
    destination?: TargetConnection,
    options?: ExactMirrorOptions,
): Promise<ExactMirrorResult> {
    return withMirrorOperationLock(source, destination, () => mirrorDocumentsExactUnlocked(docIds, source, destination, options));
}
