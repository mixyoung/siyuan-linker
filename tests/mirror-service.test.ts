import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    assertNodeId: vi.fn((id: string) => {
        if (!/^\d{14}-[a-z0-9]{7}$/.test(id)) throw new Error(`Invalid block ID: ${id}`);
        return id;
    }),
    createDocWithMd: vi.fn(),
    downloadWorkspaceFile: vi.fn(),
    downloadWorkspaceFileIfExists: vi.fn(),
    findBlockIdentityRows: vi.fn(),
    flushSqlQueue: vi.fn(async () => undefined),
    getBlockAttrs: vi.fn(),
    getBlockDOM: vi.fn(),
    getBlockIdentityRows: vi.fn(),
    getDocumentAssets: vi.fn(),
    getDocumentLocation: vi.fn(),
    getHPathByID: vi.fn(),
    isEncryptedNotebook: vi.fn(),
    listNotebooks: vi.fn(),
    openNotebook: vi.fn(),
    reloadFileTree: vi.fn(),
    removeDocById: vi.fn(),
    removeWorkspaceFile: vi.fn(),
    setBlockAttrs: vi.fn(),
    updateBlockDOM: vi.fn(),
    writeFile: vi.fn(),
}));
const storage = vi.hoisted(() => ({
    assertPendingOperationOwnership: vi.fn(),
    clearPendingAfterVerifiedRollback: vi.fn(),
    commitMirrorBaselines: vi.fn(),
    inspectMirrorPair: vi.fn(),
    persistPendingOperation: vi.fn(),
    withMirrorOperationLock: vi.fn(async (_source, _destination, operation) => operation()),
}));

vi.mock("../src/siyuan-api", () => api);
vi.mock("../src/mirror-storage", () => storage);

import {
    buildAttributePatch,
    captureDocumentSnapshot,
    classifyThreeWay,
    extractBlockIds,
    filterManagedRootAttrs,
    mirrorDocumentsExact,
    normalizeDom,
} from "../src/mirror-service";
import { BASELINE_HASH_VERSION, MirrorOperationError, type MirrorDocumentBaseline } from "../src/mirror-types";

const id = "20260904120000-abcdefg";
const childId = "20260904120100-hijklmn";
const remote = { url: "https://example.com", token: "secret" };
const baseline = (fingerprint: string): MirrorDocumentBaseline => ({
    hashVersion: BASELINE_HASH_VERSION,
    documentId: id, notebookId: "box", path: `data/box/${id}.sy`, hpath: "/Doc",
    domSha256: fingerprint, identityRowsSha256: fingerprint, attrsSha256: fingerprint, assetsSha256: fingerprint,
    fingerprint, blockIds: [id], assets: [],
});

beforeEach(() => {
    vi.clearAllMocks();
    storage.inspectMirrorPair.mockResolvedValue({
        valid: true, reasons: [], pending: false, allowedNotebookIds: ["box"],
        sourceIdentity: { workspaceId: "source", schemaVersion: 1, createdAt: "now" },
        destinationIdentity: { workspaceId: "destination", schemaVersion: 1, createdAt: "now" },
        sourceRecord: { pairId: "pair", baselines: {}, notebookIds: ["box"] },
        destinationRecord: { pairId: "pair", baselines: {}, notebookIds: ["box"] },
    });
    api.listNotebooks.mockResolvedValue([{ id: "box", name: "Notes", closed: false }]);
    api.isEncryptedNotebook.mockResolvedValue(false);
    api.getDocumentLocation.mockResolvedValue({ notebookId: "box", path: `data/box/${id}.sy` });
    api.getBlockDOM.mockResolvedValue(`<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Body</div></div>`);
    api.getBlockAttrs.mockResolvedValue({ id, title: "Doc", updated: "1", custom: "kept" });
    api.getHPathByID.mockResolvedValue("/Doc");
    api.getBlockIdentityRows.mockResolvedValue([
        { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
        { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "" },
    ]);
    api.getDocumentAssets.mockResolvedValue([]);
    api.findBlockIdentityRows.mockResolvedValue([]);
    api.downloadWorkspaceFileIfExists.mockResolvedValue(null);
    api.createDocWithMd.mockResolvedValue(id);
    api.reloadFileTree.mockResolvedValue(undefined);
    storage.assertPendingOperationOwnership.mockResolvedValue(undefined);
    storage.clearPendingAfterVerifiedRollback.mockResolvedValue(undefined);
    storage.commitMirrorBaselines.mockResolvedValue(undefined);
    storage.persistPendingOperation.mockResolvedValue(undefined);
});

describe("mirror baseline and conflict rules", () => {
    it("filters structural root attributes and validates the exact DOM block ID set", () => {
        expect(filterManagedRootAttrs({ id, title: "Doc", updated: "1", type: "d", custom: "yes" })).toEqual({ custom: "yes" });
        expect(extractBlockIds(`<div data-node-id="${id}"><div data-node-id='20260904120100-hijklmn'></div></div>`, id))
            .toEqual([id, "20260904120100-hijklmn"]);
        expect(() => extractBlockIds(`<div data-node-id="not-an-id"></div>`, id)).toThrow("Invalid block ID");
        expect(buildAttributePatch({ custom: "old", legacy: "restore" }, { custom: "new", introduced: "remove" }))
            .toEqual({ custom: "old", legacy: "restore", introduced: "" });
    });

    it("uses conservative first-baseline and three-way conflict classification", () => {
        expect(classifyThreeWay(baseline("source"), null)).toBe("missing-destination");
        expect(classifyThreeWay(baseline("same"), baseline("same"))).toBe("unchanged");
        expect(classifyThreeWay(baseline("source"), baseline("destination"))).toBe("conflict");
        expect(classifyThreeWay(baseline("new"), baseline("old"), baseline("old"))).toBe("source-changed");
        expect(classifyThreeWay(baseline("old"), baseline("new"), baseline("old"))).toBe("destination-changed");
        expect(classifyThreeWay(baseline("same-new"), baseline("same-new"), baseline("old"))).toBe("converged");
        expect(classifyThreeWay(baseline("source-new"), baseline("destination-new"), baseline("old"))).toBe("conflict");
    });

    it("normalizes volatile kernel metadata out of DOM identity", () => {
        const withUpdated = `<div data-node-id="${id}" updated="20260906120000"><div data-node-id="${childId}" updated="20260906120101">text</div></div>`;
        const refreshed = withUpdated.replace(/updated="\d{14}"/g, 'updated="20260907111111"');
        expect(refreshed).not.toBe(withUpdated);
        expect(normalizeDom(refreshed)).toBe(normalizeDom(withUpdated));
        expect(normalizeDom(withUpdated)).not.toContain("updated=");
        expect(normalizeDom("")).toBe("");
    });

    it("normalizes only an empty external-link mark repeated as the same visible URL", () => {
        const url = "https://kdocs.cn/l/cfEeu8mstMWf";
        const kernelSource = `<div><span data-type="a" data-href="${url}"></span>${url} next</div>`;
        const kernelDestination = `<div>${url} next</div>`;
        expect(normalizeDom(kernelSource)).toBe(normalizeDom(kernelDestination));
        expect(normalizeDom(kernelSource)).toContain(url);

        expect(normalizeDom(`<div><span data-type="a" data-href="${url}">${url}</span></div>`))
            .not.toBe(normalizeDom(`<div>${url}</div>`));
        expect(normalizeDom(`<div><span data-type="a" data-href="${url}"></span>different text</div>`))
            .not.toBe(normalizeDom("<div>different text</div>"));
        expect(normalizeDom(`<div><span data-type="a" data-href="${url}"></span>${url}-different</div>`))
            .not.toBe(normalizeDom(`<div>${url}-different</div>`));
        expect(normalizeDom(`<div><span custom-data-type="a" custom-data-href="${url}"></span>${url}</div>`))
            .not.toBe(normalizeDom(`<div>${url}</div>`));
    });

    it("normalizes repeated caret placeholders only before a leading read-only image in a table cell", () => {
        const image = '<span contenteditable="false" data-type="img" class="img"><span><img src="assets/example.png"></span></span>';
        const source = `<table><tbody><tr><td>\u200B\u200B${image}</td></tr></tbody></table>`;
        const destination = `<table><tbody><tr><td>\u200B\u200B\u200B${image}</td></tr></tbody></table>`;
        expect(normalizeDom(source)).toBe(normalizeDom(destination));
        expect(normalizeDom(source)).toContain(`\u200B${image}`);

        expect(normalizeDom("<p>before\u200B\u200Bafter</p>"))
            .not.toBe(normalizeDom("<p>before\u200Bafter</p>"));
        expect(normalizeDom(`<p>\u200B\u200B${image}</p>`))
            .not.toBe(normalizeDom(`<p>\u200B${image}</p>`));
        expect(normalizeDom(`<td>text\u200B\u200B${image}</td>`))
            .not.toBe(normalizeDom(`<td>text\u200B${image}</td>`));
        expect(normalizeDom(`<td>\u200B\u200B<span contenteditable="true" data-type="img"></span></td>`))
            .not.toBe(normalizeDom(`<td>\u200B<span contenteditable="true" data-type="img"></span></td>`));
        expect(normalizeDom(`<td>\u200B\u200B<span contenteditable="false" custom-data-type="img"></span></td>`))
            .not.toBe(normalizeDom(`<td>\u200B<span contenteditable="false" custom-data-type="img"></span></td>`));
    });
});

describe("native exact mirror orchestration", () => {
    it("persists pending metadata before native document writes and verifies before committing baselines", async () => {
        await expect(mirrorDocumentsExact([id, id], undefined, remote)).resolves.toMatchObject({ count: 1, warnings: [] });
        expect(api.createDocWithMd).toHaveBeenCalledWith({
            notebookId: "box", id, parentId: "", path: "/Doc", markdown: "",
        }, remote);
        expect(api.updateBlockDOM).toHaveBeenCalledWith(
            id,
            `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Body</div></div>`,
            remote,
        );
        expect(api.setBlockAttrs).toHaveBeenCalledWith(id, { custom: "kept" }, remote);
        expect(storage.persistPendingOperation.mock.invocationCallOrder[0]).toBeLessThan(api.createDocWithMd.mock.invocationCallOrder[0]);
        expect(storage.commitMirrorBaselines.mock.invocationCallOrder[0]).toBeGreaterThan(api.updateBlockDOM.mock.invocationCallOrder[0]);
        expect(storage.commitMirrorBaselines).toHaveBeenCalledWith({
            [id]: expect.objectContaining({ documentId: id, blockIds: [id, childId], assets: [], hpath: "/Doc" }),
        }, expect.objectContaining({ operationId: expect.any(String), pairId: "pair" }), undefined, remote);
        expect(api.writeFile.mock.calls.some(([path]) => String(path).endsWith(".sy"))).toBe(false);
    });

    it("accepts the kernel dropping an empty link mark before identical visible URL text", async () => {
        const url = "https://kdocs.cn/l/cfEeu8mstMWf";
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true"><span data-type="a" data-href="${url}"></span>${url}</div></div>`;
        const destinationDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">${url}</div></div>`;
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) => target ? destinationDom : sourceDom);

        await expect(mirrorDocumentsExact([id], undefined, remote)).resolves.toMatchObject({ count: 1 });
        expect(api.updateBlockDOM).toHaveBeenCalledWith(id, sourceDom, remote);
        expect(storage.commitMirrorBaselines).toHaveBeenCalledWith({
            [id]: expect.objectContaining({
                hashVersion: BASELINE_HASH_VERSION,
                documentId: id,
            }),
        }, expect.objectContaining({ operationId: expect.any(String), pairId: "pair" }), undefined, remote);
        expect(storage.clearPendingAfterVerifiedRollback).not.toHaveBeenCalled();
    });

    it("accepts an extra kernel caret placeholder before a table-cell inline image", async () => {
        const image = '<span contenteditable="false" data-type="img" class="img"><span><img src="assets/example.png"></span></span>';
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeTable"><table><tbody><tr><td>\u200B\u200B${image}</td></tr></tbody></table></div>`;
        const destinationDom = `<div data-node-id="${childId}" data-type="NodeTable"><table><tbody><tr><td>\u200B\u200B\u200B${image}</td></tr></tbody></table></div>`;
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) => target ? destinationDom : sourceDom);

        await expect(mirrorDocumentsExact([id], undefined, remote)).resolves.toMatchObject({ count: 1 });
        expect(api.updateBlockDOM).toHaveBeenCalledWith(id, sourceDom, remote);
        expect(storage.commitMirrorBaselines).toHaveBeenCalledWith({
            [id]: expect.objectContaining({ hashVersion: BASELINE_HASH_VERSION, documentId: id }),
        }, expect.objectContaining({ operationId: expect.any(String), pairId: "pair" }), undefined, remote);
        expect(storage.clearPendingAfterVerifiedRollback).not.toHaveBeenCalled();
    });

    it("recaptures destination assets and commits their verified SHA-256 hashes in the common baseline", async () => {
        api.getDocumentAssets.mockResolvedValue(["data/assets/picture.png"]);
        api.downloadWorkspaceFile.mockResolvedValue(new Blob(["asset-bytes"]));
        api.downloadWorkspaceFileIfExists.mockResolvedValue(null);
        await mirrorDocumentsExact([id], undefined, remote);
        expect(api.writeFile).toHaveBeenCalledWith("data/assets/picture.png", expect.any(Blob), remote);
        expect(storage.commitMirrorBaselines).toHaveBeenCalledWith({
            [id]: expect.objectContaining({
                assets: [{ path: "data/assets/picture.png", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
            }),
        }, expect.objectContaining({ operationId: expect.any(String), pairId: "pair" }), undefined, remote);
    });

    it("rejects ordinary blocks bound to attribute views through ial before persisting pending metadata", async () => {
        api.getBlockIdentityRows.mockResolvedValue([
            { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
            { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "{: custom-avs=\"20260904120200-opqrstu\"}" },
        ]);
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("before-write");
        expect(error.message).toContain("attribute-view-bound");
        expect(storage.persistPendingOperation).not.toHaveBeenCalled();
    });

    it("rejects explicit attribute-view DOM nodes before writes", async () => {
        api.getBlockDOM.mockResolvedValue(`<div data-node-id="${childId}" data-type="NodeAttributeView"></div>`);
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("before-write");
        expect(storage.persistPendingOperation).not.toHaveBeenCalled();
    });

    it("runs in the reverse paired direction using the reversed endpoint roles", async () => {
        await expect(mirrorDocumentsExact([id], remote, undefined)).resolves.toMatchObject({ count: 1 });
        expect(storage.inspectMirrorPair).toHaveBeenCalledWith(remote, undefined);
        expect(api.createDocWithMd).toHaveBeenCalledWith(expect.objectContaining({ id, path: "/Doc" }), undefined);
        expect(storage.persistPendingOperation).toHaveBeenCalledWith(expect.objectContaining({
            sourceWorkspaceId: "source",
            destinationWorkspaceId: "destination",
        }), remote, undefined);
    });

    it("returns a structured before-write error for invalid lineage and performs no data writes", async () => {
        storage.inspectMirrorPair.mockResolvedValue({ valid: false, reasons: ["Destination peer lineage is missing"] });
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect(error.details.state).toBe("before-write");
        expect(api.createDocWithMd).not.toHaveBeenCalled();
        expect(api.updateBlockDOM).not.toHaveBeenCalled();
        expect(storage.persistPendingOperation).not.toHaveBeenCalled();
    });

    it("applies an inverse attribute patch and verifies the original fingerprint before clearing pending after rollback", async () => {
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">New body</div></div>`;
        let destinationDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Old body</div></div>`;
        const sourceAttrs = { custom: "new", introduced: "remove-on-rollback" };
        const destinationAttrs: Record<string, string> = { custom: "old", legacy: "restore" };
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) => target ? destinationDom : sourceDom);
        api.updateBlockDOM.mockImplementation(async (_blockId: string, dom: string) => { destinationDom = dom; });
        api.getBlockAttrs.mockImplementation(async (_blockId: string, target?: typeof remote) => target ? { ...destinationAttrs } : sourceAttrs);
        api.setBlockAttrs.mockImplementation(async (_blockId: string, attrs: Record<string, string>) => {
            for (const [key, value] of Object.entries(attrs)) {
                if (value === "") delete destinationAttrs[key];
                else destinationAttrs[key] = value;
            }
        });
        api.findBlockIdentityRows.mockResolvedValue([
            { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
            { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "" },
        ]);
        const originalDestination = await captureDocumentSnapshot(id, remote);
        storage.inspectMirrorPair.mockResolvedValue({
            valid: true, reasons: [], pending: false, allowedNotebookIds: ["box"],
            sourceIdentity: { workspaceId: "source", schemaVersion: 1, createdAt: "now" },
            destinationIdentity: { workspaceId: "destination", schemaVersion: 1, createdAt: "now" },
            sourceRecord: { pairId: "pair", baselines: { [id]: originalDestination.baseline }, notebookIds: ["box"] },
            destinationRecord: { pairId: "pair", baselines: { [id]: originalDestination.baseline }, notebookIds: ["box"] },
        });
        storage.commitMirrorBaselines.mockRejectedValue(new Error("metadata unavailable"));

        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("metadata-commit");
        expect(api.setBlockAttrs).toHaveBeenNthCalledWith(1, id, { custom: "new", introduced: "remove-on-rollback", legacy: "" }, remote);
        expect(api.setBlockAttrs).toHaveBeenNthCalledWith(2, id, { custom: "old", legacy: "restore", introduced: "" }, remote);
        expect(destinationAttrs).toEqual({ custom: "old", legacy: "restore" });
        expect(destinationDom).toBe(originalDestination.dom);
        expect(storage.clearPendingAfterVerifiedRollback).toHaveBeenCalled();
    });

    it("reports structured first-sync conflicts without a baseline and overwrites only on explicit adoption", async () => {
        api.findBlockIdentityRows.mockResolvedValue([
            { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
            { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "" },
        ]);
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Body</div></div>`;
        const divergent = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Destination edit</div></div>`;
        let destinationDom = divergent;
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) => target ? destinationDom : sourceDom);
        api.updateBlockDOM.mockImplementation(async (_blockId: string, dom: string) => { destinationDom = dom; });
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect(error.details.state).toBe("before-write");
        expect(error.details.firstSyncConflicts).toEqual([id]);
        expect(api.updateBlockDOM).not.toHaveBeenCalled();
        expect(storage.persistPendingOperation).not.toHaveBeenCalled();
        expect(storage.commitMirrorBaselines).not.toHaveBeenCalled();

        await expect(mirrorDocumentsExact([id], undefined, remote, { adoptFirstBaselineConflicts: true }))
            .resolves.toMatchObject({ count: 1 });
        expect(api.updateBlockDOM).toHaveBeenCalledWith(id, sourceDom, remote);
        expect(storage.persistPendingOperation).toHaveBeenCalled();
        expect(storage.commitMirrorBaselines).toHaveBeenCalled();
    });

    it("retries final verification while the destination still serves the pre-write tree", async () => {
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">New body</div></div>`;
        const beforeDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Old body</div></div>`;
        let destinationDom = beforeDom;
        let staleReadsLeft = 0;
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) =>
            target ? (staleReadsLeft > 0 ? (staleReadsLeft -= 1, beforeDom) : destinationDom) : sourceDom);
        api.updateBlockDOM.mockImplementation(async (_blockId: string, dom: string) => {
            destinationDom = dom;
            staleReadsLeft = 2;
        });
        api.findBlockIdentityRows.mockResolvedValue([
            { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
            { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "" },
        ]);
        const destinationBefore = await captureDocumentSnapshot(id, remote);
        storage.inspectMirrorPair.mockResolvedValue({
            valid: true, reasons: [], pending: false, allowedNotebookIds: ["box"],
            sourceIdentity: { workspaceId: "source", schemaVersion: 1, createdAt: "now" },
            destinationIdentity: { workspaceId: "destination", schemaVersion: 1, createdAt: "now" },
            sourceRecord: { pairId: "pair", baselines: { [id]: destinationBefore.baseline }, notebookIds: ["box"] },
            destinationRecord: { pairId: "pair", baselines: { [id]: destinationBefore.baseline }, notebookIds: ["box"] },
        });

        await expect(mirrorDocumentsExact([id], undefined, remote)).resolves.toMatchObject({ count: 1 });
        expect(api.updateBlockDOM).toHaveBeenCalledWith(id, sourceDom, remote);
        expect(storage.commitMirrorBaselines).toHaveBeenCalled();
        expect(storage.clearPendingAfterVerifiedRollback).not.toHaveBeenCalled();
    });

    it("reports a first differing DOM region when final verification finds genuine divergence", async () => {
        const sourceDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">New body</div></div>`;
        const beforeDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Old body</div></div>`;
        const editorDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Editor overwrote this</div></div>`;
        let destinationDom = beforeDom;
        api.getBlockDOM.mockImplementation(async (_blockId: string, target?: typeof remote) =>
            target ? destinationDom : sourceDom);
        api.updateBlockDOM.mockImplementation(async () => { destinationDom = editorDom; });
        api.findBlockIdentityRows.mockResolvedValue([
            { id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" },
            { id: childId, parent_id: id, root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "p", subtype: "", ial: "" },
        ]);
        const destinationBefore = await captureDocumentSnapshot(id, remote);
        storage.inspectMirrorPair.mockResolvedValue({
            valid: true, reasons: [], pending: false, allowedNotebookIds: ["box"],
            sourceIdentity: { workspaceId: "source", schemaVersion: 1, createdAt: "now" },
            destinationIdentity: { workspaceId: "destination", schemaVersion: 1, createdAt: "now" },
            sourceRecord: { pairId: "pair", baselines: { [id]: destinationBefore.baseline }, notebookIds: ["box"] },
            destinationRecord: { pairId: "pair", baselines: { [id]: destinationBefore.baseline }, notebookIds: ["box"] },
        });

        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        // A genuine editor overwrite matches neither the operation-owned nor
        // the original content, so rollback refuses to clobber it and the
        // result is reported as partial.
        expect(error.details.state).toBe("partial");
        expect(error.details.cause).toContain("domDiff=");
        expect(error.details.cause).toContain("Editor overwrote this");
        expect(error.details.rollbackErrors?.join(" ")).toContain("DOM no longer matches");
        expect(storage.commitMirrorBaselines).not.toHaveBeenCalled();
    });

    it("retains pending state and reports partial when an ambiguous create failure leaves an unowned document", async () => {
        api.createDocWithMd.mockRejectedValue(new Error("connection reset"));
        api.findBlockIdentityRows
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id, parent_id: "", root_id: id, box: "box", path: `/${id}.sy`, hpath: "/Doc", type: "d", subtype: "", ial: "" }]);
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("partial");
        expect(error.details.rollbackErrors).toEqual(expect.arrayContaining([expect.stringContaining("ownership cannot be verified")]));
        expect(api.removeDocById).not.toHaveBeenCalled();
        expect(storage.clearPendingAfterVerifiedRollback).not.toHaveBeenCalled();
    });

    it("does not delete an asset after an ambiguous write failure if current content differs from the intended hash", async () => {
        api.getDocumentAssets.mockResolvedValue(["data/assets/shared.bin"]);
        api.downloadWorkspaceFile.mockResolvedValue(new Blob(["source-asset"]));
        api.downloadWorkspaceFileIfExists
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(new Blob(["other-writer-content"]))
            .mockResolvedValueOnce(new Blob(["other-writer-content"]));
        api.writeFile.mockRejectedValue(new Error("connection reset"));
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("rolled-back");
        expect(error.details.residualAssetPaths).toEqual(["data/assets/shared.bin"]);
        expect(api.removeWorkspaceFile).not.toHaveBeenCalled();
        expect(storage.clearPendingAfterVerifiedRollback).toHaveBeenCalledWith(
            expect.objectContaining({ operationId: expect.any(String) }), undefined, remote,
        );
    });

    it("requires a full final destination fingerprint match and retains pending on unknown post-write content", async () => {
        const expectedDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Body</div></div>`;
        const divergentDom = `<div data-node-id="${childId}" data-type="NodeParagraph"><div contenteditable="true">Concurrent edit</div></div>`;
        api.getBlockDOM
            .mockResolvedValueOnce(expectedDom)
            .mockResolvedValueOnce(expectedDom)
            .mockResolvedValueOnce(divergentDom)
            .mockResolvedValueOnce(divergentDom);
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error.details.state).toBe("partial");
        expect(error.message).toContain("ownership verification was partial");
        expect(storage.commitMirrorBaselines).not.toHaveBeenCalled();
        expect(api.removeDocById).not.toHaveBeenCalled();
        expect(storage.clearPendingAfterVerifiedRollback).not.toHaveBeenCalled();
    });

    it("rolls back a verified newly-created document when a post-write verification fails", async () => {
        api.getDocumentLocation
            .mockResolvedValueOnce({ notebookId: "box", path: `data/box/${id}.sy` })
            .mockResolvedValueOnce({ notebookId: "box", path: `data/box/${id}.sy` })
            .mockResolvedValueOnce({ notebookId: "wrong-box", path: `data/wrong-box/${id}.sy` })
            .mockResolvedValueOnce({ notebookId: "box", path: `data/box/${id}.sy` });
        const error = await mirrorDocumentsExact([id], undefined, remote).catch((value) => value);
        expect(error).toBeInstanceOf(MirrorOperationError);
        expect(error.details.state).toBe("rolled-back");
        expect(api.removeDocById).toHaveBeenCalledWith(id, remote);
        expect(storage.clearPendingAfterVerifiedRollback).toHaveBeenCalledWith(expect.objectContaining({ operationId: expect.any(String) }), undefined, remote);
        expect(storage.commitMirrorBaselines).not.toHaveBeenCalled();
    });
});
