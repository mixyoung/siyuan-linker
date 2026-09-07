import { describe, expect, it, vi } from "vitest";
import { awaitConfirmation } from "../src/confirmation-content";

describe("selective transfer confirmation control", () => {
    it("resolves false when the SiYuan dialog is cancelled", async () => {
        let cancel!: () => void;
        const result = awaitConfirmation((_confirm, onCancel) => { cancel = onCancel; });
        const action = vi.fn();
        cancel();
        if (await result) action();
        expect(action).not.toHaveBeenCalled();
    });

    it("resolves true when the SiYuan dialog is confirmed", async () => {
        let confirm!: () => void;
        const result = awaitConfirmation((onConfirm) => { confirm = onConfirm; });
        const action = vi.fn();
        confirm();
        if (await result) action();
        expect(action).toHaveBeenCalledOnce();
    });
});
