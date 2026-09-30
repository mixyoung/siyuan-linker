import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    ancestorEntries,
    buildLogicalPath,
    collectDescendantIds,
    DocumentScopeAdapter,
    NotebookScopeAdapter,
    WorkspaceScopeAdapter,
} from "../src/sync-adapters";

const files = vi.hoisted(() => new Map<string, Map<string, string>>());
const api = vi.hoisted(() => ({
    getDocumentLocation: vi.fn(async (docId: string) => ({
        notebookId: "nb-1",
        path: `data/nb-1/${docId}.sy`,
    })),
    getHPathByID: vi.fn(async () => "/Doc"),
    getBlockDOM: vi.fn(async () => '<div data-node-id="20260904120000-doc0001">Hello</div>'),
    getBlockAttrs: vi.fn(async () => ({ title: "Doc 1" })),
    getBlockIdentityRows: vi.fn(async () => [
        { id: "20260904120000-doc0001", parent_id: "", root_id: "20260904120000-doc0001", box: "nb-1", path: "/20260904120000-doc0001.sy", hpath: "/Doc", type: "d", subtype: "", ial: "" },
    ]),
    getDocumentAssets: vi.fn(async () => []),
    listNotebooks: vi.fn(async () => [{ id: "nb-1", name: "Notebook 1" }]),
    readonlySql: vi.fn(async () => []),
    downloadWorkspaceFile: vi.fn(async () => new Blob([""])),
    downloadWorkspaceFileIfExists: vi.fn(async () => null),
    readWorkspaceIdentity: vi.fn(async () => ({ schemaVersion: 1, workspaceId: "ws-1", createdAt: "2026-09-07" })),
    inspectMirrorPair: vi.fn(async () => ({
        state: "ready",
        valid: true,
        reasons: [],
        sourceIdentity: { schemaVersion: 1, workspaceId: "ws-1", createdAt: "2026-09-07" },
        destinationIdentity: { schemaVersion: 1, workspaceId: "ws-2", createdAt: "2026-09-07" },
        sourceRecord: { pairId: "p1", localWorkspaceId: "ws-1", peerWorkspaceId: "ws-2", notebookIds: ["nb-1"], baselines: {} },
        destinationRecord: { pairId: "p1", localWorkspaceId: "ws-2", peerWorkspaceId: "ws-1", notebookIds: ["nb-1"], baselines: {} },
        allowedNotebookIds: ["nb-1"],
        pending: false,
    })),
}));

vi.mock("../src/siyuan-api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/siyuan-api")>();
    return {
        ...actual,
        ...api,
    };
});

describe("sync adapters utilities", () => {
    it("buildLogicalPath extracts relative path correctly", () => {
        expect(buildLogicalPath("nb-1", "data/nb-1/doc-1.sy")).toBe("doc-1.sy");
        expect(buildLogicalPath("nb-1", "data/nb-1/parent.sy/child.sy")).toBe("parent.sy/child.sy");
        expect(buildLogicalPath("nb-1", "/parent.sy/child.sy")).toBe("parent.sy/child.sy");
        expect(buildLogicalPath("nb-1", "doc.sy")).toBe("doc.sy");
    });

    it("ancestorEntries parses path hierarchy accurately", () => {
        const p1 = "20260904120000-parent1";
        const p2 = "20260904120000-parent2";
        const c1 = "20260904120000-child01";
        const entries = ancestorEntries(`data/nb-1/${p1}.sy/${p2}.sy/${c1}.sy`);
        expect(entries).toHaveLength(3);
        expect(entries[0]).toEqual({
            documentId: p1,
            path: `data/nb-1/${p1}.sy`,
            parentId: "",
            depth: 0,
        });
        expect(entries[1]).toEqual({
            documentId: p2,
            path: `data/nb-1/${p1}.sy/${p2}.sy`,
            parentId: p1,
            depth: 1,
        });
        expect(entries[2]).toEqual({
            documentId: c1,
            path: `data/nb-1/${p1}.sy/${p2}.sy/${c1}.sy`,
            parentId: p2,
            depth: 2,
        });
    });

    it("collectDescendantIds traverses tree to gather all descendants", () => {
        const rows = [
            { id: "root", parent_id: "", root_id: "root", box: "nb-1", path: "/root.sy", hpath: "/Root" },
            { id: "child-1", parent_id: "root", root_id: "root", box: "nb-1", path: "/root/child-1.sy", hpath: "/Root/C1" },
            { id: "child-2", parent_id: "root", root_id: "root", box: "nb-1", path: "/root/child-2.sy", hpath: "/Root/C2" },
            { id: "grandchild-1", parent_id: "child-1", root_id: "root", box: "nb-1", path: "/root/child-1/grandchild-1.sy", hpath: "/Root/C1/GC1" },
            { id: "other", parent_id: "", root_id: "other", box: "nb-1", path: "/other.sy", hpath: "/Other" },
        ];

        const descendants = collectDescendantIds("root", rows);
        expect(descendants).toEqual(["child-1", "child-2", "grandchild-1"]);
        expect(descendants).not.toContain("other");
    });
});

describe("DocumentScopeAdapter", () => {
    it("captures document root and its ancestors", async () => {
        const docId = "20260904120000-doc0001";
        const adapter = new DocumentScopeAdapter(
            undefined,
            { url: "http://remote" },
            [{ documentId: docId, includeDescendants: false }],
        );

        const snapshot = await adapter.captureSource();
        expect(snapshot.scope).toBe("document");
        expect(snapshot.items.has(docId)).toBe(true);
        const item = snapshot.items.get(docId)!;
        expect(item.logicalPath).toBe(`${docId}.sy`);
    });

    it("enumerates the destination independently, including destination-only descendants (E1)", async () => {
        const rootId = "20260904120000-doc0001";
        const localChild = "20260904120000-child01";
        const destOnlyId = "20260904120000-chld002";
        const remote = { url: "http://remote" };

        api.readonlySql.mockImplementation(async (_stmt: string, target?: { url?: string }) => {
            if (!target) return [];
            return [
                { id: rootId, parent_id: "", root_id: rootId, box: "nb-1", path: `/${rootId}.sy`, hpath: "/Root" },
                { id: localChild, parent_id: rootId, root_id: localChild, box: "nb-1", path: `/${rootId}/${localChild}.sy`, hpath: "/Root/C1" },
                { id: destOnlyId, parent_id: rootId, root_id: destOnlyId, box: "nb-1", path: `/${rootId}/${destOnlyId}.sy`, hpath: "/Root/C2" },
            ];
        });
        api.getDocumentLocation.mockImplementation(async (docId: string) => ({ notebookId: "nb-1", path: `data/nb-1/${docId}.sy` }));
        api.getBlockDOM.mockImplementation(async (docId: string) => `<div data-node-id="${docId}">Hello</div>`);
        api.getBlockIdentityRows.mockImplementation(async (docId: string) => [
            { id: docId, parent_id: "", root_id: docId, box: "nb-1", path: `/${docId}.sy`, hpath: `/${docId}`, type: "d", subtype: "", ial: "" },
        ]);

        const adapter = new DocumentScopeAdapter(
            undefined,
            remote,
            [{ documentId: rootId, includeDescendants: true }],
        );
        await adapter.captureSource();
        const destination = await adapter.captureDestination();

        // Destination-only descendants must be visible to the planner even
        // though they do not exist on the source end.
        expect(destination.items.has(rootId)).toBe(true);
        expect(destination.items.has(localChild)).toBe(true);
        expect(destination.items.has(destOnlyId)).toBe(true);
    });

    it("propagates enumeration SQL failures instead of treating them as empty (E5)", async () => {
        const rootId = "20260904120000-doc0001";
        const remote = { url: "http://remote" };
        api.readonlySql.mockRejectedValueOnce(new Error("kernel SQL unavailable"));

        const adapter = new DocumentScopeAdapter(
            undefined,
            remote,
            [{ documentId: rootId, includeDescendants: true }],
        );
        await expect(adapter.captureSource()).rejects.toThrow("kernel SQL unavailable");
    });
});
