import type {
    MirrorDocumentBaseline,
} from "./mirror-types";
import type {
    ScopeSnapshot,
    ScopeSnapshotItem,
    SyncAction,
    SyncConflict,
    SyncPlan,
    SyncProfile,
} from "./sync-types";

export interface PlannerOptions {
    /**
     * Per-document manual conflict decisions. Values follow the DESIGN's
     * local/remote semantics: "source-wins" keeps the LOCAL end's content,
     * "destination-wins" keeps the REMOTE end's content, "skip" leaves the
     * object unresolved without advancing its baseline.
     */
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

// Baselines since v5 store the notebook-independent logical path; older
// baselines derive it by stripping the physical notebook prefix.
function baselineLogicalPath(baseline: MirrorDocumentBaseline): string {
    return baseline.logicalPath ?? baseline.path.split("/").slice(2).join("/");
}

// Items built by older callers may omit the denormalized hpath; the snapshot
// always carries it.
function itemHpath(item: ScopeSnapshotItem | undefined): string {
    return item?.hpath ?? item?.snapshot?.hpath ?? "";
}

function hpathTitle(hpath: string): string {
    const segments = hpath.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "";
}

export class SyncPlanner {
    public generatePlan(
        profile: SyncProfile,
        sourceSnapshot: ScopeSnapshot,
        destinationSnapshot: ScopeSnapshot,
        baselines: Record<string, MirrorDocumentBaseline> = {},
        options: PlannerOptions = {},
    ): SyncPlan {
        // Adapter contract: sourceSnapshot is captured on the LOCAL end and
        // destinationSnapshot on the REMOTE end, regardless of direction.
        const localItems = sourceSnapshot.items;
        const remoteItems = destinationSnapshot.items;

        // Design §7.2: direction-source is meaningless for bidirectional
        // tasks and must be rejected instead of guessed.
        if (profile.direction === "bidirectional" && profile.conflictAuthority === "direction-source") {
            throw new Error("Bidirectional sync cannot use conflictAuthority=direction-source; choose local or remote");
        }

        const isPush = profile.direction === "push";
        const isPull = profile.direction === "pull";
        const isBidirectional = profile.direction === "bidirectional";
        // The effective source end is remote for pulls; local otherwise.
        const effectiveSourceIsRemote = isPull;

        const creates: SyncAction[] = [];
        const updates: SyncAction[] = [];
        const moves: SyncAction[] = [];
        const deletes: SyncAction[] = [];
        const noops: SyncAction[] = [];
        const conflicts: SyncConflict[] = [];

        const allDocIds = new Set<string>([
            ...localItems.keys(),
            ...remoteItems.keys(),
            ...Object.keys(baselines),
        ]);

        for (const docId of allDocIds) {
            const localItem = localItems.get(docId);
            const remoteItem = remoteItems.get(docId);
            const baseline = baselines[docId];

            if (localItem && remoteItem) {
                const localFingerprint = localItem.snapshot?.baseline.fingerprint;
                const remoteFingerprint = remoteItem.snapshot?.baseline.fingerprint;

                if (!baseline) {
                    if (localFingerprint === remoteFingerprint
                        && localItem.logicalPath === remoteItem.logicalPath
                        && itemHpath(localItem) === itemHpath(remoteItem)) {
                        noops.push(this.buildNoop(docId, localItem, remoteItem, "converged-no-baseline"));
                    } else {
                        // Without a baseline a path divergence cannot be
                        // classified as a move; stay conservative (engine fix E3).
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "conflict",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            reasons: ["目标端该文档已存在且内容或位置与源端不一致，且当前没有同步基线"],
                        });
                    }
                    continue;
                }

                const localChanged = localFingerprint !== baseline.fingerprint;
                const remoteChanged = remoteFingerprint !== baseline.fingerprint;
                const baselineLogical = baselineLogicalPath(baseline);
                const localMoved = localItem.logicalPath !== baselineLogical || itemHpath(localItem) !== baseline.hpath;
                const remoteMoved = remoteItem.logicalPath !== baselineLogical || itemHpath(remoteItem) !== baseline.hpath;

                if (localMoved && remoteMoved) {
                    if (localItem.logicalPath === remoteItem.logicalPath && itemHpath(localItem) === itemHpath(remoteItem)) {
                        // Converged move: apply an idempotent move so the
                        // committed baseline records the new location.
                        moves.push(this.buildMove(docId, localItem, remoteItem, baseline, "push"));
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "diverged",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["两端把同一文档移动到了不同位置，产生分叉"],
                        });
                    }
                    continue;
                }

                if (localMoved || remoteMoved) {
                    const movedOnRemote = remoteMoved;
                    if (isBidirectional || (movedOnRemote && isPull) || (!movedOnRemote && isPush)) {
                        // The moving end is the content side for this
                        // direction; propagate its new location to the other
                        // end (engine fix E3: judged against the baseline, and
                        // the executor performs a real move).
                        moves.push(this.buildMove(docId, localItem, remoteItem, baseline, movedOnRemote ? "pull" : "push"));
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "conflict",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: [isPull ? "拉取模式下本地端发生了独立的移动" : "推送模式下目标端发生了独立的移动"],
                        });
                    }
                    continue;
                }

                if (!localChanged && !remoteChanged) {
                    noops.push(this.buildNoop(docId, localItem, remoteItem, "unchanged"));
                } else if (localChanged && !remoteChanged) {
                    if (isPush || isBidirectional) {
                        updates.push(this.buildUpdate(docId, localItem, remoteItem, baseline, "push"));
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "destination-changed",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["拉取模式下本地发生了独立变更"],
                        });
                    }
                } else if (!localChanged && remoteChanged) {
                    if (isPull || isBidirectional) {
                        updates.push(this.buildUpdate(docId, localItem, remoteItem, baseline, "pull"));
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "destination-changed",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["目标端发生了独立变更，安全推送模式默认阻止覆盖"],
                        });
                    }
                } else {
                    if (localFingerprint === remoteFingerprint) {
                        noops.push(this.buildNoop(docId, localItem, remoteItem, "converged"));
                    } else {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "conflict",
                            sourceFingerprint: localFingerprint,
                            destinationFingerprint: remoteFingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["两端同时发生了不同修改，产生冲突分叉"],
                        });
                    }
                }
            } else if (localItem && !remoteItem) {
                if (!baseline) {
                    if (isPush || isBidirectional) {
                        creates.push(this.buildCreate(docId, localItem, "push"));
                    } else {
                        noops.push(this.buildNoop(docId, localItem, undefined, "remote-only-under-pull"));
                    }
                } else {
                    const localChanged = localItem.snapshot?.baseline.fingerprint !== baseline.fingerprint;
                    if (localChanged) {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: localItem.logicalPath,
                            title: itemHpath(localItem),
                            classification: "delete-modify",
                            sourceFingerprint: localItem.snapshot?.baseline.fingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["目标端删除了该文档，但源端进行了修改"],
                        });
                    } else {
                        if (isBidirectional) {
                            if (profile.deletionPolicy === "mirror-delete" || profile.deletionPolicy === "archive-and-delete") {
                                deletes.push({
                                    id: docId,
                                    type: "delete",
                                    objectType: "document",
                                    objectId: docId,
                                    title: itemHpath(localItem),
                                    logicalPath: localItem.logicalPath,
                                    direction: "pull",
                                    destinationSnapshot: localItem.snapshot,
                                    baseline,
                                });
                            } else {
                                noops.push(this.buildNoop(docId, localItem, undefined, "deletion-ignored"));
                            }
                        } else if (isPush) {
                            creates.push(this.buildCreate(docId, localItem, "push"));
                        }
                    }
                }
            } else if (!localItem && remoteItem) {
                if (!baseline) {
                    if (isPull || isBidirectional) {
                        creates.push(this.buildCreate(docId, remoteItem, "pull"));
                    } else {
                        noops.push(this.buildNoop(docId, undefined, remoteItem, "local-only-under-push"));
                    }
                } else {
                    const remoteChanged = remoteItem.snapshot?.baseline.fingerprint !== baseline.fingerprint;
                    if (remoteChanged) {
                        conflicts.push({
                            objectId: docId,
                            objectType: "document",
                            logicalPath: remoteItem.logicalPath,
                            title: itemHpath(remoteItem),
                            classification: "modify-delete",
                            destinationFingerprint: remoteItem.snapshot?.baseline.fingerprint,
                            baselineFingerprint: baseline.fingerprint,
                            reasons: ["源端删除了该文档，但目标端进行了修改"],
                        });
                    } else {
                        if (isPush || isBidirectional) {
                            if (profile.deletionPolicy === "mirror-delete" || profile.deletionPolicy === "archive-and-delete") {
                                deletes.push({
                                    id: docId,
                                    type: "delete",
                                    objectType: "document",
                                    objectId: docId,
                                    title: itemHpath(remoteItem),
                                    logicalPath: remoteItem.logicalPath,
                                    direction: "push",
                                    destinationSnapshot: remoteItem.snapshot,
                                    baseline,
                                });
                            } else {
                                noops.push(this.buildNoop(docId, undefined, remoteItem, "deletion-ignored"));
                            }
                        }
                    }
                }
            }
        }

        // Conflict resolution precedence (engine fix E4):
        //   explicit manual decision > conflictPolicy > unresolved.
        // A manual "skip" is final: the object stays unresolved, produces no
        // action, and must NOT be overridden by an authority-wins policy.
        const remainingConflicts: SyncConflict[] = [];
        for (const conflict of conflicts) {
            const manual = options.manualResolutions?.[conflict.objectId];

            if (manual === "skip") {
                conflict.resolution = "skip";
                continue;
            }

            let winner: "local" | "remote" | undefined;
            if (manual === "source-wins") {
                winner = "local";
            } else if (manual === "destination-wins") {
                winner = "remote";
            } else if (profile.conflictPolicy === "authority-wins") {
                const authority = profile.conflictAuthority ?? "direction-source";
                if (authority === "local") winner = "local";
                else if (authority === "remote") winner = "remote";
                // direction-source resolves to the EFFECTIVE source end:
                // remote under pull, local under push/bidirectional (the
                // bidirectional combination was rejected above).
                else winner = effectiveSourceIsRemote ? "remote" : "local";
            }

            if (!winner) {
                remainingConflicts.push(conflict);
                continue;
            }

            conflict.resolution = winner === "local" ? "source-wins" : "destination-wins";
            const localItem = localItems.get(conflict.objectId);
            const remoteItem = remoteItems.get(conflict.objectId);
            if (winner === "local" && localItem) {
                updates.push(this.buildUpdate(conflict.objectId, localItem, remoteItem, baselines[conflict.objectId], "push"));
            } else if (winner === "remote" && remoteItem) {
                updates.push(this.buildUpdate(conflict.objectId, localItem, remoteItem, baselines[conflict.objectId], "pull"));
            }
        }

        const sortedCreates = sortActionsByDependency(creates);
        const sortedUpdates = sortActionsByDependency(updates);
        const sortedMoves = sortActionsByDependency(moves);
        const sortedDeletes = sortActionsByDependency(deletes);
        const sortedNoops = sortActionsByDependency(noops);

        const totalActions = sortedCreates.length + sortedUpdates.length + sortedMoves.length + sortedDeletes.length;

        return {
            profile,
            effectiveSourceWorkspaceId: effectiveSourceIsRemote
                ? profile.remoteWorkspaceId
                : profile.localWorkspaceId,
            effectiveDestinationWorkspaceId: effectiveSourceIsRemote
                ? profile.localWorkspaceId
                : profile.remoteWorkspaceId,
            creates: sortedCreates,
            updates: sortedUpdates,
            moves: sortedMoves,
            deletes: sortedDeletes,
            noops: sortedNoops,
            conflicts: remainingConflicts,
            totalActions,
        };
    }

    private buildNoop(docId: string, localItem: ScopeSnapshotItem | undefined, remoteItem: ScopeSnapshotItem | undefined, reason: string): SyncAction {
        return {
            id: docId,
            type: "noop",
            objectType: "document",
            objectId: docId,
            title: itemHpath(localItem ?? remoteItem),
            logicalPath: (localItem ?? remoteItem)?.logicalPath ?? "",
            direction: "push",
            reason,
            sourceSnapshot: localItem?.snapshot,
            destinationSnapshot: remoteItem?.snapshot,
            baseline: undefined,
        };
    }

    private buildCreate(docId: string, contentItem: ScopeSnapshotItem, direction: "push" | "pull"): SyncAction {
        return {
            id: docId,
            type: "create",
            objectType: "document",
            objectId: docId,
            title: itemHpath(contentItem),
            logicalPath: contentItem.logicalPath,
            direction,
            sourceSnapshot: contentItem.snapshot,
        };
    }

    private buildUpdate(docId: string, localItem: ScopeSnapshotItem, remoteItem: ScopeSnapshotItem | undefined, baseline: MirrorDocumentBaseline | undefined, direction: "push" | "pull"): SyncAction {
        const contentItem = direction === "pull" ? remoteItem : localItem;
        const targetItem = direction === "pull" ? localItem : remoteItem;
        return {
            id: docId,
            type: "update",
            objectType: "document",
            objectId: docId,
            title: itemHpath(contentItem),
            logicalPath: contentItem?.logicalPath ?? "",
            sourceSnapshot: contentItem?.snapshot,
            destinationSnapshot: targetItem?.snapshot,
            baseline,
            direction,
        };
    }

    private buildMove(docId: string, localItem: ScopeSnapshotItem, remoteItem: ScopeSnapshotItem, baseline: MirrorDocumentBaseline, direction: "push" | "pull"): SyncAction {
        const contentItem = direction === "pull" ? remoteItem : localItem;
        const targetItem = direction === "pull" ? localItem : remoteItem;
        return {
            id: docId,
            type: "move",
            objectType: "document",
            objectId: docId,
            title: itemHpath(contentItem),
            logicalPath: contentItem.logicalPath,
            sourcePath: contentItem.path,
            destinationPath: targetItem.path,
            sourceSnapshot: contentItem.snapshot,
            destinationSnapshot: targetItem.snapshot,
            baseline,
            direction,
        };
    }
}

export { hpathTitle };
