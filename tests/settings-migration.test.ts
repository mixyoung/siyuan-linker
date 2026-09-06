import { describe, expect, it } from "vitest";
import { collectPassthroughData, mergeSettingsData } from "../src/libs/setting-data";
import { migrateTransferModeSettings } from "../src/settings-migration";

describe("transfer mode settings migration", () => {
    it.each([
        [true, "exact-id-mirror"],
        [false, "independent-copy"],
    ] as const)("migrates preserveIds=%s", (preserveIds, expected) => {
        expect(migrateTransferModeSettings({ preserveIds })).toEqual({
            transferMode: expected,
            removePreserveIds: true,
        });
    });

    it("keeps an explicit valid transferMode ahead of the legacy checkbox", () => {
        expect(migrateTransferModeSettings({
            transferMode: "independent-copy",
            preserveIds: true,
        }).transferMode).toBe("independent-copy");
    });

    it("defaults invalid or absent modes to independent copy", () => {
        expect(migrateTransferModeSettings({ transferMode: "unknown" }).transferMode)
            .toBe("independent-copy");
        expect(migrateTransferModeSettings(null).transferMode).toBe("independent-copy");
    });

    it("removes preserveIds from passthrough while preserving unrelated legacy keys", () => {
        const loaded = {
            preserveIds: true,
            sykey: "legacy-token",
            unrelatedLegacyFlag: "keep-me",
        };
        const migration = migrateTransferModeSettings(loaded);
        const passthrough = collectPassthroughData(loaded, ["transferMode"]);
        if (migration.removePreserveIds) delete passthrough.preserveIds;

        const saved = mergeSettingsData(passthrough, [
            ["transferMode", { type: "select", value: migration.transferMode }],
        ]);

        expect(saved).toEqual({
            sykey: "legacy-token",
            unrelatedLegacyFlag: "keep-me",
            transferMode: "exact-id-mirror",
        });
        expect(saved).not.toHaveProperty("preserveIds");
    });
});
