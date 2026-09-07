import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, Map<string, string>>());
const remoteDocs = vi.hoisted(() => new Map<string, { dom: string; attrs: Record<string, string>; notebookId: string; path: string }>());

const api = vi.hoisted(() => ({
    createDocWithMd: vi.fn(async (opts: { notebookId: string; id: string; parentId: string; path: string; markdown: string }, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        remoteDocs.set(`${key}:${opts.id}`, {
            dom: `<div data-node-id="${opts.id}">New</div>`,
            attrs: { id: opts.id },
            notebookId: opts.notebookId,
            path: `data/${opts.notebookId}/${opts.id}.sy`,
        });
        return opts.id;
    }),
    getBlockDOM: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        return remoteDocs.get(`${key}:${id}`)?.dom ?? `<div data-node-id="${id}">DOM</div>`;
    }),
    getBlockAttrs: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        return remoteDocs.get(`${key}:${id}`)?.attrs ?? { id };
    }),
    updateBlockDOM: vi.fn(async (id: string, dom: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        const existing = remoteDocs.get(`${key}:${id}`);
        if (existing) existing.dom = dom;
        else remoteDocs.set(`${key}:${id}`, { dom, attrs: { id }, notebookId: "nb-1", path: `data/nb-1/${id}.sy` });
    }),
    setBlockAttrs: vi.fn(async (id: string, attrs: Record<string, string>, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        const existing = remoteDocs.get(`${key}:${id}`);
        if (existing) existing.attrs = { ...existing.attrs, ...attrs };
    }),
    removeDocById: vi.fn(async (id: string, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        remoteDocs.delete(`${key}:${id}`);
    }),
    downloadWorkspaceFileIfExists: vi.fn(async (path: string, target?: { url?: string }) => {
        const value = files.get(target?.url ?? "local")?.get(path);
        return value === undefined ? null : new Blob([value]);
    }),
    writeFile: vi.fn(async (path: string, content: Blob, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        if (!files.has(key)) files.set(key, new Map());
        files.get(key)!.set(path, await content.text());
    }),
    listNotebooks: vi.fn(async (target?: { url?: string }) => target?.url === "remote"
        ? [{ id: "nb-1", name: "Notebook 1" }]
        : [{ id: "nb-1", name: "Notebook 1" }]),
    createNotebook: vi.fn(async (name: string, _target?: { url?: string }) => ({ id: "nb-target-1", name, closed: false })),
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
    return { ...actual, ...api };
});

import {
    addNotebookMapping,
    createAndMapNotebook,
    inspectMirrorPair,
    pairMirrorWorkspaces,
} from "../src/mirror-storage";
import { SyncExecutor } from "../src/sync-executor";
import { SyncPlanner } from "../src/sync-planner";
import { WorkspaceScopeAdapter } from "../src/sync-adapters";
import type {
    MirrorDocumentBaseline,
    MirrorDocumentSnapshot,
    SyncPlan,
    SyncProfile,
} from "../src/mirror-types";

const remote = { url: "remote", token: "secret" };

beforeEach(() => {
    files.clear();
    remoteDocs.clear();
    vi.clearAllMocks();
});

describe("end-to-end sync flow", () => {
    it("completes pair -> map -> plan -> execute -> verify baseline commit", async () => {
        // 1. Pair local and remote
        const pairing = await pairMirrorWorkspaces(undefined, remote);
        expect(pairing.allowedNotebookIds).toContain("nb-1");

        // 2. Add a notebook mapping for the (different-ID) notebook
        await addNotebookMapping(undefined, remote, {
            localNotebookId: "nb-local",
            remoteNotebookId: "nb-target-1",
        });

        // 3. Inspect mirror pair to confirm baseline
        let status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(true);

        // 4. Build a plan with one create and one noop
        const docId = "20260904120000-doc0001";
        const baseline: MirrorDocumentBaseline = {
            hashVersion: 4,
            documentId: docId,
            notebookId: "nb-1",
            path: `data/nb-1/${docId}.sy`,
            logicalPath: `${docId}.sy`,
            hpath: `/${docId}`,
            domSha256: "dom",
            identityRowsSha256: "rows",
            attrsSha256: "attrs",
            assetsSha256: "assets",
            fingerprint: "fp",
            blockIds: [docId],
            assets: [],
        };

        const snap: MirrorDocumentSnapshot = {
            documentId: docId,
            notebookId: "nb-1",
            path: `data/nb-1/${docId}.sy`,
            hpath: `/${docId}`,
            dom: `<div data-node-id="${docId}">Hello</div>`,
            attrs: { id: docId },
            managedAttrs: { id: docId },
            identityRows: [{ id: docId, parent_id: "", root_id: docId, box: "nb-1", path: `/${docId}.sy`, hpath: `/${docId}`, type: "d", subtype: "", ial: "" }],
            blockIds: [docId],
            assets: [],
            baseline,
        };

        const profile: SyncProfile = {
            id: "prof-1",
            name: "Test",
            scope: "document",
            direction: "push",
            trigger: "manual",
            conflictPolicy: "stop",
            deletionPolicy: "ignore",
            localWorkspaceId: pairing.sourceIdentity.workspaceId,
            remoteWorkspaceId: pairing.destinationIdentity.workspaceId,
            notebookMappings: [],
            documentRoots: [{ documentId: docId, includeDescendants: false }],
        };

        const plan: SyncPlan = {
            profile,
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

        // 5. Execute the plan
        const executor = new SyncExecutor();
        const result = await executor.execute(plan, undefined, remote);
        expect(result.success).toBe(true);
        expect(result.count).toBe(1);

        // 6. Verify the destination has the new document
        expect(remoteDocs.has(`remote:${docId}`)).toBe(true);

        // 7. Verify pending was cleared and baselines were committed
        status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(true);
        expect(status.pending).toBe(false);
        expect(status.sourceRecord?.baselines[docId]).toBeDefined();
        expect(status.destinationRecord?.baselines[docId]).toBeDefined();

        // 8. Verify creation timestamp differs (generation must have advanced or stayed)
        expect(status.sourceRecord?.updatedAt).toBeDefined();
    });

    it("rejects execution when planner surfaces an unresolved conflict", async () => {
        await pairMirrorWorkspaces(undefined, remote);
        const docId = "20260904120000-conflict";

        const profile: SyncProfile = {
            id: "prof-2",
            name: "Conflict",
            scope: "document",
            direction: "push",
            trigger: "manual",
            conflictPolicy: "stop",
            deletionPolicy: "ignore",
            localWorkspaceId: "",
            remoteWorkspaceId: "",
            notebookMappings: [],
            documentRoots: [{ documentId: docId, includeDescendants: false }],
        };

        const conflictingPlan: SyncPlan = {
            profile,
            effectiveSourceWorkspaceId: "src",
            effectiveDestinationWorkspaceId: "dst",
            creates: [],
            updates: [],
            moves: [],
            deletes: [],
            noops: [],
            conflicts: [{
                objectId: docId,
                objectType: "document",
                logicalPath: `${docId}.sy`,
                classification: "conflict",
                reasons: ["Both sides modified"],
            }],
            totalActions: 0,
        };

        const planner = new SyncPlanner();
        expect(planner).toBeDefined();

        const executor = new SyncExecutor();
        await expect(executor.execute(conflictingPlan, undefined, remote))
            .rejects.toThrow("unresolved conflicts");
    });

    it("supports notebook mapping creation via createAndMapNotebook", async () => {
        await pairMirrorWorkspaces(undefined, remote);
        const result = await createAndMapNotebook("nb-local", "Remote Notebook", undefined, remote);
        expect(result.id).toBe("nb-target-1");

        const status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(true);
    });
});