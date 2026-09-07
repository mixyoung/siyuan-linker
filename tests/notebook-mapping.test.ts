import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, Map<string, string>>());
const api = vi.hoisted(() => ({
    createNotebook: vi.fn(async (name: string, target?: { url?: string }) => {
        const id = `nb-target-${Date.now()}`;
        return { id, name, closed: false };
    }),
    downloadWorkspaceFileIfExists: vi.fn(async (path: string, target?: { url?: string }) => {
        const value = files.get(target?.url ?? "local")?.get(path);
        return value === undefined ? null : new Blob([value]);
    }),
    listNotebooks: vi.fn(async (target?: { url?: string }) => target?.url === "remote"
        ? [{ id: "nb-rem", name: "Remote" }]
        : [{ id: "nb-loc", name: "Local" }]),
    writeFile: vi.fn(async (path: string, content: Blob, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        if (!files.has(key)) files.set(key, new Map());
        files.get(key)!.set(path, await content.text());
    }),
}));

vi.mock("../src/siyuan-api", () => api);

import {
    addNotebookMapping,
    clearDeletionTombstones,
    commitSyncBaselines,
    createAndMapNotebook,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    recordDeletionTombstones,
    resolveNotebookMapping,
    resolveReverseNotebookMapping,
} from "../src/mirror-storage";
import type { DeletionTombstone, MirrorDocumentBaseline } from "../src/mirror-types";

const remote = { url: "remote", token: "secret" };

beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
});

describe("notebook mapping and lineage extensions", () => {
    it("resolves notebook mappings forward and backward", async () => {
        const record = {
            pairId: "p1",
            localWorkspaceId: "ws-1",
            peerWorkspaceId: "ws-2",
            notebookIds: ["nb-shared", "nb-loc"],
            notebookMappings: [
                { localNotebookId: "nb-loc", remoteNotebookId: "nb-rem" },
            ],
            createdAt: "2026-09-07",
            updatedAt: "2026-09-07",
            baselines: {},
        };

        expect(resolveNotebookMapping(record, "nb-loc")).toBe("nb-rem");
        expect(resolveNotebookMapping(record, "nb-shared")).toBe("nb-shared");
        expect(resolveNotebookMapping(record, "unknown")).toBeUndefined();

        expect(resolveReverseNotebookMapping(record, "nb-rem")).toBe("nb-loc");
        expect(resolveReverseNotebookMapping(record, "nb-shared")).toBe("nb-shared");
        expect(resolveReverseNotebookMapping(record, "unknown")).toBeUndefined();
    });

    it("adds notebook mappings bilaterally and enforces 1-to-1 mapping", async () => {
        const pair = await pairMirrorWorkspaces(undefined, remote);
        await addNotebookMapping(undefined, remote, {
            localNotebookId: "nb-loc",
            remoteNotebookId: "nb-rem",
        });

        const status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(true);
        expect(resolveNotebookMapping(status.sourceRecord!, "nb-loc")).toBe("nb-rem");
        expect(resolveNotebookMapping(status.destinationRecord!, "nb-rem")).toBe("nb-loc");

        // Refuses many-to-one conflict
        await expect(addNotebookMapping(undefined, remote, {
            localNotebookId: "nb-loc-2",
            remoteNotebookId: "nb-rem",
        })).rejects.toThrow("conflict");

        // Refuses one-to-many conflict
        await expect(addNotebookMapping(undefined, remote, {
            localNotebookId: "nb-loc",
            remoteNotebookId: "nb-rem-2",
        })).rejects.toThrow("conflict");
    });

    it("creates target notebook and registers mapping", async () => {
        await pairMirrorWorkspaces(undefined, remote);
        const created = await createAndMapNotebook("nb-loc", "Remote Copy", undefined, remote);
        expect(created.id).toBeDefined();

        const status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(true);
        expect(resolveNotebookMapping(status.sourceRecord!, "nb-loc")).toBe(created.id);
    });

    it("records and clears deletion tombstones with generation advance", async () => {
        const pair = await pairMirrorWorkspaces(undefined, remote);
        const tombstone: DeletionTombstone = {
            objectType: "document",
            objectId: "20260904120000-del0001",
            deletedByWorkspaceId: pair.sourceIdentity.workspaceId,
            deletedAt: "2026-09-07T12:00:00Z",
            previousFingerprint: "prev-hash",
        };

        await recordDeletionTombstones(undefined, remote, [tombstone]);
        let status = await inspectMirrorPair(undefined, remote);
        expect(status.sourceRecord?.tombstones?.[tombstone.objectId]).toEqual(tombstone);
        expect(status.destinationRecord?.tombstones?.[tombstone.objectId]).toEqual(tombstone);

        await clearDeletionTombstones(undefined, remote, [tombstone.objectId]);
        status = await inspectMirrorPair(undefined, remote);
        expect(status.sourceRecord?.tombstones?.[tombstone.objectId]).toBeUndefined();
    });
});
