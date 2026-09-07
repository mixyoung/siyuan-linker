import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, Map<string, string>>());
const docs = vi.hoisted(() => new Map<string, { dom: string; attrs: Record<string, string>; notebookId: string; path: string }>());

const api = vi.hoisted(() => ({
    createDocWithMd: vi.fn(async (opts: { notebookId: string; id: string; parentId: string; path: string; markdown: string }, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        docs.set(`${key}:${opts.id}`, {
            dom: '<div data-node-id="' + opts.id + '">New</div>',
            attrs: { id: opts.id },
            notebookId: opts.notebookId,
            path: `data/${opts.notebookId}/${opts.id}.sy`,
        });
        return opts.id;
    }),
    getBlockDOM: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        return docs.get(`${key}:${id}`)?.dom ?? '<div data-node-id="' + id + '">DOM</div>';
    }),
    getBlockAttrs: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        return docs.get(`${key}:${id}`)?.attrs ?? { id, title: "Title" };
    }),
    updateBlockDOM: vi.fn(async (id: string, dom: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        const existing = docs.get(`${key}:${id}`);
        if (existing) existing.dom = dom;
        else docs.set(`${key}:${id}`, { dom, attrs: { id }, notebookId: "nb-1", path: `data/nb-1/${id}.sy` });
    }),
    setBlockAttrs: vi.fn(async (id: string, attrs: Record<string, string>, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        const existing = docs.get(`${key}:${id}`);
        if (existing) existing.attrs = { ...existing.attrs, ...attrs };
    }),
    removeDocById: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        docs.delete(`${key}:${id}`);
    }),
    downloadWorkspaceFileIfExists: vi.fn(async (path: string, target?: { url?: string }) => {
        const value = files.get(target?.url ?? "local")?.get(path);
        return value === undefined ? null : new Blob([value]);
    }),
    downloadWorkspaceFile: vi.fn(async () => new Blob(["data"])),
    writeFile: vi.fn(async (path: string, content: Blob, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        if (!files.has(key)) files.set(key, new Map());
        files.get(key)!.set(path, await content.text());
    }),
    listNotebooks: vi.fn(async () => [{ id: "nb-1", name: "NB 1" }]),
    reloadFileTree: vi.fn(async () => undefined),
    getDocumentLocation: vi.fn(async (id: string) => ({ notebookId: "nb-1", path: `data/nb-1/${id}.sy` })),
    getHPathByID: vi.fn(async (id: string) => `/${id}`),
    getBlockIdentityRows: vi.fn(async (id: string) => [
        { id, parent_id: "", root_id: id, box: "nb-1", path: `/${id}.sy`, hpath: `/${id}`, type: "d", subtype: "", ial: "" },
    ]),
    getDocumentAssets: vi.fn(async () => []),
    readonlySql: vi.fn(async () => []),
}));

vi.mock("../src/siyuan-api", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/siyuan-api")>();
    return {
        ...actual,
        ...api,
    };
});

import { SyncExecutor } from "../src/sync-executor";
import { pairMirrorWorkspaces } from "../src/mirror-storage";
import type {
    MirrorDocumentBaseline,
    MirrorDocumentSnapshot,
    SyncAction,
    SyncPlan,
    SyncProfile,
} from "../src/mirror-types";

const remote = { url: "remote", token: "secret" };

beforeEach(() => {
    files.clear();
    docs.clear();
    vi.clearAllMocks();
});

describe("SyncExecutor", () => {
    const profile: SyncProfile = {
        id: "p1",
        name: "Test",
        scope: "document",
        direction: "push",
        trigger: "manual",
        conflictPolicy: "stop",
        deletionPolicy: "ignore",
        localWorkspaceId: "",
        remoteWorkspaceId: "",
        notebookMappings: [],
        documentRoots: [],
    };

    function mockDocSnapshot(id: string): MirrorDocumentSnapshot {
        const baseline: MirrorDocumentBaseline = {
            hashVersion: 4,
            documentId: id,
            notebookId: "nb-1",
            path: `data/nb-1/${id}.sy`,
            logicalPath: `${id}.sy`,
            hpath: `/${id}`,
            domSha256: "dom-sha",
            identityRowsSha256: "rows-sha",
            attrsSha256: "attrs-sha",
            assetsSha256: "assets-sha",
            fingerprint: "fp-" + id,
            blockIds: [id],
            assets: [],
        };
        return {
            documentId: id,
            notebookId: "nb-1",
            path: `data/nb-1/${id}.sy`,
            hpath: `/${id}`,
            dom: `<div data-node-id="${id}">Content</div>`,
            attrs: { id },
            managedAttrs: {},
            identityRows: [{ id, parent_id: "", root_id: id, box: "nb-1", path: `/${id}.sy`, hpath: `/${id}`, type: "d", subtype: "", ial: "" }],
            blockIds: [id],
            assets: [],
            baseline,
        };
    }

    it("executes creates and updates and commits new baselines", async () => {
        const pairing = await pairMirrorWorkspaces(undefined, remote);
        const docId = "20260904120000-doc0001";
        const snap = mockDocSnapshot(docId);

        const plan: SyncPlan = {
            profile: {
                ...profile,
                localWorkspaceId: pairing.sourceIdentity.workspaceId,
                remoteWorkspaceId: pairing.destinationIdentity.workspaceId,
            },
            effectiveSourceWorkspaceId: pairing.sourceIdentity.workspaceId,
            effectiveDestinationWorkspaceId: pairing.destinationIdentity.workspaceId,
            creates: [{
                id: docId,
                type: "create",
                objectType: "document",
                objectId: docId,
                title: snap.hpath,
                logicalPath: `${docId}.sy`,
                direction: "push",
                sourceSnapshot: snap,
            }],
            updates: [],
            moves: [],
            deletes: [],
            noops: [],
            conflicts: [],
            totalActions: 1,
        };

        const executor = new SyncExecutor();
        const result = await executor.execute(plan, undefined, remote);
        expect(result.success).toBe(true);
        expect(result.count).toBe(1);
        expect(api.createDocWithMd).toHaveBeenCalled();
        expect(api.updateBlockDOM).toHaveBeenCalled();
    });

    it("refuses execution when conflicts exist in plan", async () => {
        await pairMirrorWorkspaces(undefined, remote);
        const plan: SyncPlan = {
            profile,
            effectiveSourceWorkspaceId: "s",
            effectiveDestinationWorkspaceId: "d",
            creates: [],
            updates: [],
            moves: [],
            deletes: [],
            noops: [],
            conflicts: [{
                objectId: "20260904120000-doc0001",
                objectType: "document",
                logicalPath: "doc.sy",
                classification: "conflict",
                reasons: ["Conflict reason"],
            }],
            totalActions: 0,
        };

        const executor = new SyncExecutor();
        await expect(executor.execute(plan, undefined, remote)).rejects.toThrow("unresolved conflicts");
    });
});
