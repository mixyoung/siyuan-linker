import { afterEach, describe, expect, it, vi } from "vitest";
import { listDocuments } from "../src/FileTreeApi";

afterEach(() => vi.unstubAllGlobals());

const target = { url: "https://example.com", token: "secret" };

describe("listDocuments", () => {
    it("validates and maps the v3.8.2 lazy tree response", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
            code: 0,
            data: {
                box: "box-id",
                files: [
                    { id: "parent", path: "/parent.sy", name: "Parent.sy", subFileCount: 2 },
                    { id: "leaf", path: "/leaf.sy", name: "Leaf.sy", subFileCount: 0 },
                    { id: "hidden", path: "/hidden.sy", name: "Hidden.sy", subFileCount: 0, hidden: true },
                ],
            },
        }), { status: 200 })));

        await expect(listDocuments(target, "requested-box")).resolves.toEqual([
            {
                box: "box-id",
                id: "parent",
                path: "/parent.sy",
                name: "Parent",
                hasChildren: true,
                children: [],
                expanded: false,
                loaded: false,
                loading: false,
            },
            {
                box: "box-id",
                id: "leaf",
                path: "/leaf.sy",
                name: "Leaf",
                hasChildren: false,
                children: [],
                expanded: false,
                loaded: true,
                loading: false,
            },
        ]);
    });

    it("rejects a changed or malformed response schema", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })));
        await expect(listDocuments(target, "box-id")).rejects.toThrow("List documents: invalid file list");
    });
});
