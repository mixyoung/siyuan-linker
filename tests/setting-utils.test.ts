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

    it("preserves all registered non-button settings regardless of UI layout", () => {
        const passthrough = {};
        const registeredSettings: Array<[string, { type: string; value: unknown }]> = [
            ["syurl", { type: "textinput", value: "https://target1.example.com" }],
            ["sysecret", { type: "textinput", value: "SECRET_1" }],
            ["syurl2", { type: "textinput", value: "https://target2.example.com" }],
            ["sysecret2", { type: "textinput", value: "SECRET_2" }],
            ["Select", { type: "select", value: "1" }],
            ["transferMode", { type: "select", value: "exact-id-mirror" }],
            ["allowInsecureHttp", { type: "checkbox", value: false }],
            ["islog", { type: "checkbox", value: true }],
            ["isconnect", { type: "button", value: "" }],
            ["pairActiveTarget", { type: "button", value: "" }],
            ["verifyPairing", { type: "button", value: "" }],
            ["resetPairing", { type: "button", value: "" }],
            ["push", { type: "button", value: "" }],
            ["pull", { type: "button", value: "" }],
            ["adoptFullClone", { type: "button", value: "" }],
            ["createAndMapNotebook", { type: "button", value: "" }],
        ];

        const dumped = mergeSettingsData(passthrough, registeredSettings);
        expect(dumped).toEqual({
            syurl: "https://target1.example.com",
            sysecret: "SECRET_1",
            syurl2: "https://target2.example.com",
            sysecret2: "SECRET_2",
            Select: "1",
            transferMode: "exact-id-mirror",
            allowInsecureHttp: false,
            islog: true,
        });
    });
});
