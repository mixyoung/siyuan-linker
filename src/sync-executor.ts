import {
    createDocWithMd,
    downloadWorkspaceFileIfExists,
    getBlockAttrs,
    getBlockDOM,
    moveDocById,
    reloadFileTree,
    removeDocById,
    renameDocById,
    setBlockAttrs,
    updateBlockDOM,
    writeFile,
    type BlockAttrs,
    type TargetConnection,
} from "./siyuan-api";
import {
    MirrorOperationError,
    type DeletionTombstone,
    type MirrorDocumentBaseline,
    type MirrorDocumentSnapshot,
    type PendingMirrorOperation,
} from "./mirror-types";
import {
    buildAttributePatch,
    captureDocumentSnapshot,
    filterManagedRootAttrs,
    normalizeDom,
    sha256,
} from "./mirror-service";
import {
    assertPendingOperationOwnership,
    clearPendingAfterVerifiedRollback,
    commitSyncBaselines,
    inspectMirrorPair,
    persistPendingOperation,
    resolveNotebookMapping,
    resolveReverseNotebookMapping,
    withMirrorOperationLock,
} from "./mirror-storage";
import type {
    SyncAction,
    SyncPlan,
    SyncProfile,
} from "./sync-types";
import { createScopeAdapter } from "./sync-adapters";
import { SyncPlanner, hpathTitle } from "./sync-planner";

export interface SyncExecutionResult {
    success: boolean;
    count: number;
    operationId: string;
    warnings: string[];
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

type DocumentWriteRecord = {
    docId: string;
    kind: "create" | "update" | "move";
    endpoint: TargetConnection | undefined;
    // update rollback
    prevDom?: string;
    prevAttrs?: BlockAttrs;
    // move rollback (previous placement on the target end)
    prevParentId?: string;
    prevTitle?: string;
    applied: boolean;
};

export class SyncExecutor {
    public async execute(
        plan: SyncPlan,
        source?: TargetConnection,
        destination?: TargetConnection,
    ): Promise<SyncExecutionResult> {
        // Adapter contract: `source` is the LOCAL end and `destination` the
        // REMOTE end. Each action declares the end it writes to via its
        // direction (engine fix E2: bidirectional plans no longer collapse
        // onto a single endpoint).
        const endpointOf = (action: Pick<SyncAction, "direction">): TargetConnection | undefined =>
            action.direction === "pull" ? source : destination;

        const unresolved = plan.conflicts.filter((conflict) => !conflict.resolution);
        if (unresolved.length > 0) {
            const reasons = unresolved.map((c) => `${c.objectId} (${c.classification}): ${c.reasons.join(", ")}`);
            throw new MirrorOperationError(`Sync plan has unresolved conflicts:\n${reasons.join("\n")}`, {
                state: "before-write",
                cause: "unresolved-conflicts",
            });
        }

        if (plan.totalActions === 0) {
            return { success: true, count: 0, operationId: "", warnings: [] };
        }

        const status = await inspectMirrorPair(source, destination);
        if (!status.valid || !status.sourceIdentity || !status.destinationIdentity || !status.sourceRecord || !status.destinationRecord) {
            throw new Error(`Sync requires a valid pairing: ${status.reasons.join("; ")}`);
        }

        const pairId = status.sourceRecord.pairId;
        const operationId = crypto.randomUUID();
        const startedAt = new Date().toISOString();

        const allDocIds = [
            ...plan.creates.map((a) => a.objectId),
            ...plan.updates.map((a) => a.objectId),
            ...plan.moves.map((a) => a.objectId),
            ...plan.deletes.map((a) => a.objectId),
        ];

        const pending: PendingMirrorOperation = {
            operationId,
            pairId,
            sourceWorkspaceId: status.sourceIdentity.workspaceId,
            destinationWorkspaceId: status.destinationIdentity.workspaceId,
            documentIds: [...new Set(allDocIds)].sort(),
            startedAt,
            scope: plan.profile.scope,
            actionsCount: plan.totalActions,
        };

        await persistPendingOperation(pending, source, destination);
        let pendingPersisted = true;

        const writeRecords: DocumentWriteRecord[] = [];
        const committedBaselines: Record<string, MirrorDocumentBaseline> = {};
        const tombstonesToRecord: DeletionTombstone[] = [];
        const tombstonesToClear: string[] = [];
        const warnings: string[] = [];
        const touchedEndpoints = new Set<TargetConnection | undefined>();

        const verifyPendingOwnership = async (): Promise<void> => {
            if (!pendingPersisted) throw new Error("Mirror data mutation attempted without an owned bilateral pending operation");
            await assertPendingOperationOwnership(pending, source, destination);
        };

        // The content side's notebook must be translated to the write end via
        // the lineage mapping: push content is local (forward mapping), pull
        // content is remote (inverse mapping).
        const targetNotebookFor = (action: SyncAction, contentNotebookId: string): string =>
            action.direction === "pull"
                ? resolveReverseNotebookMapping(status.sourceRecord!, contentNotebookId)
                : resolveNotebookMapping(status.sourceRecord!, contentNotebookId);

        const logicalParentId = (logicalPath: string): string => {
            const segments = logicalPath.split("/").filter(Boolean);
            if (segments.length < 2) return "";
            return segments[segments.length - 2].replace(/\.sy$/, "");
        };

        // Verifies the just-written document against the content snapshot:
        // DOM/attribute/block-set equality (independent of baseline hash
        // versions) plus physical placement on the mapped notebook — the same
        // guarantees the exact-mirror final verification enforces.
        const verifyWritten = async (action: SyncAction, content: MirrorDocumentSnapshot, endpoint: TargetConnection | undefined): Promise<MirrorDocumentBaseline> => {
            const written = await captureDocumentSnapshot(action.objectId, endpoint);
            if (normalizeDom(written.dom) !== normalizeDom(content.dom)) {
                throw new Error(`Sync final verification: ${action.objectId} DOM diverged after the write`);
            }
            const sortedAttrs = (attrs: BlockAttrs) => JSON.stringify(Object.keys(attrs).sort().map((key) => [key, attrs[key]]));
            if (sortedAttrs(written.managedAttrs) !== sortedAttrs(content.managedAttrs)) {
                throw new Error(`Sync final verification: ${action.objectId} attributes diverged after the write`);
            }
            if (JSON.stringify([...written.blockIds].sort()) !== JSON.stringify([...content.blockIds].sort())) {
                throw new Error(`Sync final verification: ${action.objectId} block ID set diverged after the write`);
            }
            const expectedNotebookId = targetNotebookFor(action, content.notebookId);
            const expectedLogical = content.baseline.logicalPath ?? content.path.split("/").slice(2).join("/");
            const writtenLogical = written.baseline.logicalPath ?? written.path.split("/").slice(2).join("/");
            if (written.notebookId !== expectedNotebookId || writtenLogical !== expectedLogical) {
                throw new Error(`Sync final verification: ${action.objectId} resides at ${written.notebookId}:${writtenLogical} but was expected at ${expectedNotebookId}:${expectedLogical}`);
            }
            return written.baseline;
        };

        try {
            // 1. Transfer assets for created and updated documents (per action endpoint).
            const assetMap = new Map<string, { content: Blob; endpoints: Set<TargetConnection | undefined> }>();
            for (const action of [...plan.creates, ...plan.updates]) {
                if (!action.sourceSnapshot) continue;
                for (const asset of action.sourceSnapshot.assets) {
                    const entry = assetMap.get(asset.path) ?? { content: asset.content, endpoints: new Set<TargetConnection | undefined>() };
                    entry.endpoints.add(endpointOf(action));
                    assetMap.set(asset.path, entry);
                }
            }
            for (const [assetPath, { content, endpoints }] of assetMap) {
                for (const endpoint of endpoints) {
                    await verifyPendingOwnership();
                    const existing = await downloadWorkspaceFileIfExists(assetPath, endpoint);
                    if (!existing || (await sha256(existing)) !== (await sha256(content))) {
                        await writeFile(assetPath, content, endpoint);
                    }
                }
            }

            // 2. Create documents (parents first; planner orders by depth).
            for (const action of plan.creates) {
                if (action.objectType !== "document" || !action.sourceSnapshot) continue;
                const endpoint = endpointOf(action);
                await verifyPendingOwnership();

                const content = action.sourceSnapshot;
                const mappedNotebookId = targetNotebookFor(action, content.notebookId);
                const parentId = logicalParentId(content.baseline.logicalPath ?? content.path.split("/").slice(2).join("/"));

                await createDocWithMd({
                    notebookId: mappedNotebookId,
                    id: action.objectId,
                    parentId,
                    path: content.hpath,
                    markdown: "",
                }, endpoint);
                // createDocWithMd seeds an empty document; apply the content
                // DOM and attributes in a second phase like the exact mirror.
                await updateBlockDOM(action.objectId, content.dom, endpoint);
                await setBlockAttrs(action.objectId, content.managedAttrs, endpoint);
                const record: DocumentWriteRecord = { docId: action.objectId, kind: "create", endpoint, applied: true };
                writeRecords.push(record);
                touchedEndpoints.add(endpoint);

                committedBaselines[action.objectId] = await verifyWritten(action, content, endpoint);
                tombstonesToClear.push(action.objectId);
            }

            // 3. Update documents.
            for (const action of plan.updates) {
                if (action.objectType !== "document" || !action.sourceSnapshot) continue;
                const endpoint = endpointOf(action);
                await verifyPendingOwnership();

                const content = action.sourceSnapshot;
                const prevDom = action.destinationSnapshot?.dom ?? await getBlockDOM(action.objectId, endpoint);
                const prevAttrs = action.destinationSnapshot?.managedAttrs
                    ?? filterManagedRootAttrs(await getBlockAttrs(action.objectId, endpoint));

                await updateBlockDOM(action.objectId, content.dom, endpoint);
                const patch = buildAttributePatch(content.managedAttrs, prevAttrs);
                await setBlockAttrs(action.objectId, patch, endpoint);
                writeRecords.push({ docId: action.objectId, kind: "update", endpoint, prevDom, prevAttrs, applied: true });
                touchedEndpoints.add(endpoint);

                committedBaselines[action.objectId] = await verifyWritten(action, content, endpoint);
                tombstonesToClear.push(action.objectId);
            }

            // 4. Move documents (real kernel move + rename; engine fix E3b).
            for (const action of plan.moves) {
                if (action.objectType !== "document" || !action.sourceSnapshot || !action.destinationSnapshot) continue;
                const endpoint = endpointOf(action);
                await verifyPendingOwnership();

                const content = action.sourceSnapshot;
                const target = action.destinationSnapshot;
                const contentLogical = content.baseline.logicalPath ?? content.path.split("/").slice(2).join("/");
                const targetLogical = target.baseline.logicalPath ?? target.path.split("/").slice(2).join("/");
                const newParentId = logicalParentId(contentLogical);
                const oldParentId = logicalParentId(targetLogical);
                const newTitle = hpathTitle(content.hpath);
                const oldTitle = hpathTitle(target.hpath);

                if (newParentId && newParentId !== oldParentId) {
                    await moveDocById(action.objectId, newParentId, endpoint);
                }
                if (newTitle && newTitle !== oldTitle) {
                    await renameDocById(action.objectId, newTitle, endpoint);
                }
                writeRecords.push({ docId: action.objectId, kind: "move", endpoint, prevParentId: oldParentId, prevTitle: oldTitle, applied: true });
                touchedEndpoints.add(endpoint);

                committedBaselines[action.objectId] = await verifyWritten(action, content, endpoint);
            }

            // 5. Delete documents (children first; planner orders by depth).
            for (const action of plan.deletes) {
                if (action.objectType !== "document") continue;
                const endpoint = endpointOf(action);
                await verifyPendingOwnership();

                await removeDocById(action.objectId, endpoint);
                touchedEndpoints.add(endpoint);
                tombstonesToRecord.push({
                    objectType: "document",
                    objectId: action.objectId,
                    logicalPath: action.logicalPath,
                    deletedByWorkspaceId: status.sourceIdentity.workspaceId,
                    deletedAt: new Date().toISOString(),
                    previousFingerprint: action.destinationSnapshot?.baseline.fingerprint ?? action.baseline?.fingerprint ?? "",
                });
            }

            // 6. Advance common baselines and clear pending.
            await verifyPendingOwnership();
            await commitSyncBaselines(committedBaselines, pending, source, destination, {
                tombstonesToRecord,
                tombstonesToClear,
                advanceGeneration: true,
            });
            pendingPersisted = false;

            // 7. Reload file trees on every touched end.
            for (const endpoint of touchedEndpoints) {
                try {
                    await reloadFileTree(endpoint);
                } catch (error) {
                    console.warn("Sync completed but the SiYuan file tree could not be reloaded", error);
                    warnings.push("File tree could not be reloaded automatically");
                }
            }

            return {
                success: true,
                count: plan.totalActions,
                operationId,
                warnings,
            };
        } catch (error) {
            // Best-effort rollback on each write's own endpoint, reverse order.
            if (pendingPersisted) {
                for (const record of [...writeRecords].reverse()) {
                    try {
                        if (record.kind === "update" && record.applied) {
                            if (record.prevDom !== undefined) await updateBlockDOM(record.docId, record.prevDom, record.endpoint);
                            if (record.prevAttrs !== undefined) await setBlockAttrs(record.docId, record.prevAttrs, record.endpoint);
                        } else if (record.kind === "create" && record.applied) {
                            await removeDocById(record.docId, record.endpoint);
                        } else if (record.kind === "move" && record.applied) {
                            if (record.prevParentId) await moveDocById(record.docId, record.prevParentId, record.endpoint);
                            if (record.prevTitle) await renameDocById(record.docId, record.prevTitle, record.endpoint);
                        }
                    } catch (rollbackError) {
                        console.warn(`Sync rollback step failed for ${record.docId}`, rollbackError);
                    }
                }
                try {
                    await clearPendingAfterVerifiedRollback(pending, source, destination);
                    pendingPersisted = false;
                } catch {
                    // Left pending for inspection.
                }
            }

            throw new MirrorOperationError(`Sync execution failed: ${errorText(error)}`, {
                state: pendingPersisted ? "partial" : "rolled-back",
                operationId,
                cause: errorText(error),
            });
        }
    }
}

export async function runSyncProfile(
    profile: SyncProfile,
    source?: TargetConnection,
    destination?: TargetConnection,
    options: {
        manualResolutions?: Record<string, "skip" | "source-wins" | "destination-wins">;
    } = {},
): Promise<SyncExecutionResult> {
    return withMirrorOperationLock(source, destination, async () => {
        const adapter = createScopeAdapter(profile, source, destination);
        await adapter.validateCapabilities();

        // Sequential: the document-scope destination capture consumes the
        // selection subtrees recorded during the source capture.
        const sourceSnapshot = await adapter.captureSource();
        const destinationSnapshot = await adapter.captureDestination();

        const status = await inspectMirrorPair(source, destination);
        const baselines = status.sourceRecord?.baselines ?? {};

        const planner = new SyncPlanner();
        const plan = planner.generatePlan(profile, sourceSnapshot, destinationSnapshot, baselines, options);

        const executor = new SyncExecutor();
        return executor.execute(plan, source, destination);
    });
}
