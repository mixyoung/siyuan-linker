import { describe, expect, it } from "vitest";
import { buildConfirmationList, escapeHtml } from "../src/confirmation-content";

describe("confirmation content", () => {
    it("escapes text before inserting it into SiYuan dialog HTML", () => {
        expect(escapeHtml('<status reason="remote">Tom & Jerry\'s</status>'))
            .toBe("&lt;status reason=&quot;remote&quot;&gt;Tom &amp; Jerry&#39;s&lt;/status&gt;");
    });

    it("renders non-empty items as an unordered list", () => {
        expect(buildConfirmationList([" First item ", "", "Second <item>"], " Continue? ")).toBe(
            '<ul class="siyuan-linker-confirm-list"><li>First item</li><li>Second &lt;item&gt;</li></ul>'
            + '<p class="siyuan-linker-confirm-question">Continue?</p>',
        );
    });
});
