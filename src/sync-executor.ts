import {
    createDocWithMd,
    downloadWorkspaceFileIfExists,
    getBlockAttrs,
    getBlockDOM,
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
    type DeletionTombstone,
    type MirrorDocumentBaseline,
    type PendingMirrorOperation,
} from "./mirror-types";
import {
    buildAttributePatch,
    captureDocumentSnapshot,
    filterManagedRootAttrs,
    sha256,
} from "./mirror-service";
import {
    assertPendingOperationOwnership,
    clearPendingAfterVerifiedRollback,
    commitSyncBaselines,
    inspectMirrorPair,
    persistPendingOperation,
    resolveNotebookMapping,
    withMirrorOperationLock,
} from "./mirror-storage";
import type {
    SyncPlan,
    SyncProfile,
} from "./sync-types";
import { createScopeAdapter } from "./sync-adapters";
import { SyncPlanner } from "./sync-planner";

export interface SyncExecutionResult {
    success: boolean;
    count: number;
    operationId: string;
    warnings: string[];
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class SyncExecutor {
    public async execute(
        plan: SyncPlan,
        source?: TargetConnection,
        destination?: TargetConnection,
    ): Promise<SyncExecutionResult> {
        if (plan.conflicts.length > 0) {
            const reasons = plan.conflicts.map((c) => `${c.objectId} (${c.classification}): ${c.reasons.join(", ")}`);
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
        const targetEndpoint = plan.profile.direction === "pull" ? source : destination;

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

        const createdDocs: string[] = [];
        const updatedDocs: Array<{ docId: string; prevDom: string; prevAttrs: BlockAttrs }> = [];
        const committedBaselines: Record<string, MirrorDocumentBaseline> = {};
        const tombstonesToRecord: DeletionTombstone[] = [];
        const tombstonesToClear: string[] = [];
        const warnings: string[] = [];

        try {
            // 1. Transfer assets for created and updated documents
            const assetMap = new Map<string, Blob>();
            for (const action of [...plan.creates, ...plan.updates]) {
                if (action.sourceSnapshot) {
                    for (const asset of action.sourceSnapshot.assets) {
                        assetMap.set(asset.path, asset.content);
                    }
                }
            }

            for (const [assetPath, content] of assetMap) {
                await assertPendingOperationOwnership(pending, source, destination);
                const existingAsset = await downloadWorkspaceFileIfExists(assetPath, targetEndpoint);
                if (!existingAsset || (await sha256(existingAsset)) !== (await sha256(content))) {
                    await writeFile(assetPath, content, targetEndpoint);
                }
            }

            // 2. Create documents (parents first)
            for (const action of plan.creates) {
                if (action.objectType !== "document" || !action.sourceSnapshot) continue;
                await assertPendingOperationOwnership(pending, source, destination);

                const srcSnap = action.sourceSnapshot;
                const mappedNotebookId = resolveNotebookMapping(status.sourceRecord, srcSnap.notebookId) ?? srcSnap.notebookId;
                const segments = srcSnap.path.split("/");
                const parentId = segments.length > 3 ? segments[segments.length - 2].replace(/\.sy$/, "") : "";

                await createDocWithMd({
                    notebookId: mappedNotebookId,
                    id: action.objectId,
                    parentId,
                    path: srcSnap.hpath,
                    markdown: "",
                }, targetEndpoint);
                createdDocs.push(action.objectId);

                await updateBlockDOM(action.objectId, srcSnap.dom, targetEndpoint);
                await setBlockAttrs(action.objectId, srcSnap.managedAttrs, targetEndpoint);

                const newSnap = await captureDocumentSnapshot(action.objectId, targetEndpoint);
                committedBaselines[action.objectId] = newSnap.baseline;
                tombstonesToClear.push(action.objectId);
            }

            // 3. Update documents
            for (const action of plan.updates) {
                if (action.objectType !== "document" || !action.sourceSnapshot) continue;
                await assertPendingOperationOwnership(pending, source, destination);

                const srcSnap = action.sourceSnapshot;
                const prevDom = action.destinationSnapshot?.dom ?? (await getBlockDOM(action.objectId, targetEndpoint).catch(() => ""));
                const prevAttrs = action.destinationSnapshot?.managedAttrs ?? filterManagedRootAttrs(await getBlockAttrs(action.objectId, targetEndpoint).catch(() => ({})));

                updatedDocs.push({ docId: action.objectId, prevDom, prevAttrs });

                await updateBlockDOM(action.objectId, srcSnap.dom, targetEndpoint);
                const patch = buildAttributePatch(srcSnap.managedAttrs, prevAttrs);
                await setBlockAttrs(action.objectId, patch, targetEndpoint);

                const newSnap = await captureDocumentSnapshot(action.objectId, targetEndpoint);
                committedBaselines[action.objectId] = newSnap.baseline;
                tombstonesToClear.push(action.objectId);
            }

            // 4. Move documents
            for (const action of plan.moves) {
                if (action.objectType !== "document" || !action.sourceSnapshot) continue;
                await assertPendingOperationOwnership(pending, source, destination);

                const srcSnap = action.sourceSnapshot;
                await updateBlockDOM(action.objectId, srcSnap.dom, targetEndpoint);
                await setBlockAttrs(action.objectId, srcSnap.managedAttrs, targetEndpoint);

                const newSnap = await captureDocumentSnapshot(action.objectId, targetEndpoint);
                committedBaselines[action.objectId] = newSnap.baseline;
            }

            // 5. Delete documents (children first)
            for (const action of plan.deletes) {
                if (action.objectType !== "document") continue;
                await assertPendingOperationOwnership(pending, source, destination);

                await removeDocById(action.objectId, targetEndpoint);
                tombstonesToRecord.push({
                    objectType: "document",
                    objectId: action.objectId,
                    logicalPath: action.logicalPath,
                    deletedByWorkspaceId: status.sourceIdentity.workspaceId,
                    deletedAt: new Date().toISOString(),
                    previousFingerprint: action.destinationSnapshot?.baseline.fingerprint ?? action.baseline?.fingerprint ?? "",
                });
            }

            // 6. Advance common baselines and clear pending
            await assertPendingOperationOwnership(pending, source, destination);
            await commitSyncBaselines(committedBaselines, pending, source, destination, {
                tombstonesToRecord,
                tombstonesToClear,
                advanceGeneration: true,
            });
            pendingPersisted = false;

            // 7. Reload file tree
            try {
                await reloadFileTree(targetEndpoint);
            } catch (error) {
                warnings.push("File tree could not be reloaded automatically");
            }

            return {
                success: true,
                count: plan.totalActions,
                operationId,
                warnings,
            };
        } catch (error) {
            // Best-effort rollback
            if (pendingPersisted) {
                try {
                    for (const { docId, prevDom, prevAttrs } of updatedDocs.reverse()) {
                        await updateBlockDOM(docId, prevDom, targetEndpoint).catch(() => undefined);
                        await setBlockAttrs(docId, prevAttrs, targetEndpoint).catch(() => undefined);
                    }
                    for (const docId of createdDocs.reverse()) {
                        await removeDocById(docId, targetEndpoint).catch(() => undefined);
                    }
                    await clearPendingAfterVerifiedRollback(pending, source, destination);
                    pendingPersisted = false;
                } catch {
                    // Left in pending state for inspection
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

        const [sourceSnapshot, destinationSnapshot] = await Promise.all([
            adapter.captureSource(),
            adapter.captureDestination(),
        ]);

        const status = await inspectMirrorPair(source, destination);
        const baselines = status.sourceRecord?.baselines ?? {};

        const planner = new SyncPlanner();
        const plan = planner.generatePlan(profile, sourceSnapshot, destinationSnapshot, baselines, options);

        const executor = new SyncExecutor();
        return executor.execute(plan, source, destination);
    });
}
