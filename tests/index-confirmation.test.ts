import { describe, expect, it, vi } from "vitest";
import { awaitConfirmation, buildConfirmationList } from "../src/confirmation-content";

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

    it("formats strong confirmation list with effective endpoints and consequences", () => {
        const items = [
            "有效源端: 本地工作空间",
            "有效目标端: 目标源 1",
            "同步范围: 全工作空间数据",
            "不可逆后果: 将覆盖目标端现有数据",
        ];
        const html = buildConfirmationList(items, "确认以上信息并继续传输？");
        expect(html).toContain("<li>有效源端: 本地工作空间</li>");
        expect(html).toContain("<li>有效目标端: 目标源 1</li>");
        expect(html).toContain("<li>同步范围: 全工作空间数据</li>");
        expect(html).toContain("<li>不可逆后果: 将覆盖目标端现有数据</li>");
        expect(html).toContain("确认以上信息并继续传输？");
    });
});
