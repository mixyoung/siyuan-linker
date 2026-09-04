import { afterEach, describe, expect, it, vi } from "vitest";
import {
    assertZipArchive,
    compareVersions,
    downloadExportArchive,
    downloadWorkspaceFile,
    ensureNotebook,
    exportAllData,
    normalizeAssetPath,
    readApiResponse,
    requestHeaders,
    validateTargetUrl,
} from "../src/siyuan-api";

afterEach(() => vi.unstubAllGlobals());

describe("readApiResponse", () => {
    it("returns data from a successful SiYuan response", async () => {
        const response = new Response(JSON.stringify({ code: 0, msg: "", data: { ok: true } }), { status: 200 });
        await expect(readApiResponse(response, "Test action")).resolves.toEqual({ ok: true });
    });

    it("reports an empty successful response with action context", async () => {
        const response = new Response("", { status: 200 });
        await expect(readApiResponse(response, "Import documents")).rejects.toThrow(
            "Import documents: HTTP 200 returned an empty response",
        );
    });

    it("reports malformed JSON instead of leaking a SyntaxError", async () => {
        const response = new Response("{\"code\":0", { status: 200 });
        await expect(readApiResponse(response, "List notebooks")).rejects.toThrow(
            "List notebooks: invalid JSON",
        );
    });

    it("includes proxy response context on HTTP errors", async () => {
        const response = new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" });
        await expect(readApiResponse(response, "Export all data")).rejects.toThrow(
            "Export all data: HTTP 502 Bad Gateway: <html>Bad gateway</html>",
        );
    });

    it("uses the SiYuan error message", async () => {
        const response = new Response(JSON.stringify({ code: -1, msg: "read-only", data: null }), { status: 200 });
        await expect(readApiResponse(response, "Write file")).rejects.toThrow("Write file: read-only");
    });
});

describe("request construction", () => {
    it("uses the documented authorization scheme and omits an empty token", () => {
        expect(requestHeaders({ url: "https://example.com", token: "secret" }, true)).toEqual({
            "Content-Type": "application/json",
            Authorization: "Token secret",
        });
        expect(requestHeaders({ url: "https://example.com", token: "" })).toEqual({});
    });

    it("downloads exportData archives directly from the returned /export route", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { zip: "/export/My%20Workspace.zip" } }), { status: 200 }))
            .mockResolvedValueOnce(new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const target = { url: "https://example.com", token: "secret" };

        const exportPath = await exportAllData(target);
        await downloadExportArchive(exportPath, target);

        expect(exportPath).toBe("/export/My%20Workspace.zip");
        expect(fetchMock).toHaveBeenNthCalledWith(2, "https://example.com/export/My%20Workspace.zip", {
            method: "GET",
            headers: { Authorization: "Token secret" },
        });
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("/temp/export/");
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("/api/file/getFile");
    });

    it("extracts SiYuan's message from a getFile HTTP 202 error", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
            JSON.stringify({ code: 404, msg: "file not found", data: null }),
            { status: 202, statusText: "Accepted" },
        )));
        await expect(downloadWorkspaceFile("data/missing.sy")).rejects.toThrow(
            "Download data/missing.sy: HTTP 202 Accepted: file not found",
        );
    });

    it("rejects ambiguous duplicate destination notebook names", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
            code: 0,
            data: { notebooks: [
                { id: "box-a", name: "Notes (source-box)", closed: false },
                { id: "box-b", name: "Notes (source-box)", closed: false },
            ] },
        }), { status: 200 })));
        await expect(ensureNotebook("Notes (source-box)")).rejects.toThrow("Multiple destination notebooks");
    });

    it("opens an existing closed notebook before importing into it", async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                code: 0,
                data: { notebooks: [{ id: "box", name: "Notes", closed: true }] },
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: null }), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(ensureNotebook("Notes")).resolves.toEqual({ id: "box", name: "Notes", closed: false });
        expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/notebook/openNotebook", expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ notebook: "box" }),
        }));
    });
});

describe("URL and asset validation", () => {
    it("requires HTTPS for non-loopback targets unless explicitly allowed", () => {
        expect(validateTargetUrl("https://example.com/")).toBe("https://example.com");
        expect(validateTargetUrl("http://127.0.0.1:6806/")).toBe("http://127.0.0.1:6806");
        expect(() => validateTargetUrl("http://192.168.1.10:6806")).toThrow("Remote HTTP is disabled");
        expect(validateTargetUrl("http://192.168.1.10:6806", true)).toBe("http://192.168.1.10:6806");
        expect(() => validateTargetUrl("https://user:password@example.com")).toThrow("embedded credentials");
        expect(() => validateTargetUrl("https://example.com?token=x")).toThrow("query string");
    });

    it("normalizes only workspace asset paths", () => {
        expect(normalizeAssetPath("assets/x.png")).toBe("data/assets/x.png");
        expect(normalizeAssetPath("/assets/x.png")).toBe("data/assets/x.png");
        expect(normalizeAssetPath("data/assets/x.png")).toBe("data/assets/x.png");
        expect(normalizeAssetPath("/data/assets/x.png")).toBe("data/assets/x.png");
        expect(() => normalizeAssetPath("../assets/x.png")).toThrow("unsupported asset path");
        expect(() => normalizeAssetPath("https://example.com/x.png")).toThrow("unsupported asset path");
    });
});

describe("version and archive validation", () => {
    it("compares semantic versions numerically", () => {
        expect(compareVersions("3.8.2", "3.8.2")).toBe(0);
        expect(compareVersions("3.10.0", "3.8.2")).toBe(1);
        expect(compareVersions("v3.8.1", "3.8.2")).toBe(-1);
        expect(compareVersions("3.8.2-dev1", "3.8.2")).toBe(-1);
        expect(compareVersions("3.8.2-rc.10", "3.8.2-rc.2")).toBe(1);
    });

    it("rejects non-ZIP downloads", async () => {
        await expect(assertZipArchive(new Blob(["<html>login</html>"]), "Download export archive"))
            .rejects.toThrow("response is not a ZIP archive");
    });
});
