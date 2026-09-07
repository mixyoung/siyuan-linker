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
});
