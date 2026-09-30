/**
 * Opt-in live verification for the v0.5.3 write-path changes against two
 * same-version SiYuan kernels (>= 3.8.2).
 *
 * Covers exactly the five acceptance items:
 *   1. explicit notebook mapping A -> different-ID B: push a note WITH a
 *      sub-document; it must land in B with unchanged IDs and an identical
 *      relative path;
 *   2. reverse pull traverses the inverse of the same mapping;
 *   3. with an existing baseline, a destination-side edit must abort (not
 *      overwrite); a first-sync conflict without a baseline must require the
 *      explicit adopt-source consent before overwriting;
 *   4. a >=24-char separator-free alphanumeric value in sysecret blocks the
 *      full-transfer gate, while an ordinary Secret name does not;
 *   5. descendant enumeration: valid SQL returns the tree; malformed notebook
 *      IDs and failing SQL raise, so the v0.5.3 UI path cancels the whole
 *      transfer instead of silently narrowing scope.
 *
 * Environment (same contract as mirror.int.test.ts):
 *   SIYUAN_INTEGRATION=1
 *   SIYUAN_A_URL / SIYUAN_A_TOKEN   source instance (disposable)
 *   SIYUAN_B_URL / SIYUAN_B_TOKEN   destination instance (disposable)
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
    assertNotebookId,
    createDocWithMd,
    createNotebook,
    getBlockDOM,
    getHPathByID,
    listNotebooks,
    readonlySql,
    writeFile,
    type TargetConnection,
} from "../../src/siyuan-api";
import { MirrorOperationError } from "../../src/mirror-types";
import {
    createAndMapNotebook,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    resetMirrorPeer,
} from "../../src/mirror-storage";
import { mirrorDocumentsExact } from "../../src/mirror-service";
import { sourceHasLegacyTokens } from "../../src/transfer-service";

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
const PLUGIN_SETTINGS_PATH = "data/storage/petal/siyuan-linker/menu-config.json";

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
    await kernel(target, "/api/block/appendBlock", { parentID: rootId, dataType: "markdown", data: text });
    await settle();
}

async function expectVisible(rootId: string, needle: string, target: TargetConnection) {
    const dom = await getBlockDOM(rootId, target);
    if (!dom.includes(needle)) {
        throw new Error(`Visibility check failed: ${needle} not present in ${rootId} DOM on ${target.url}`);
    }
}

function withDetails(error: unknown): string {
    if (error instanceof MirrorOperationError) {
        return `${error.message} [${JSON.stringify(error.details)}]`;
    }
    return String(error);
}

let testSeq = 0;
const RUN_TAG = Date.now().toString(36).slice(-5).replace(/[^a-z0-9]/g, "0");
const nextId = () => {
    testSeq += 1;
    const stamp = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const digits = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`.slice(-14);
    const suffix = `lv${testSeq}${RUN_TAG}`.slice(0, 7).padEnd(7, "0");
    return `${digits}-${suffix}`;
};

let notebookAId = "";
let notebookBId = "";
let parentId = "";
let childId = "";

suite("live v0.5.3 write-path verification", { timeout: 300_000 }, () => {
    beforeAll(async () => {
        expect(A.url).toBeTruthy();
        expect(B.url).toBeTruthy();

        await pairMirrorWorkspaces(A, B);
        const status = await inspectMirrorPair(A, B);
        expect(status.valid).toBe(true);

        notebookAId = (await createNotebook(`VerifyA ${RUN_TAG}`, A)).id;
        const mapped = await createAndMapNotebook(notebookAId, `VerifyB ${RUN_TAG}`, A, B);
        notebookBId = mapped.id;
        expect(notebookBId).not.toBe(notebookAId);
        const notebooksB = await listNotebooks(B);
        expect(notebooksB.map((notebook) => notebook.id)).toContain(notebookBId);

        parentId = nextId();
        await createDocWithMd(
            { notebookId: notebookAId, id: parentId, path: `/Verify Parent ${RUN_TAG}`, markdown: `# Verify Parent ${RUN_TAG}\n\nparent paragraph` },
            A,
        );
        childId = nextId();
        const parentHPath = await getHPathByID(parentId, A);
        await createDocWithMd(
            {
                notebookId: notebookAId,
                id: childId,
                parentId,
                path: `${parentHPath}/Verify Child ${RUN_TAG}`,
                markdown: `# Verify Child ${RUN_TAG}\n\nchild paragraph`,
            },
            A,
        );
        await settle();
    });

    afterAll(async () => {
        await resetMirrorPeer(A, B).catch(() => undefined);
        if (notebookAId) await kernel(A, "/api/notebook/removeNotebook", { notebook: notebookAId }).catch(() => undefined);
        if (notebookBId) await kernel(B, "/api/notebook/removeNotebook", { notebook: notebookBId }).catch(() => undefined);
        await writeFile(PLUGIN_SETTINGS_PATH, new Blob(["{}"]), B).catch(() => undefined);
    });

    it("1. pushes a note with a sub-document into the mapped different-ID notebook", async () => {
        const result = await mirrorDocumentsExact([parentId, childId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(2);

        const parentRows = await sqlRows(
            `SELECT id, root_id, box, path, hpath FROM blocks WHERE id = '${parentId}' AND type = 'd'`, B,
        );
        expect(parentRows).toHaveLength(1);
        expect(parentRows[0].box).toBe(notebookBId);
        expect(parentRows[0].path).toBe(`/${parentId}.sy`);

        const childRows = await sqlRows(
            `SELECT id, root_id, box, path, hpath FROM blocks WHERE id = '${childId}' AND type = 'd'`, B,
        );
        expect(childRows).toHaveLength(1);
        expect(childRows[0].root_id).toBe(childId);
        expect(childRows[0].box).toBe(notebookBId);
        expect(childRows[0].path).toBe(`/${parentId}/${childId}.sy`);

        const parentHPathA = await getHPathByID(parentId, A);
        const childHPathA = await getHPathByID(childId, A);
        expect(parentRows[0].hpath).toBe(parentHPathA);
        expect(childRows[0].hpath).toBe(childHPathA);

        expect(await blockIdsUnder(parentId, B)).toEqual(await blockIdsUnder(parentId, A));
        expect(await blockIdsUnder(childId, B)).toEqual(await blockIdsUnder(childId, A));

        // The committed shared baseline must describe the mapped destination.
        const status = await inspectMirrorPair(A, B);
        expect(status.sourceRecord?.baselines[parentId]?.notebookId).toBe(notebookBId);
        expect(status.sourceRecord?.baselines[parentId]?.logicalPath).toBe(`${parentId}.sy`);
        expect(status.sourceRecord?.baselines[childId]?.path).toBe(`data/${notebookBId}/${parentId}/${childId}.sy`);
    });

    it("2. pulls a destination-side change back through the inverse mapping", async () => {
        await appendParagraph(childId, "reverse direction edit", B);
        await expectVisible(childId, "reverse direction edit", B);

        const result = await mirrorDocumentsExact([childId], B, A).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(result.count).toBe(1);
        await expectVisible(childId, "reverse direction edit", A);
        expect(await blockIdsUnder(childId, A)).toEqual(await blockIdsUnder(childId, B));
    });

    it("3a. aborts a destination-side divergence under an existing baseline", async () => {
        await appendParagraph(childId, "destination edit", B);
        await expectVisible(childId, "destination edit", B);
        const domBefore = await getBlockDOM(childId, B);

        const error = await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect((error as MirrorOperationError).details.state).toBe("before-write");
        expect(withDetails(error)).toMatch(/conflict|destination-changed/i);
        expect(await getBlockDOM(childId, B)).toBe(domBefore);
        expect((await inspectMirrorPair(A, B)).pending).toBe(false);

        // Restore convergence by removing the stray destination paragraph.
        const stray = await readonlySql(
            `SELECT id FROM blocks WHERE root_id = '${childId}' AND content LIKE '%destination edit%'`, B,
        );
        for (const row of stray) await kernel(B, "/api/block/deleteBlock", { id: String(row.id) });
        await settle();
        await mirrorDocumentsExact([childId], A, B).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
    });

    it("3b. requires explicit adoption for a first-sync conflict without a baseline", async () => {
        const docId = nextId();
        await createDocWithMd(
            { notebookId: notebookAId, id: docId, path: `/Verify Adopt ${RUN_TAG}`, markdown: `# Verify Adopt ${RUN_TAG}\n\nadopt-source-content` },
            A,
        );
        // Same ID on the destination with divergent content and no baseline.
        await createDocWithMd(
            { notebookId: notebookBId, id: docId, path: `/Verify Adopt ${RUN_TAG}`, markdown: `# Verify Adopt ${RUN_TAG}\n\nleftover destination content` },
            B,
        );
        await settle();

        const error = await mirrorDocumentsExact([docId], A, B).catch((value: unknown) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect((error as MirrorOperationError).details.state).toBe("before-write");
        expect((error as MirrorOperationError).details.firstSyncConflicts).toEqual([docId]);
        expect(await getBlockDOM(docId, B)).toContain("leftover destination content");

        const adopted = await mirrorDocumentsExact([docId], A, B, { adoptFirstBaselineConflicts: true }).catch((value: unknown) => {
            throw new Error(withDetails(value));
        });
        expect(adopted.count).toBe(1);
        await expectVisible(docId, "adopt-source-content", B);
        expect(await getBlockDOM(docId, B)).not.toContain("leftover destination content");
        expect(await blockIdsUnder(docId, B)).toEqual(await blockIdsUnder(docId, A));
    });

    it("4. blocks token-like plaintext in sysecret but not ordinary Secret names", async () => {
        const writeSettings = async (data: Record<string, unknown>) => {
            await writeFile(PLUGIN_SETTINGS_PATH, new Blob([JSON.stringify(data)]), B);
        };

        await writeSettings({ sysecret: "a".repeat(30), sysecret2: "" });
        await expect(sourceHasLegacyTokens(B)).resolves.toBe(true);

        await writeSettings({ sysecret: "SIYUAN_LINKER_TARGET_1_TOKEN", sysecret2: "remote-two" });
        await expect(sourceHasLegacyTokens(B)).resolves.toBe(false);

        await writeSettings({ sykey: "legacy-plaintext" });
        await expect(sourceHasLegacyTokens(B)).resolves.toBe(true);

        await writeSettings({});
    });

    it("5. descendant enumeration succeeds for the tree and failures propagate", async () => {
        const rows = await readonlySql(
            `SELECT id FROM blocks WHERE type = 'd' AND box = '${assertNotebookId(notebookAId)}' ORDER BY id`, A,
        );
        const ids = rows.map((row) => String(row.id));
        expect(ids).toContain(parentId);
        expect(ids).toContain(childId);

        expect(() => assertNotebookId("bad notebook id!")).toThrow(/Invalid notebook ID/);
        await expect(readonlySql("SELECT FROM invalid syntax", A)).rejects.toThrow();
    });
});
