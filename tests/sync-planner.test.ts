import { describe, expect, it } from "vitest";
import { formatSyncPlanSummary, sortActionsByDependency, SyncPlanner } from "../src/sync-planner";
import type {
    MirrorDocumentBaseline,
    MirrorDocumentSnapshot,
    ScopeSnapshot,
    ScopeSnapshotItem,
    SyncAction,
    SyncProfile,
} from "../src/mirror-types";

function createMockSnapshot(
    docId: string,
    notebookId: string,
    logicalPath: string,
    fingerprint: string,
    dom = "<div>test</div>",
): MirrorDocumentSnapshot {
    const baseline: MirrorDocumentBaseline = {
        hashVersion: 4,
        documentId: docId,
        notebookId,
        path: `data/${notebookId}/${logicalPath}`,
        logicalPath,
        hpath: `/${docId}`,
        domSha256: "dom-hash",
        identityRowsSha256: "rows-hash",
        attrsSha256: "attrs-hash",
        assetsSha256: "assets-hash",
        fingerprint,
        blockIds: [docId],
        assets: [],
    };
    return {
        documentId: docId,
        notebookId,
        path: `data/${notebookId}/${logicalPath}`,
        hpath: `/${docId}`,
        dom,
        attrs: {},
        managedAttrs: {},
        identityRows: [{ id: docId, parent_id: "", root_id: docId, box: notebookId, path: `/${logicalPath}`, hpath: `/${docId}`, type: "d", subtype: "", ial: "" }],
        blockIds: [docId],
        assets: [],
        baseline,
    };
}

function createScopeSnapshot(items: ScopeSnapshotItem[]): ScopeSnapshot {
    const map = new Map<string, ScopeSnapshotItem>();
    for (const item of items) map.set(item.id, item);
    return {
        scope: "document",
        workspaceId: "ws-1",
        notebooks: [{ id: "nb-1", name: "NB" }],
        items: map,
        assets: new Map(),
    };
}

describe("SyncPlanner", () => {
    const planner = new SyncPlanner();

    const baseProfile: SyncProfile = {
        id: "prof-1",
        name: "Test Profile",
        scope: "document",
        direction: "push",
        trigger: "manual",
        conflictPolicy: "stop",
        deletionPolicy: "ignore",
        localWorkspaceId: "ws-local",
        remoteWorkspaceId: "ws-remote",
        notebookMappings: [],
        documentRoots: [],
    };

    it("identifies unchanged documents as noops", () => {
        const docId = "20260904120000-doc0001";
        const snap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-1");
        const item: ScopeSnapshotItem = {
            id: docId,
            objectType: "document",
            notebookId: "nb-1",
            path: snap.path,
            logicalPath: `${docId}.sy`,
            hpath: snap.hpath,
            depth: 0,
            parentId: "",
            snapshot: snap,
        };

        const sourceSnap = createScopeSnapshot([item]);
        const destSnap = createScopeSnapshot([item]);
        const baselines = { [docId]: snap.baseline };

        const plan = planner.generatePlan(baseProfile, sourceSnap, destSnap, baselines);
        expect(plan.noops).toHaveLength(1);
        expect(plan.creates).toHaveLength(0);
        expect(plan.updates).toHaveLength(0);
        expect(plan.conflicts).toHaveLength(0);
    });

    it("generates update action when source changed and destination is unchanged", () => {
        const docId = "20260904120000-doc0001";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const sourceSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-new-src");
        const destSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");

        const sourceItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: sourceSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: sourceSnapObj,
        };
        const destItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: destSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: destSnapObj,
        };

        const sourceSnap = createScopeSnapshot([sourceItem]);
        const destSnap = createScopeSnapshot([destItem]);
        const baselines = { [docId]: baseSnap.baseline };

        const plan = planner.generatePlan(baseProfile, sourceSnap, destSnap, baselines);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].objectId).toBe(docId);
        expect(plan.updates[0].direction).toBe("push");
        expect(plan.conflicts).toHaveLength(0);
    });

    it("stops and reports conflict when destination changed independently in push mode", () => {
        const docId = "20260904120000-doc0001";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const sourceSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const destSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-dest-modified");

        const sourceItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: sourceSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: sourceSnapObj,
        };
        const destItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: destSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: destSnapObj,
        };

        const plan = planner.generatePlan(
            baseProfile,
            createScopeSnapshot([sourceItem]),
            createScopeSnapshot([destItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.conflicts).toHaveLength(1);
        expect(plan.conflicts[0].classification).toBe("destination-changed");
    });

    it("resolves conflicts when conflictPolicy is authority-wins", () => {
        const docId = "20260904120000-doc0001";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const sourceSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-src");
        const destSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-dest");

        const sourceItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: sourceSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: sourceSnapObj,
        };
        const destItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: destSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: destSnapObj,
        };

        const authorityProfile: SyncProfile = {
            ...baseProfile,
            conflictPolicy: "authority-wins",
            conflictAuthority: "direction-source",
        };

        const plan = planner.generatePlan(
            authorityProfile,
            createScopeSnapshot([sourceItem]),
            createScopeSnapshot([destItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.conflicts).toHaveLength(0);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].objectId).toBe(docId);
    });

    it("orders creates by ancestor depth and deletes by reverse depth", () => {
        const actions: SyncAction[] = [
            { id: "c2", type: "create", objectType: "document", objectId: "c2", logicalPath: "p/c2.sy", direction: "push", sourceSnapshot: createMockSnapshot("c2", "nb", "p/c1/c2.sy", "h") },
            { id: "p", type: "create", objectType: "document", objectId: "p", logicalPath: "p.sy", direction: "push", sourceSnapshot: createMockSnapshot("p", "nb", "p.sy", "h") },
            { id: "d_parent", type: "delete", objectType: "document", objectId: "d_p", logicalPath: "p.sy", direction: "push", destinationSnapshot: createMockSnapshot("d_p", "nb", "p.sy", "h") },
            { id: "d_child", type: "delete", objectType: "document", objectId: "d_c", logicalPath: "p/c.sy", direction: "push", destinationSnapshot: createMockSnapshot("d_c", "nb", "p/c.sy", "h") },
        ];

        const sorted = sortActionsByDependency(actions);
        const createIds = sorted.filter((a) => a.type === "create").map((a) => a.objectId);
        expect(createIds).toEqual(["p", "c2"]);

        const deleteIds = sorted.filter((a) => a.type === "delete").map((a) => a.objectId);
        expect(deleteIds).toEqual(["d_c", "d_p"]);
    });

    it("formats plan summary correctly", () => {
        const plan = {
            profile: baseProfile,
            effectiveSourceWorkspaceId: "ws-1",
            effectiveDestinationWorkspaceId: "ws-2",
            creates: [
                { id: "n1", type: "create" as const, objectType: "notebook" as const, objectId: "n1", logicalPath: "", direction: "push" as const },
                { id: "d1", type: "create" as const, objectType: "document" as const, objectId: "d1", logicalPath: "", direction: "push" as const },
            ],
            updates: [
                { id: "d2", type: "update" as const, objectType: "document" as const, objectId: "d2", logicalPath: "", direction: "push" as const },
            ],
            moves: [],
            deletes: [],
            noops: [],
            conflicts: [
                { objectId: "c1", objectType: "document" as const, logicalPath: "", classification: "conflict" as const, reasons: ["test"] },
            ],
            totalActions: 3,
        };

        const summary = formatSyncPlanSummary(plan);
        expect(summary).toContain("将创建 1 个笔记本");
        expect(summary).toContain("将创建 1 篇文档");
        expect(summary).toContain("将更新 1 篇文档");
        expect(summary).toContain("发现 1 个冲突");
    });

    // ---- Engine fix E4: authority semantics ---- //

    it("treats direction-source as the remote end under pull", () => {
        const docId = "20260904120000-doc0001";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const localSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-local");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-remote");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: remoteSnapObj,
        };

        const pullAuthorityProfile: SyncProfile = {
            ...baseProfile,
            direction: "pull",
            conflictPolicy: "authority-wins",
            conflictAuthority: "direction-source",
        };

        const plan = planner.generatePlan(
            pullAuthorityProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.conflicts).toHaveLength(0);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].direction).toBe("pull");
        // The remote (effective source under pull) content must win.
        expect(plan.updates[0].sourceSnapshot).toBe(remoteSnapObj);
    });

    it("rejects direction-source for bidirectional profiles instead of guessing", () => {
        const bidirProfile: SyncProfile = {
            ...baseProfile,
            direction: "bidirectional",
            conflictPolicy: "authority-wins",
            conflictAuthority: "direction-source",
        };
        expect(() => planner.generatePlan(bidirProfile, createScopeSnapshot([]), createScopeSnapshot([]), {}))
            .toThrow(/direction-source/);
    });

    it("a manual skip is final and is not overridden by authority-wins", () => {
        const docId = "20260904120000-doc0001";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-orig");
        const localSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-local");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${docId}.sy`, "hash-remote");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${docId}.sy`, depth: 0, parentId: "", snapshot: remoteSnapObj,
        };

        const authorityProfile: SyncProfile = {
            ...baseProfile,
            conflictPolicy: "authority-wins",
            conflictAuthority: "local",
        };

        const plan = planner.generatePlan(
            authorityProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            { [docId]: baseSnap.baseline },
            { manualResolutions: { [docId]: "skip" } },
        );
        // Skipped: no blocking conflict, no action, and the authority policy
        // must not turn it into an overwrite.
        expect(plan.conflicts).toHaveLength(0);
        expect(plan.updates).toHaveLength(0);
        expect(plan.creates).toHaveLength(0);
    });

    // ---- Engine fix E3: baseline-relative move detection ---- //

    it("plans a move when only the local placement changed relative to the baseline", () => {
        const docId = "20260904120000-doc0001";
        const parentA = "20260904120000-parenta";
        const parentB = "20260904120000-parentb";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");

        const localSnapObj = createMockSnapshot(docId, "nb-1", `${parentB}.sy/${docId}.sy`, "hash-same");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${parentB}.sy/${docId}.sy`, depth: 1, parentId: parentB, snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${parentA}.sy/${docId}.sy`, depth: 1, parentId: parentA, snapshot: remoteSnapObj,
        };

        const plan = planner.generatePlan(
            baseProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.moves).toHaveLength(1);
        expect(plan.moves[0].objectId).toBe(docId);
        expect(plan.moves[0].direction).toBe("push");
        expect(plan.moves[0].logicalPath).toBe(`${parentB}.sy/${docId}.sy`);
        expect(plan.conflicts).toHaveLength(0);
    });

    it("plans a pull move when only the remote placement changed", () => {
        const docId = "20260904120000-doc0001";
        const parentA = "20260904120000-parenta";
        const parentB = "20260904120000-parentb";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");

        const localSnapObj = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${parentB}.sy/${docId}.sy`, "hash-same");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${parentA}.sy/${docId}.sy`, depth: 1, parentId: parentA, snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${parentB}.sy/${docId}.sy`, depth: 1, parentId: parentB, snapshot: remoteSnapObj,
        };

        const pullProfile: SyncProfile = { ...baseProfile, direction: "pull" };
        const plan = planner.generatePlan(
            pullProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.moves).toHaveLength(1);
        expect(plan.moves[0].direction).toBe("pull");
        expect(plan.moves[0].logicalPath).toBe(`${parentB}.sy/${docId}.sy`);
    });

    it("conflicts when both ends moved the document to different places", () => {
        const docId = "20260904120000-doc0001";
        const parentA = "20260904120000-parenta";
        const parentB = "20260904120000-parentb";
        const parentC = "20260904120000-parentc";
        const baseSnap = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");

        const localSnapObj = createMockSnapshot(docId, "nb-1", `${parentB}.sy/${docId}.sy`, "hash-same");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${parentC}.sy/${docId}.sy`, "hash-same");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${parentB}.sy/${docId}.sy`, depth: 1, parentId: parentB, snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${parentC}.sy/${docId}.sy`, depth: 1, parentId: parentC, snapshot: remoteSnapObj,
        };

        const bidirProfile: SyncProfile = { ...baseProfile, direction: "bidirectional" };
        const plan = planner.generatePlan(
            bidirProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            { [docId]: baseSnap.baseline },
        );
        expect(plan.moves).toHaveLength(0);
        expect(plan.conflicts).toHaveLength(1);
        expect(plan.conflicts[0].classification).toBe("diverged");
    });

    it("treats a no-baseline placement divergence as a conflict, not a move", () => {
        const docId = "20260904120000-doc0001";
        const parentA = "20260904120000-parenta";
        const parentB = "20260904120000-parentb";

        const localSnapObj = createMockSnapshot(docId, "nb-1", `${parentA}.sy/${docId}.sy`, "hash-same");
        const remoteSnapObj = createMockSnapshot(docId, "nb-1", `${parentB}.sy/${docId}.sy`, "hash-same");

        const localItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: localSnapObj.path,
            logicalPath: `${parentA}.sy/${docId}.sy`, depth: 1, parentId: parentA, snapshot: localSnapObj,
        };
        const remoteItem: ScopeSnapshotItem = {
            id: docId, objectType: "document", notebookId: "nb-1", path: remoteSnapObj.path,
            logicalPath: `${parentB}.sy/${docId}.sy`, depth: 1, parentId: parentB, snapshot: remoteSnapObj,
        };

        const plan = planner.generatePlan(
            baseProfile,
            createScopeSnapshot([localItem]),
            createScopeSnapshot([remoteItem]),
            {},
        );
        expect(plan.moves).toHaveLength(0);
        expect(plan.conflicts).toHaveLength(1);
        expect(plan.conflicts[0].classification).toBe("conflict");
    });
});
