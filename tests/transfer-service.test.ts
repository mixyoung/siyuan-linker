import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
    compareVersions: vi.fn((left: string, right: string) => left === right ? 0 : left > right ? 1 : -1),
    downloadExportArchive: vi.fn(),
    downloadWorkspaceFile: vi.fn(),
    downloadWorkspaceFileIfExists: vi.fn(),
    ensureNotebook: vi.fn(),
    exportAllData: vi.fn(),
    exportDocuments: vi.fn(),
    getDocumentAssets: vi.fn(),
    getDocumentLocation: vi.fn(),
    getNotebookName: vi.fn(),
    getSystemVersion: vi.fn(),
    importAllData: vi.fn(),
    importDocuments: vi.fn(),
    isEncryptedNotebook: vi.fn(),
    listNotebooks: vi.fn(),
    openNotebook: vi.fn(),
    readTextFile: vi.fn(),
    reloadFileTree: vi.fn(),
    updateIndexes: vi.fn(),
    writeFile: vi.fn(),
}));

const mirror = vi.hoisted(() => ({ mirrorDocumentsExact: vi.fn() }));

vi.mock("../src/siyuan-api", () => api);
vi.mock("../src/mirror-service", () => mirror);

import {
    assertCompatible,
    transferAllData,
    transferDocumentsPreservingIds,
    transferDocumentsSafely,
} from "../src/transfer-service";

const remote = { url: "https://example.com", token: "secret" };
const zip = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])]);

beforeEach(() => {
    vi.clearAllMocks();
    api.getSystemVersion.mockResolvedValue("3.8.2");
    api.isEncryptedNotebook.mockResolvedValue(false);
    api.downloadWorkspaceFileIfExists.mockResolvedValue(null);
    api.readTextFile.mockRejectedValue(new Error("file does not exist"));
    api.reloadFileTree.mockResolvedValue(undefined);
    mirror.mirrorDocumentsExact.mockResolvedValue({ count: 1, warnings: [], operationId: "operation" });
});

describe("compatibility gates", () => {
    it("rejects mismatched versions for destructive operations", async () => {
        api.getSystemVersion.mockResolvedValueOnce("3.8.2").mockResolvedValueOnce("3.8.3");
        await expect(assertCompatible(undefined, remote, true)).rejects.toThrow("requires matching SiYuan versions");
    });
});

describe("safe document transfer", () => {
    it("uses native export, direct archive download, import, and one UI reload", async () => {
        api.getDocumentLocation.mockResolvedValue({ notebookId: "source-box", path: "data/source-box/doc.sy" });
        api.getNotebookName.mockResolvedValue("Notes");
        api.ensureNotebook.mockResolvedValue({ id: "destination-box", name: "Notes" });
        api.exportDocuments.mockResolvedValue("/export/Notes.sy.zip");
        api.downloadExportArchive.mockResolvedValue(zip);

        await expect(transferDocumentsSafely(["doc"], undefined, remote)).resolves.toEqual({ count: 1, warnings: [] });

        expect(api.ensureNotebook).toHaveBeenCalledWith("Notes (source-box)", remote);
        expect(api.exportDocuments).toHaveBeenCalledWith(["doc"], undefined);
        expect(api.downloadExportArchive).toHaveBeenCalledWith("/export/Notes.sy.zip", undefined);
        expect(api.importDocuments).toHaveBeenCalledWith(zip, "destination-box", remote);
        expect(api.reloadFileTree).toHaveBeenCalledTimes(1);
        expect(api.writeFile).not.toHaveBeenCalled();
    });

    it("keeps source notebooks with duplicate names separate", async () => {
        api.getDocumentLocation.mockImplementation(async (id: string) => ({
            notebookId: id === "a" ? "box-a" : "box-b",
            path: `data/${id === "a" ? "box-a" : "box-b"}/${id}.sy`,
        }));
        api.getNotebookName.mockResolvedValue("Notes");
        api.ensureNotebook.mockImplementation(async (name: string) => ({ id: name, name }));
        api.exportDocuments.mockResolvedValueOnce("/export/a.sy.zip").mockResolvedValueOnce("/export/b.sy.zip");
        api.downloadExportArchive.mockResolvedValue(zip);

        await expect(transferDocumentsSafely(["a", "b"], undefined, remote)).resolves.toEqual({ count: 2, warnings: [] });

        expect(api.ensureNotebook).toHaveBeenNthCalledWith(1, "Notes (box-a)", remote);
        expect(api.ensureNotebook).toHaveBeenNthCalledWith(2, "Notes (box-b)", remote);
    });

    it("does not report imported content as failed when only the UI reload fails", async () => {
        api.getDocumentLocation.mockResolvedValue({ notebookId: "source-box", path: "data/source-box/doc.sy" });
        api.getNotebookName.mockResolvedValue("Notes");
        api.ensureNotebook.mockResolvedValue({ id: "destination-box", name: "Notes" });
        api.exportDocuments.mockResolvedValue("/export/Notes.sy.zip");
        api.downloadExportArchive.mockResolvedValue(zip);
        api.reloadFileTree.mockRejectedValue(new Error("reload unavailable"));
        vi.spyOn(console, "warn").mockImplementation(() => undefined);

        await expect(transferDocumentsSafely(["doc"], undefined, remote)).resolves.toEqual({
            count: 1,
            warnings: [expect.stringContaining("could not be reloaded")],
        });
    });
});

describe("preserve-ID transfer", () => {
    it("requires exact versions and delegates to native exact mirror orchestration", async () => {
        mirror.mirrorDocumentsExact.mockResolvedValue({
            count: 1,
            warnings: ["reload warning"],
            operationId: "operation",
        });

        await expect(transferDocumentsPreservingIds(["20260904120000-abcdefg", "20260904120000-abcdefg"], undefined, remote))
            .resolves.toEqual({ count: 1, warnings: ["reload warning"] });

        expect(api.getSystemVersion).toHaveBeenCalledTimes(2);
        expect(mirror.mirrorDocumentsExact).toHaveBeenCalledWith(["20260904120000-abcdefg"], undefined, remote);
        expect(api.writeFile).not.toHaveBeenCalled();
        expect(api.updateIndexes).not.toHaveBeenCalled();
    });

    it("does not invoke mirror orchestration when exact versions differ", async () => {
        api.getSystemVersion.mockResolvedValueOnce("3.8.2").mockResolvedValueOnce("3.8.3");
        await expect(transferDocumentsPreservingIds(["20260904120000-abcdefg"], undefined, remote))
            .rejects.toThrow("requires matching SiYuan versions");
        expect(mirror.mirrorDocumentsExact).not.toHaveBeenCalled();
    });
});

describe("full transfer", () => {
    it("checks exact versions and uses the returned export route unchanged", async () => {
        api.exportAllData.mockResolvedValue("/export/workspace.zip");
        api.downloadExportArchive.mockResolvedValue(zip);

        await transferAllData(undefined, remote);

        expect(api.exportAllData).toHaveBeenCalledWith(undefined);
        expect(api.downloadExportArchive).toHaveBeenCalledWith("/export/workspace.zip", undefined);
        expect(api.importAllData).toHaveBeenCalledWith(zip, remote);
    });

    it("blocks exporting a workspace that still stores legacy plaintext tokens", async () => {
        api.readTextFile.mockResolvedValue(JSON.stringify({ sykey: "plaintext-token" }));

        await expect(transferAllData(undefined, remote)).rejects.toThrow("migrate legacy plaintext API tokens");
        expect(api.exportAllData).not.toHaveBeenCalled();
    });
});
