/**
 * Opt-in dynamic integration tests against two live SiYuan v3.8.2 kernels.
 *
 * Required environment:
 *   SIYUAN_INTEGRATION=1
 *   SIYUAN_A_URL / SIYUAN_A_TOKEN   source instance (must be disposable)
 *   SIYUAN_B_URL / SIYUAN_B_TOKEN   destination instance (must be disposable)
 *
 * Never point these at a workspace you care about: the suite exports,
 * imports, and writes real data on both instances.
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
    createDocWithMd,
    createNotebook,
    downloadExportArchive,
    exportAllData,
    getBlockDOM,
    getHPathByID,
    importAllData,
    listNotebooks,
    readonlySql,
    writeFile,
    type TargetConnection,
} from "../../src/siyuan-api";
import { MirrorOperationError } from "../../src/mirror-types";
import {
    ADOPT_FULL_CLONE_CONFIRMATION,
    adoptFullCloneDestination,
    ensureWorkspaceIdentity,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    readMirrorLineages,
    resetMirrorPeer,
} from "../../src/mirror-storage";
import { mirrorDocumentsExact } from "../../src/mirror-service";
import { transferDocumentsSafely } from "../../src/transfer-service";

const RUN = process.env.SIYUAN_INTEGRATION === "1";
const suite = RUN ? describe : describe.skip;

const A: TargetConnection = {
    url: process.env.SIYUAN_A_URL ?? "",
    token: process.env.SIYUAN_A_TOKEN ?? "",
};
const B: TargetConnection = {
    url: process.env.SIYUAN_B_URL ?? "",
    token: process.env.SIYUAN_B_TOKEN ?? "",
};
const NOTEBOOK_NAME = "MirrorIntBook";
const CANONICAL_SUFFIX = "inttest"; // 7 chars: used to build canonical IDs

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function kernel<T = unknown>(target: TargetConnection, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${target.url}${path}`, {
        method: "POST",
        headers: { Authorization: `Token ${target.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = await response.json() as { code: number; msg: string; data: T };
    if (result.code !== 0) throw new Error(`${path}: ${result.msg || `code ${result.code}`}`);
    return result.data;
}

async function settle() {
    await Promise.allSettled([
        kernel(A, "/api/sqlite/flushTransaction", {}),
        kernel(B, "/api/sqlite/flushTransaction", {}),
    ]);
    await sleep(600);
}

async function waitForRows(stmt: string, target: TargetConnection): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + 20_000;
    for (;;) {
        const rows = await readonlySql(stmt, target);
        if (rows.length > 0 || Date.now() > deadline) return rows;
        await sleep(500);
    }
}

async function sqlRows(stmt: string, target: TargetConnection): Promise<Array<Record<string, unknown>>> {
    await settle();
    return waitForRows(stmt, target);
}

async function blockIdsUnder(rootId: string, target: TargetConnection): Promise<string[]> {
    const rows = await sqlRows(`SELECT id FROM blocks WHERE root_id = '${rootId}' ORDER BY id`, target);
    return rows.map((row) => String(row.id)).sort();
}

async function appendParagraph(rootId: string, text: string, target: TargetConnection) {
    // SiYuan v3.8.2 appendBlock locates the target via parentID (a missing
    // parentID makes the kernel panic-recover into a fake code-0 response).
    await kernel(target, "/api/block/appendBlock", { parentID: rootId, dataType: "markdown", data: text });
    await settle();
}

async function expectVisible(rootId: string, needle: string, target: TargetConnection) {
    const dom = await getBlockDOM(rootId, target);
    if (!dom.includes(needle)) {
        throw new Error(`Write visibility check failed: ${needle} not present in ${rootId} DOM`);
    }
}

function withDetails(error: unknown): string {
    if (error instanceof MirrorOperationError) {
        return `${error.message} [${JSON.stringify(error.details)}]`;
    }
    return String(error);
}

let notebookId = "";
let parentId = "";
let childId = "";
let childHPath = "";
let emptyDocId = "";
let testSeq = 0;

const RUN_TAG = Date.now().toString(36).slice(-5).replace(/[^a-z0-9]/g, "0");
const nextId = () => {
    testSeq += 1;
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const digits = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`.slice(-14);
    const suffix = `int${testSeq}${RUN_TAG}`.slice(0, 7).padEnd(7, "0");
    return `${digits}-${suffix}`;
};

suite("live SiYuan v3.8.2 exact mirror", { timeout: 240_000 }, () => {
    beforeAll(async () => {
        expect(A.url).toBeTruthy();
        expect(B.url).toBeTruthy();
        const notebooksA = await listNotebooks(A);
        const existing = notebooksA.find((notebook) => notebook.name === NOTEBOOK_NAME);
        notebookId = existing ? existing.id : (await createNotebook(NOTEBOOK_NAME, A)).id;
        parentId = await createDocWithMd(
            { notebookId, id: nextId(), path: `/Int Parent ${RUN_TAG}`, markdown: `# Int Parent ${RUN_TAG}\n\nseed paragraph` },
            A,
        );
        await settle();
        await ensureWorkspaceIdentity(A);
    });

    it("full clone preserves notebook and document IDs on the destination", async () => {
        const exportPath = await exportAllData(A);
        const archive = await downloadExportArchive(exportPath, A);
        await importAllData(archive, B);
        await settle();
        const notebooksB = await listNotebooks(B);
        expect(notebooksB.map((notebook) => notebook.id)).toContain(notebookId);
        const parentRows = await sqlRows(
            `SELECT id, root_id, box, path, hpath FROM blocks WHERE id = '${parentId}' AND type = 'd'`,
            B,
        );
        expect(parentRows).toHaveLength(1);
        expect(parentRows[0].box).toBe(notebookId);
    });

    it("pairs both workspaces after the explicit adopt-full-clone step", async () => {
        const adopted = await adoptFullCloneDestination(A, B, ADOPT_FULL_CLONE_CONFIRMATION);
        expect(adopted.previousWorkspaceId).toBeTruthy();
        const result = await pairMirrorWorkspaces(A, B);
        expect(result.destinationIdentityRotated).toBe(false);
        expect(result.allowedNotebookIds).toContain(notebookId);
        const status = await inspectMirrorPair(A, B);
        expect(status.valid).toBe(true);
        expect(status.pending).toBe(false);
    });

    it("creates a missing child document with the exact source ID and nested path", async () => {
        const parentHPath = await getHPathByID(parentId, A);
        childId = nextId();
        childHPath = `${parentHPath}/Int Child ${RUN_TAG}`;
        await createDocWithMd(
            {
                notebookId,
                id: childId,
                path: childHPath,
                markdown: `# Int Child ${RUN_TAG}\n\nchild paragraph`,
                parentId,
            },
            A,
        );
        await settle();
        const result = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        const rowsB = await sqlRows(`SELECT id, root_id, box, path, hpath, type FROM blocks WHERE id = '${childId}' AND type = 'd'`, B);
        expect(rowsB).toHaveLength(1);
        expect(rowsB[0].root_id).toBe(childId);
        expect(rowsB[0].box).toBe(notebookId);
        expect(rowsB[0].path).toBe(`/${parentId}/${childId}.sy`);
        expect(rowsB[0].hpath).toBe(childHPath);
        expect(await blockIdsUnder(childId, B)).toEqual(await blockIdsUnder(childId, A));
    });

    it("pushes source changes to an unchanged destination and advances the baseline", async () => {
        // The cloned parent exists on both sides with no baseline yet: adopt it
        // first (conservative rules would otherwise classify any later
        // source-side change as a two-sided conflict).
        await mirrorDocumentsExact([parentId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        await appendParagraph(parentId, "source change one", A);
        await expectVisible(parentId, "source change one", A);
        const result = await mirrorDocumentsExact([parentId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        const rowsA = await sqlRows(`SELECT id FROM blocks WHERE root_id = '${parentId}' AND type = 'p' ORDER BY id`, A);
        const last = String(rowsA[rowsA.length - 1].id);
        expect(await blockIdsUnder(parentId, B)).toContain(last);
        await expectVisible(parentId, "source change one", B);
    });

    it("no-ops when both sides still match the baseline", async () => {
        const domBefore = await getBlockDOM(parentId, B);
        await mirrorDocumentsExact([parentId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(await getBlockDOM(parentId, B)).toBe(domBefore);
    });

    it("aborts a destination-side divergence as a conflict without writing", async () => {
        await appendParagraph(parentId, "destination edit", B);
        await expectVisible(parentId, "destination edit", B);
        const domBefore = await getBlockDOM(parentId, B);
        const error = await mirrorDocumentsExact([parentId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect((error as MirrorOperationError).details.state).toBe("before-write");
        expect(withDetails(error)).toMatch(/conflict|destination-changed/i);
        expect(await getBlockDOM(parentId, B)).toBe(domBefore);
        const status = await inspectMirrorPair(A, B);
        expect(status.pending).toBe(false);
        const stray = await readonlySql(`SELECT id FROM blocks WHERE root_id = '${parentId}' AND content LIKE '%destination edit%'`, B);
        if (stray.length) await kernel(B, "/api/block/deleteBlock", { id: stray[0].id });
        await settle();
    });

    it("rejects a destination rename or move before writing", async () => {
        await kernel(B, "/api/filetree/renameDocByID", { id: childId, title: `Renamed Child ${RUN_TAG}` });
        await settle();
        const renamedHPath = await getHPathByID(childId, B);
        expect(renamedHPath).toContain(`Renamed Child ${RUN_TAG}`);
        const error = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect(withDetails(error)).toMatch(/rename|move|HPath/i);
        expect((error as MirrorOperationError).details.state).toBe("before-write");
        await kernel(B, "/api/filetree/renameDocByID", { id: childId, title: `Int Child ${RUN_TAG}` });
        await settle();
    });

    it("rejects ordinary blocks bound to an attribute view via custom-avs", async () => {
        const rows = await sqlRows(`SELECT id FROM blocks WHERE root_id = '${childId}' AND type = 'p' ORDER BY id`, A);
        expect(rows.length).toBeGreaterThan(0);
        const paragraphId = String(rows[rows.length - 1].id);
        await kernel(A, "/api/attr/setBlockAttrs", { id: paragraphId, attrs: { "custom-avs": "20260101120000-avmark" } });
        await settle();
        const error = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect(withDetails(error)).toMatch(/attribute[- ]view/i);
        await kernel(A, "/api/attr/setBlockAttrs", { id: paragraphId, attrs: { "custom-avs": null } });
        await settle();
        const cleared = await readonlySql(`SELECT ial FROM blocks WHERE id = '${paragraphId}'`, A);
        expect(cleared[0]?.ial ?? "").not.toContain("custom-avs");
    });

    it("mirrors assets and aborts before writing on asset content conflicts", async () => {
        await writeFile("data/assets/int-mirror.txt", new Blob(["asset-v1"]), A);
        await appendParagraph(childId, "[link](assets/int-mirror.txt)", A);
        const result = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        const assetB = await fetch(`${B.url}/api/file/getFile`, {
            method: "POST",
            headers: { Authorization: `Token ${B.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ path: "/data/assets/int-mirror.txt" }),
        });
        expect(await assetB.text()).toBe("asset-v1");

        await writeFile("data/assets/int-mirror.txt", new Blob(["asset-v2-conflict"]), B);
        await appendParagraph(childId, "asset touch", A);
        const error = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        // The destination-side asset overwrite is caught either by the dedicated
// asset check or by the earlier three-way destination-divergence guard;
// both are safe before-write aborts.
        expect(withDetails(error)).toMatch(/asset|conflict/i);
        expect((error as MirrorOperationError).details.state).toBe("before-write");
        await writeFile("data/assets/int-mirror.txt", new Blob(["asset-v1"]), B);
        const recovered = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(recovered.count).toBe(1);
    });

    it("pulls a destination-side change back in the reverse direction", async () => {
        await appendParagraph(childId, "reverse direction edit", B);
        await expectVisible(childId, "reverse direction edit", B);
        const result = await mirrorDocumentsExact([childId], B, A).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        expect(await blockIdsUnder(childId, A)).toEqual(await blockIdsUnder(childId, B));
    });

    it("pushes an asset-free document, exercising the null getDocAssets response", async () => {
        emptyDocId = nextId();
        await createDocWithMd({ notebookId, id: emptyDocId, path: `/Int Empty ${RUN_TAG}`, markdown: `# Int Empty ${RUN_TAG}\n\nno assets here` }, A);
        await settle();
        const result = await mirrorDocumentsExact([emptyDocId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        const rowsB = await sqlRows(`SELECT root_id FROM blocks WHERE id = '${emptyDocId}' AND type = 'd'`, B);
        expect(rowsB).toHaveLength(1);
    });

    it("keeps secrets out of lineage metadata and matches records on both ends", async () => {
        const [identityA, identityB] = await Promise.all([ensureWorkspaceIdentity(A), ensureWorkspaceIdentity(B)]);
        const [storeA, storeB] = await Promise.all([
            readMirrorLineages(identityA, A),
            readMirrorLineages(identityB, B),
        ]);
        const serialized = JSON.stringify(storeA) + JSON.stringify(storeB);
        expect(serialized).not.toContain(A.token);
        expect(serialized).not.toContain(B.token);
        const recordA = storeA.peers[identityB.workspaceId];
        const recordB = storeB.peers[identityA.workspaceId];
        expect(recordA).toBeDefined();
        expect(recordB).toBeDefined();
        expect(recordA.pairId).toBe(recordB.pairId);
        expect(recordA.baselines[childId]).toBeDefined();
        expect(recordB.baselines[childId]).toBeDefined();
    });

    it("copies independently through the native archive flow with regenerated IDs", async () => {
        const result = await transferDocumentsSafely([parentId], A, B);
        expect(result.count).toBe(1);
        const notebooksB = await listNotebooks(B);
        expect(notebooksB.map((notebook) => notebook.name)).toContain(`${NOTEBOOK_NAME} (${notebookId})`);
    });

    it("resets the pair and re-pairs idempotently", async () => {
        await resetMirrorPeer(A, B);
        expect((await inspectMirrorPair(A, B)).valid).toBe(false);
        const paired = await pairMirrorWorkspaces(A, B);
        expect(paired.destinationIdentityRotated).toBe(false);
        expect((await inspectMirrorPair(A, B)).valid).toBe(true);
    });
});
