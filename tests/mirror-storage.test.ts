import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, Map<string, string>>());
const api = vi.hoisted(() => ({
    downloadWorkspaceFileIfExists: vi.fn(async (path: string, target?: { url?: string }) => {
        const value = files.get(target?.url ?? "local")?.get(path);
        return value === undefined ? null : new Blob([value]);
    }),
    listNotebooks: vi.fn(async () => []),
    writeFile: vi.fn(async (path: string, content: Blob, target?: { url?: string }) => {
        const key = target?.url ?? "local";
        if (!files.has(key)) files.set(key, new Map());
        files.get(key)!.set(path, await content.text());
    }),
}));

vi.mock("../src/siyuan-api", () => api);

import {
    ADOPT_FULL_CLONE_CONFIRMATION,
    adoptFullCloneDestination,
    clearPendingAfterVerifiedRollback,
    commitMirrorBaselines,
    ensureWorkspaceIdentity,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    persistPendingOperation,
    readWorkspaceIdentity,
    resetMirrorPeer,
    withMirrorOperationLock,
} from "../src/mirror-storage";
import { MIRROR_LINEAGES_PATH, WORKSPACE_IDENTITY_PATH, type MirrorDocumentBaseline } from "../src/mirror-types";

const remote = { url: "remote", token: "secret" };

beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    api.listNotebooks.mockImplementation(async (target?: { url?: string }) => target?.url === "remote"
        ? [{ id: "shared", name: "Remote" }, { id: "remote-only", name: "Remote only" }]
        : [{ id: "shared", name: "Local" }, { id: "local-only", name: "Local only" }]);
});

describe("mirror workspace metadata", () => {
    it("creates identities, intersects exact notebook IDs, writes matching records, and exposes status", async () => {
        const result = await pairMirrorWorkspaces(undefined, remote);
        expect(result.allowedNotebookIds).toEqual(["shared"]);
        expect(result.sourceIdentity.workspaceId).not.toBe(result.destinationIdentity.workspaceId);
        expect(await inspectMirrorPair(undefined, remote)).toMatchObject({ valid: true, allowedNotebookIds: ["shared"], pending: false });
        expect(await inspectMirrorPair(remote, undefined)).toMatchObject({ valid: true, allowedNotebookIds: ["shared"], pending: false });
        const writesBeforeIdempotentPair = api.writeFile.mock.calls.length;
        await expect(pairMirrorWorkspaces(undefined, remote)).resolves.toMatchObject({ pairId: result.pairId, allowedNotebookIds: ["shared"] });
        expect(api.writeFile.mock.calls.length).toBe(writesBeforeIdempotentPair);
        expect(files.get("local")?.has(WORKSPACE_IDENTITY_PATH)).toBe(true);
        expect(files.get("remote")?.has(MIRROR_LINEAGES_PATH)).toBe(true);
        expect(JSON.stringify([...files.values()])).not.toContain("secret");
    });

    it("requires explicit strongly-confirmed adoption before rotating a full-clone destination", async () => {
        const sourceIdentity = await ensureWorkspaceIdentity(undefined);
        files.set("remote", new Map([
            [WORKSPACE_IDENTITY_PATH, files.get("local")!.get(WORKSPACE_IDENTITY_PATH)!],
            [MIRROR_LINEAGES_PATH, JSON.stringify({ schemaVersion: 1, workspaceId: sourceIdentity.workspaceId, peers: {} }, null, 2) + "\n"],
        ]));

        await expect(pairMirrorWorkspaces(undefined, remote)).rejects.toThrow("adopt-full-clone");
        await expect(adoptFullCloneDestination(undefined, remote, "wrong-confirmation")).rejects.toThrow("strong confirmation");
        const adopted = await adoptFullCloneDestination(undefined, remote, ADOPT_FULL_CLONE_CONFIRMATION);
        expect(adopted.destinationIdentity.workspaceId).not.toBe(sourceIdentity.workspaceId);
        expect(adopted.archivePath).toMatch(/mirror-lineages\.adopted-/);
        expect(files.get("remote")!.has(adopted.archivePath)).toBe(true);
        await expect(pairMirrorWorkspaces(undefined, remote)).resolves.toMatchObject({ destinationIdentityRotated: false });
    });

    it("persists the same pending operation on both sides and commits matching baselines", async () => {
        const pair = await pairMirrorWorkspaces(undefined, remote);
        const pending = {
            operationId: "operation-1", pairId: pair.pairId, sourceWorkspaceId: pair.sourceIdentity.workspaceId,
            destinationWorkspaceId: pair.destinationIdentity.workspaceId, documentIds: ["20260904120000-abcdefg"], startedAt: "2026-09-04T12:00:00.000Z",
        };
        await persistPendingOperation(pending, undefined, remote);
        expect(await inspectMirrorPair(undefined, remote)).toMatchObject({ valid: false, pending: true });
        await expect(pairMirrorWorkspaces(undefined, remote)).rejects.toThrow("refused to overwrite");
        await expect(resetMirrorPeer(undefined, remote)).rejects.toThrow("requires recovery");
        await clearPendingAfterVerifiedRollback(pending, undefined, remote);
        expect(await inspectMirrorPair(undefined, remote)).toMatchObject({ valid: true, pending: false });
        await persistPendingOperation(pending, undefined, remote);
        const baseline: MirrorDocumentBaseline = {
            hashVersion: 2,
            documentId: pending.documentIds[0], notebookId: "shared", path: `data/shared/${pending.documentIds[0]}.sy`, hpath: "/Doc",
            domSha256: "a", identityRowsSha256: "b", attrsSha256: "c", assetsSha256: "d", fingerprint: "e",
            blockIds: pending.documentIds, assets: [],
        };
        await commitMirrorBaselines({ [baseline.documentId]: baseline }, pending, undefined, remote);
        const status = await inspectMirrorPair(undefined, remote);
        expect(status).toMatchObject({ valid: true, pending: false });
        expect(status.sourceRecord?.baselines[baseline.documentId]).toEqual(baseline);
        expect(status.destinationRecord?.baselines[baseline.documentId]).toEqual(baseline);
        await expect(pairMirrorWorkspaces(undefined, remote)).resolves.toMatchObject({ pairId: pair.pairId });
        expect((await inspectMirrorPair(undefined, remote)).sourceRecord?.baselines[baseline.documentId]).toEqual(baseline);
    });

    it("reports unilateral or divergent metadata conservatively and resets peer records on both sides", async () => {
        const pair = await pairMirrorWorkspaces(undefined, remote);
        const remoteStore = JSON.parse(files.get("remote")!.get(MIRROR_LINEAGES_PATH)!);
        remoteStore.peers[pair.sourceIdentity.workspaceId].baselines["20260904120000-abcdefg"] = {
            documentId: "20260904120000-abcdefg", notebookId: "shared", path: "data/shared/20260904120000-abcdefg.sy", hpath: "/Doc",
            domSha256: "a", identityRowsSha256: "b", attrsSha256: "c", assetsSha256: "d", fingerprint: "e",
            blockIds: ["20260904120000-abcdefg"], assets: [],
        };
        files.get("remote")!.set(MIRROR_LINEAGES_PATH, `${JSON.stringify(remoteStore, null, 2)}\n`);
        expect((await inspectMirrorPair(undefined, remote)).reasons).toContain("Peer lineage records do not match");

        files.get("remote")!.delete(MIRROR_LINEAGES_PATH);
        const status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(false);
        expect(status.reasons).toContain("Destination peer lineage is missing");

        await resetMirrorPeer(undefined, remote);
        expect((await inspectMirrorPair(undefined, remote)).valid).toBe(false);
    });

    it("parses legacy baselines without hashVersion and round-trips current ones", async () => {
        const pair = await pairMirrorWorkspaces(undefined, remote);
        const remoteStore = JSON.parse(files.get("remote")!.get(MIRROR_LINEAGES_PATH)!);
        remoteStore.peers[pair.sourceIdentity.workspaceId].baselines["20260904120000-abcdefg"] = {
            documentId: "20260904120000-abcdefg", notebookId: "shared", path: "data/shared/20260904120000-abcdefg.sy", hpath: "/Doc",
            domSha256: "a", identityRowsSha256: "b", attrsSha256: "c", assetsSha256: "d", fingerprint: "e",
            blockIds: ["20260904120000-abcdefg"], assets: [],
        };
        files.get("remote")!.set(MIRROR_LINEAGES_PATH, `${JSON.stringify(remoteStore, null, 2)}\n`);
        const legacy = (await inspectMirrorPair(undefined, remote)).destinationRecord?.baselines["20260904120000-abcdefg"];
        expect(legacy?.hashVersion).toBe(1);
    });

    it("forces a reset under pending only with the explicit flag and archives the stores", async () => {
        await pairMirrorWorkspaces(undefined, remote);
        await persistPendingOperation({
            operationId: "op-1", pairId: "pair", sourceWorkspaceId: "s", destinationWorkspaceId: "d",
            documentIds: ["20260904120000-abcdefg"], startedAt: "2026-09-06T00:00:00Z",
        }, undefined, remote);
        await expect(resetMirrorPeer(undefined, remote)).rejects.toThrow("requires recovery");
        await resetMirrorPeer(undefined, remote, { force: true });
        const status = await inspectMirrorPair(undefined, remote);
        expect(status.valid).toBe(false);
        expect(status.pending).toBe(false);
        const remoteFiles = [...files.get("remote")!.keys()];
        expect(remoteFiles.some((name) => name.includes("mirror-lineages.reset-destination-"))).toBe(true);
    });

    it("serializes in-process operations for the same endpoint pair in either direction", async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const wait = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const first = withMirrorOperationLock(undefined, remote, async () => {
            order.push("first-start");
            await wait;
            order.push("first-end");
        });
        const second = withMirrorOperationLock(remote, undefined, async () => { order.push("second"); });
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        expect(order).toEqual(["first-start"]);
        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });
});
