import type {
    MirrorConflictClassification,
    MirrorDocumentBaseline,
    MirrorDocumentSnapshot,
} from "./mirror-types";
import type {
    ConflictAuthority,
    DeletionPolicy,
    ExtendedConflictClassification,
    ScopeSnapshot,
    ScopeSnapshotItem,
    SyncAction,
    SyncConflict,
    SyncPlan,
    SyncProfile,
} from "./sync-types";

export interface PlannerOptions {
    manualResolutions?: Record<string, "skip" | "source-wins" | "destination-wins">;
}

export function formatSyncPlanSummary(plan: SyncPlan): string {
    const lines: string[] = [];
    const nbCreates = plan.creates.filter((a) => a.objectType === "notebook").length;
    const docCreates = plan.creates.filter((a) => a.objectType === "document").length;
    const docUpdates = plan.updates.filter((a) => a.objectType === "document").length;
    const docMoves = plan.moves.filter((a) => a.objectType === "document").length;
    const docDeletes = plan.deletes.filter((a) => a.objectType === "document").length;

    if (nbCreates > 0) lines.push(`将创建 ${nbCreates} 个笔记本`);
    if (docCreates > 0) lines.push(`将创建 ${docCreates} 篇文档`);
    if (docUpdates > 0) lines.push(`将更新 ${docUpdates} 篇文档`);
    if (docMoves > 0) lines.push(`将移动 ${docMoves} 篇文档`);
    if (docDeletes > 0) lines.push(`将删除 ${docDeletes} 篇文档`);
    if (plan.conflicts.length > 0) lines.push(`发现 ${plan.conflicts.length} 个冲突`);

    if (lines.length === 0) lines.push("双方内容已收敛，无须同步变更");
    return lines.join("\n");
}

export function sortActionsByDependency(actions: SyncAction[]): SyncAction[] {
    const notebookCreates = actions.filter((a) => a.objectType === "notebook" && a.type === "create");
    const docCreates = actions
        .filter((a) => a.objectType === "document" && a.type === "create")
        .sort((a, b) => {
            const depthA = a.sourceSnapshot?.path.split("/").length ?? 0;
            const depthB = b.sourceSnapshot?.path.split("/").length ?? 0;
            return depthA - depthB;
        });
    const moves = actions.filter((a) => a.type === "move");
    const updates = actions
        .filter((a) => a.objectType === "document" && a.type === "update")
        .sort((a, b) => {
            const depthA = a.sourceSnapshot?.path.split("/").length ?? 0;
            const depthB = b.sourceSnapshot?.path.split("/").length ?? 0;
            return depthA - depthB;
        });
    const deletes = actions
        .filter((a) => a.type === "delete")
        .sort((a, b) => {
            const depthA = a.destinationSnapshot?.path.split("/").length ?? 0;
            const depthB = b.destinationSnapshot?.path.split("/").length ?? 0;
            return depthB - depthA;
        });
    const noops = actions.filter((a) => a.type === "noop");

    return [...notebookCreates, ...docCreates, ...moves, ...updates, ...deletes, ...noops];
}

export class SyncPlanner {
    public generatePlan(
        profile: SyncProfile,
        sourceSnapshot: ScopeSnapshot,
        destinationSnapshot: ScopeSnapshot,
        baselines: Record<string, MirrorDocumentBaseline> = {},
        options: PlannerOptions = {},
    ): SyncPlan {
        const creates: SyncAction[] = [];
        const updates: SyncAction[] = [];
        const moves: SyncAction[] = [];
        const deletes: SyncAction[] = [];
        const noops: SyncAction[] = [];
        const conflicts: SyncConflict[] = [];

        const isPush = profile.direction === "push";
        const isPull = profile.direction === "pull";
        const isBidirectional = profile.direction === "bidirectional";

        const effectiveSourceWorkspaceId = isPull ? profile.remoteWorkspaceId : profile.localWorkspaceId;
        const effectiveDestinationWorkspaceId = isPull ? profile.localWorkspaceId : profile.remoteWorkspaceId;

        // Collect all document IDs from both snapshots and baselines
        const allDocIds = new Set<string>([
            ...sourceSnapshot.items.keys(),
            ...destinationSnapshot.items.keys(),
            ...Object.keys(baselines),
        ]);

        for (const docId of allDocIds) {
            const sourceItem = sourceSnapshot.items.get(docId);
            const destItem = destinationSnapshot.items.get(docId);
            const baseline = baselines[docId];

            if (sourceItem && destItem) {
                // Both sides have the document
                const sourceFingerprint = sourceItem.snapshot?.baseline.fingerprint;
                const destFingerprint = destItem.snapshot?.baseline.fingerprint;

                if (!baseline) {
                    // No baseline exists
                    if (sourceFingerprint === destFingerprint) {
                        noops.push({
                            id: docId,
                            type: "noop",
                            objectType: "document",
                            objectId: docId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            direction: isPull ? "pull" : "push",
                            reason: "converged-no-baseline",
                            baseline: destItem.snapshot?.baseline,
                        });
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: sourceItem.logicalPath,
                            title: sourceItem.hpath,
                            classification: "conflict",
                            sourceFingerprint,
                            destinationFingerprint: destFingerprint,
                            reasons: ["目标端该文档已存在且内容与源端不一致，且当前没有同步基线"],
                        });
                    }
                    continue;
                }

                // Baseline exists
                const sourceChanged = sourceFingerprint !== baseline.fingerprint;
                const destChanged = destFingerprint !== baseline.fingerprint;

                if (!sourceChanged && !destChanged) {
                    if (sourceItem.logicalPath !== destItem.logicalPath || sourceItem.hpath !== destItem.hpath) {
                        moves.push({
                            id: docId,
                            type: "move",
                            objectType: "document",
                            objectId: docId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            sourcePath: sourceItem.path,
                            destinationPath: destItem.path,
                            direction: isPull ? "pull" : "push",
                            sourceSnapshot: sourceItem.snapshot,
                            destinationSnapshot: destItem.snapshot,
                            baseline,
                        });
                    } else {
                        noops.push({
                            id: docId,
                            type: "noop",
                            objectType: "document",
                            objectId: docId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            direction: isPull ? "pull" : "push",
                            reason: "unchanged",
                            baseline,
                        });
                    }
                } else if (sourceChanged && !destChanged) {
                    // Only source changed
                    if (isPush || isBidirectional) {
                        updates.push({
                            id: docId,
                            type: "update",
                            objectType: "document",
                            objectId: docId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            sourcePath: sourceItem.path,
                            destinationPath: destItem.path,
                            direction: "push",
                            sourceSnapshot: sourceItem.snapshot,
                            destinationSnapshot: destItem.snapshot,
                            baseline,
                        });
                    } else if (isPull) {
                        // In pull mode, source is remote. If remote didn't change (dest did relative to baseline)
                        // This branch means local (sourceItem here) changed
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: sourceItem.logicalPath,
                            title: sourceItem.hpath,
                            classification: "destination-changed",
                            sourceFingerprint,
                            destinationFingerprint: destFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["拉取模式下本地发生了独立变更"],
                        });
                    }
                } else if (!sourceChanged && destChanged) {
                    // Only destination changed
                    if (isPush) {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: destItem.logicalPath,
                            title: destItem.hpath,
                            classification: "destination-changed",
                            sourceFingerprint,
                            destinationFingerprint: destFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["目标端发生了独立变更，安全推送模式默认阻止覆盖"],
                        });
                    } else if (isPull || isBidirectional) {
                        updates.push({
                            id: docId,
                            type: "update",
                            objectType: "document",
                            objectId: docId,
                            title: destItem.hpath,
                            logicalPath: destItem.logicalPath,
                            sourcePath: destItem.path,
                            destinationPath: sourceItem.path,
                            direction: "pull",
                            sourceSnapshot: destItem.snapshot,
                            destinationSnapshot: sourceItem.snapshot,
                            baseline,
                        });
                    }
                } else {
                    // Both changed!
                    if (sourceFingerprint === destFingerprint) {
                        // Converged!
                        noops.push({
                            id: docId,
                            type: "noop",
                            objectType: "document",
                            objectId: docId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            direction: "push",
                            reason: "converged",
                            baseline: destItem.snapshot?.baseline,
                        });
                    } else {
                        // Diverged
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: sourceItem.logicalPath,
                            title: sourceItem.hpath,
                            classification: "conflict",
                            sourceFingerprint,
                            destinationFingerprint: destFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["两端同时发生了不同修改，产生冲突分叉"],
                        });
                    }
                }
            } else if (sourceItem && !destItem) {
                // Source has document, destination missing
                if (!baseline) {
                    // Brand new document on source -> create on destination
                    creates.push({
                        id: docId,
                        type: "create",
                        objectType: "document",
                        objectId: docId,
                        title: sourceItem.hpath,
                        logicalPath: sourceItem.logicalPath,
                        direction: isPull ? "pull" : "push",
                        sourceSnapshot: sourceItem.snapshot,
                    });
                } else {
                    // Document existed before in baseline, but destination deleted it
                    const sourceChanged = sourceItem.snapshot?.baseline.fingerprint !== baseline.fingerprint;
                    if (sourceChanged) {
                        // One side deleted, other side modified -> conflict
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: sourceItem.logicalPath,
                            title: sourceItem.hpath,
                            classification: "delete-modify",
                            sourceFingerprint: sourceItem.snapshot?.baseline.fingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["目标端删除了该文档，但源端进行了修改"],
                        });
                    } else {
                        // Single-side deletion on destination
                        if (isBidirectional) {
                            if (profile.deletionPolicy === "mirror-delete" || profile.deletionPolicy === "archive-and-delete") {
                                deletes.push({
                                    id: docId,
                                    type: "delete",
                                    objectType: "document",
                                    objectId: docId,
                                    title: sourceItem.hpath,
                                    logicalPath: sourceItem.logicalPath,
                                    direction: "pull",
                                    sourceSnapshot: sourceItem.snapshot,
                                    baseline,
                                });
                            } else {
                                noops.push({
                                    id: docId,
                                    type: "noop",
                                    objectType: "document",
                                    objectId: docId,
                                    logicalPath: sourceItem.logicalPath,
                                    direction: "push",
                                    reason: "deletion-ignored",
                                    baseline,
                                });
                            }
                        } else {
                            // In push mode, source still has it; push it back
                            creates.push({
                                id: docId,
                                type: "create",
                                objectType: "document",
                                objectId: docId,
                                title: sourceItem.hpath,
                                logicalPath: sourceItem.logicalPath,
                                direction: "push",
                                sourceSnapshot: sourceItem.snapshot,
                            });
                        }
                    }
                }
            } else if (!sourceItem && destItem) {
                // Destination has document, source missing
                if (!baseline) {
                    // New document on destination
                    if (isBidirectional || isPull) {
                        creates.push({
                            id: docId,
                            type: "create",
                            objectType: "document",
                            objectId: docId,
                            title: destItem.hpath,
                            logicalPath: destItem.logicalPath,
                            direction: "pull",
                            sourceSnapshot: destItem.snapshot,
                        });
                    } else {
                        // In push mode, destination has extra document
                        noops.push({
                            id: docId,
                            type: "noop",
                            objectType: "document",
                            objectId: docId,
                            logicalPath: destItem.logicalPath,
                            direction: "push",
                            reason: "destination-only",
                        });
                    }
                } else {
                    // Document was in baseline, but deleted on source
                    const destChanged = destItem.snapshot?.baseline.fingerprint !== baseline.fingerprint;
                    if (destChanged) {
                        // Source deleted, destination modified -> conflict
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: destItem.logicalPath,
                            title: destItem.hpath,
                            classification: "modify-delete",
                            destinationFingerprint: destItem.snapshot?.baseline.fingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["源端删除了该文档，但目标端进行了修改"],
                        });
                    } else {
                        // Single-side deletion on source
                        if (isPush || isBidirectional) {
                            if (profile.deletionPolicy === "mirror-delete" || profile.deletionPolicy === "archive-and-delete") {
                                deletes.push({
                                    id: docId,
                                    type: "delete",
                                    objectType: "document",
                                    objectId: docId,
                                    title: destItem.hpath,
                                    logicalPath: destItem.logicalPath,
                                    direction: "push",
                                    destinationSnapshot: destItem.snapshot,
                                    baseline,
                                });
                            } else {
                                noops.push({
                                    id: docId,
                                    type: "noop",
                                    objectType: "document",
                                    objectId: docId,
                                    logicalPath: destItem.logicalPath,
                                    direction: "push",
                                    reason: "deletion-ignored",
                                    baseline,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Apply conflict policy resolutions if configured
        const remainingConflicts: SyncConflict[] = [];
        for (const conflict of conflicts) {
            const manualChoice = options.manualResolutions?.[conflict.objectId];
            if (manualChoice) {
                conflict.resolution = manualChoice;
                if (manualChoice === "source-wins") {
                    const sourceItem = sourceSnapshot.items.get(conflict.objectId);
                    const destItem = destinationSnapshot.items.get(conflict.objectId);
                    if (sourceItem) {
                        updates.push({
                            id: conflict.objectId,
                            type: destItem ? "update" : "create",
                            objectType: conflict.objectType,
                            objectId: conflict.objectId,
                            title: sourceItem.hpath,
                            logicalPath: sourceItem.logicalPath,
                            direction: "push",
                            sourceSnapshot: sourceItem.snapshot,
                            destinationSnapshot: destItem?.snapshot,
                        });
                    }
                    continue;
                } else if (manualChoice === "destination-wins") {
                    const sourceItem = sourceSnapshot.items.get(conflict.objectId);
                    const destItem = destinationSnapshot.items.get(conflict.objectId);
                    if (destItem) {
                        updates.push({
                            id: conflict.objectId,
                            type: sourceItem ? "update" : "create",
                            objectType: conflict.objectType,
                            objectId: conflict.objectId,
                            title: destItem.hpath,
                            logicalPath: destItem.logicalPath,
                            direction: "pull",
                            sourceSnapshot: destItem.snapshot,
                            destinationSnapshot: sourceItem?.snapshot,
                        });
                    }
                    continue;
                }
            }

            if (profile.conflictPolicy === "authority-wins") {
                const authority = profile.conflictAuthority ?? (isPull ? "remote" : "local");
                const sourceWins = authority === "local" || authority === "direction-source";
                conflict.resolution = sourceWins ? "source-wins" : "destination-wins";

                const sourceItem = sourceSnapshot.items.get(conflict.objectId);
                const destItem = destinationSnapshot.items.get(conflict.objectId);

                if (sourceWins && sourceItem) {
                    updates.push({
                        id: conflict.objectId,
                        type: destItem ? "update" : "create",
                        objectType: conflict.objectType,
                        objectId: conflict.objectId,
                        title: sourceItem.hpath,
                        logicalPath: sourceItem.logicalPath,
                        direction: "push",
                        sourceSnapshot: sourceItem.snapshot,
                        destinationSnapshot: destItem?.snapshot,
                    });
                    continue;
                } else if (!sourceWins && destItem) {
                    updates.push({
                        id: conflict.objectId,
                        type: sourceItem ? "update" : "create",
                        objectType: conflict.objectType,
                        objectId: conflict.objectId,
                        title: destItem.hpath,
                        logicalPath: destItem.logicalPath,
                        direction: "pull",
                        sourceSnapshot: destItem.snapshot,
                        destinationSnapshot: sourceItem?.snapshot,
                    });
                    continue;
                }
            }

            remainingConflicts.push(conflict);
        }

        const sortedCreates = sortActionsByDependency(creates);
        const sortedUpdates = sortActionsByDependency(updates);
        const sortedMoves = sortActionsByDependency(moves);
        const sortedDeletes = sortActionsByDependency(deletes);
        const sortedNoops = sortActionsByDependency(noops);

        const totalActions = sortedCreates.length + sortedUpdates.length + sortedMoves.length + sortedDeletes.length;

        return {
            profile,
            effectiveSourceWorkspaceId,
            effectiveDestinationWorkspaceId,
            creates: sortedCreates,
            updates: sortedUpdates,
            moves: sortedMoves,
            deletes: sortedDeletes,
            noops: sortedNoops,
            conflicts: remainingConflicts,
            totalActions,
        };
    }
}
