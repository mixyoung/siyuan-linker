import { describe, expect, it } from "vitest";
import { collectPassthroughData, mergeSettingsData } from "../src/libs/setting-data";

describe("settings legacy migration passthrough", () => {
    it("preserves unknown legacy tokens across unrelated setting saves", () => {
        const loaded = {
            sykey: "token-1",
            sykey2: "token-2",
            syurl: "https://old.example.com",
        };
        const passthrough = collectPassthroughData(loaded, ["syurl"]);
        const saved = mergeSettingsData(passthrough, [
            ["syurl", { type: "textinput", value: "https://new.example.com" }],
            ["validate", { type: "button", value: "" }],
        ]);

        expect(saved).toEqual({
            sykey: "token-1",
            sykey2: "token-2",
            syurl: "https://new.example.com",
        });
    });

    it("allows one migrated target token to be removed without deleting the other", () => {
        const passthrough = { sykey2: "token-2" };
        expect(mergeSettingsData(passthrough, [
            ["syurl", { type: "textinput", value: "https://example.com" }],
        ])).toEqual({
            sykey2: "token-2",
            syurl: "https://example.com",
        });
    });
});
