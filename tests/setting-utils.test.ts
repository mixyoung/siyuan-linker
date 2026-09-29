import { describe, expect, it, vi } from "vitest";
import { collectPassthroughData, mergeSettingsData } from "../src/libs/setting-data";
import { SettingUtils } from "../src/libs/setting-utils";
import { Setting } from "siyuan";

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

    it("headless (omitFromSettingUI) items survive load, set, save, and dialog confirm without elements", async () => {
        const persisted: Record<string, unknown> = {};
        const fakePlugin: any = {
            data: {},
            loadData: vi.fn(async () => ({
                syurl: "https://target.example.com",
                sysecret: "SECRET_NAME",
                Select: "2",
            })),
            saveData: vi.fn(async (_file: string, data: unknown) => {
                Object.assign(persisted, data as Record<string, unknown>);
            }),
        };

        const utils = new SettingUtils({ plugin: fakePlugin, name: "cfg" });
        utils.addItem({ key: "sysecret", value: "", type: "textinput", title: "", description: "", omitFromSettingUI: true });
        utils.addItem({ key: "syurl", value: "", type: "textinput", title: "", description: "", omitFromSettingUI: true });
        utils.addItem({ key: "Select", value: "1", type: "select", title: "", description: "", omitFromSettingUI: true, options: { "1": "t1", "2": "t2" } });
        utils.addItem({ key: "transferMode", value: "independent-copy", type: "select", title: "", description: "", omitFromSettingUI: true, options: { "exact-id-mirror": "m1", "independent-copy": "m2" } });

        // Regression: load() previously crashed with "item.setEleVal is not a
        // function" on the first headless item, which aborted plugin onload and
        // left pairing/event listeners uninitialized.
        await expect(utils.load()).resolves.toBeTruthy();
        expect(utils.get("syurl")).toBe("https://target.example.com");
        expect(utils.get("Select")).toBe("2");

        // set()/setAndSave() must not require a bound DOM element.
        utils.set("sysecret", "CHANGED");
        expect(utils.get("sysecret")).toBe("CHANGED");

        // Dialog confirm callback iterates every registered key; it must not
        // throw on headless items and must persist their current values.
        const dialogOptions = (Setting as unknown as { lastOptions: { confirmCallback: () => void; destroyCallback: () => void } }).lastOptions;
        expect(() => dialogOptions.confirmCallback()).not.toThrow();
        expect(persisted.syurl).toBe("https://target.example.com");
        expect(persisted.sysecret).toBe("CHANGED");
        expect(persisted.Select).toBe("2");
        expect(() => dialogOptions.destroyCallback()).not.toThrow();
    });
});
