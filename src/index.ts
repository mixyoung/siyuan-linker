import { createApp, type App as VueApp } from "vue";
import {
    Menu,
    Plugin,
    showMessage,
    type Custom,
    type IProtyle,
    type MobileCustom,
} from "siyuan";
import App from "./app.vue";
import "@/index.scss";
import { getSystemVersion, listNotebooks, validateTargetUrl, type TargetConnection } from "./siyuan-api";
import { transferAllData, transferDocuments, type TransferMode } from "./transfer-service";
import { SettingUtils } from "./libs/setting-utils";

const STORAGE_NAME = "menu-config";
const REMOTE_NOTES_DOCK_TYPE = "siyuan-linker-remote-notes";

type TargetNumber = "1" | "2";

type DocumentEvent = CustomEvent<{ protyle: IProtyle }>;

export default class SiYuanLinker extends Plugin {
    private settingUtils!: SettingUtils;
    private currentDocId: string | null = null;
    private selectedTarget: TargetNumber = "1";
    private targetConnection: TargetConnection = { url: "", token: "" };
    private targetChangeListeners = new Set<() => void>();
    private legacyTokens: Partial<Record<TargetNumber, string>> = {};

    async onload() {
        this.addIcons(`<symbol id="iconLinker" viewBox="0 0 32 32">
<rect x="4.5" y="5.5" width="17" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2" opacity="0.48"></rect>
<rect x="10.5" y="6.5" width="17" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="2"></rect>
<path d="M8 13.5h13.5l-2.8-2.8M24 19.5H10.5l2.8 2.8" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"></path>
</symbol>`);

        this.addTopBar({
            id: "transfer",
            icon: "iconLinker",
            title: this.i18n.dataTransfer,
            position: "right",
            callback: (event: MouseEvent) => {
                const anchor = event.currentTarget instanceof HTMLElement
                    ? event.currentTarget.getBoundingClientRect()
                    : undefined;
                this.openTransferMenu(anchor);
            },
        });

        const plugin = this;
        const dockApps = new WeakMap<Custom | MobileCustom, VueApp>();
        this.addDock({
            id: REMOTE_NOTES_DOCK_TYPE,
            config: {
                position: "RightTop",
                size: { width: 300, height: 0 },
                icon: "iconLinker",
                title: this.i18n.remoteNotes,
            },
            data: null,
            type: REMOTE_NOTES_DOCK_TYPE,
            init: function () {
                const mountPoint = document.createElement("div");
                mountPoint.className = "siyuan-linker-remote-notes-dock";
                mountPoint.style.height = "100%";
                mountPoint.style.width = "100%";
                this.element.appendChild(mountPoint);
                const app = createApp(App, { plugin });
                app.mount(mountPoint);
                dockApps.set(this, app);
            },
            destroy: function () {
                dockApps.get(this)?.unmount();
                dockApps.delete(this);
            },
        });

        this.setupSettings();
        const loaded = await this.settingUtils.load() as Record<string, unknown> | null;
        this.legacyTokens = {
            "1": typeof loaded?.sykey === "string" ? loaded.sykey.trim() : "",
            "2": typeof loaded?.sykey2 === "string" ? loaded.sykey2.trim() : "",
        };
        if (this.legacyTokens["1"] || this.legacyTokens["2"]) {
            showMessage(this.i18n.legacyTokenWarning, 10000, "error");
        }
        this.selectedTarget = String(this.settingUtils.get("Select") ?? "1") as TargetNumber;
        this.syncTargetConnection();

        this.eventBus.on("switch-protyle", this.handleDocumentSwitch);
        this.eventBus.on("loaded-protyle-dynamic", this.handleDocumentSwitch);
        this.eventBus.on("loaded-protyle-static", this.handleDocumentSwitch);
    }

    private setupSettings() {
        this.settingUtils = new SettingUtils({ plugin: this, name: STORAGE_NAME });

        this.addTextSetting("sysecret", this.i18n.targetTokenSecret1, this.i18n.targetTokenSecret1Description, "1");
        this.addTextSetting("syurl", this.i18n.targetUrl1, this.i18n.targetUrl1Description, "1");
        this.addTextSetting("sysecret2", this.i18n.targetTokenSecret2, this.i18n.targetTokenSecret2Description, "2");
        this.addTextSetting("syurl2", this.i18n.targetUrl2, this.i18n.targetUrl2Description, "2");

        this.settingUtils.addItem({
            key: "Select",
            value: "1",
            type: "select",
            title: this.i18n.targetSource,
            description: this.i18n.targetSourceDescription,
            options: { 1: this.i18n.target1, 2: this.i18n.target2 },
            action: {
                callback: async () => {
                    this.selectedTarget = String(await this.settingUtils.takeAndSave("Select")) as TargetNumber;
                    this.syncTargetConnection();
                },
            },
        });

        this.settingUtils.addItem({
            key: "isconnect",
            value: "",
            type: "button",
            title: this.i18n.validateConnection,
            description: this.i18n.validateConnectionDescription,
            button: { label: this.i18n.validate, callback: () => void this.validateConnection() },
        });
        this.settingUtils.addItem({
            key: "push",
            value: "",
            type: "button",
            title: this.i18n.transferAll,
            description: this.i18n.transferAllDescription,
            button: { label: this.i18n.transfer, callback: () => void this.runPush() },
        });
        this.settingUtils.addItem({
            key: "pull",
            value: "",
            type: "button",
            title: this.i18n.pullAll,
            description: this.i18n.pullAllDescription,
            button: { label: this.i18n.pull, callback: () => void this.runPull() },
        });

        this.addCheckboxSetting("preserveIds", false, this.i18n.preserveIds, this.i18n.preserveIdsDescription);
        this.addCheckboxSetting("allowInsecureHttp", false, this.i18n.allowInsecureHttp, this.i18n.allowInsecureHttpDescription);
        this.addCheckboxSetting("islog", true, this.i18n.enableLogging, this.i18n.enableLoggingDescription);
    }

    private addTextSetting(key: string, title: string, description: string, targetNumber: TargetNumber) {
        this.settingUtils.addItem({
            key,
            value: "",
            type: "textinput",
            title,
            description,
            action: {
                callback: async () => {
                    await this.settingUtils.takeAndSave(key);
                    if (this.selectedTarget === targetNumber) this.syncTargetConnection();
                },
            },
        });
    }

    private addCheckboxSetting(key: string, value: boolean, title: string, description: string) {
        this.settingUtils.addItem({
            key,
            value,
            type: "checkbox",
            title,
            description,
            action: { callback: async () => { await this.settingUtils.takeAndSave(key); } },
        });
    }

    private readConfiguredSecret(targetNumber: TargetNumber): string {
        const suffix = targetNumber === "1" ? "" : "2";
        const secretName = String(this.settingUtils.get(`sysecret${suffix}`) ?? "").trim();
        if (!secretName) return "";
        try {
            return this.getSecret(secretName).trim();
        } catch (error) {
            console.warn("Unable to read the configured SiYuan secret", error);
            return "";
        }
    }

    private resolveToken(targetNumber: TargetNumber): string {
        return this.readConfiguredSecret(targetNumber) || this.legacyTokens[targetNumber] || "";
    }

    private syncTargetConnection() {
        const suffix = this.selectedTarget === "1" ? "" : "2";
        const rawUrl = String(this.settingUtils.get(`syurl${suffix}`) ?? "").trim();
        this.targetConnection = {
            url: rawUrl.replace(/\/+$/, ""),
            token: this.resolveToken(this.selectedTarget),
        };
        for (const listener of this.targetChangeListeners) listener();
    }

    public onTargetChange(listener: () => void): () => void {
        this.targetChangeListeners.add(listener);
        return () => this.targetChangeListeners.delete(listener);
    }

    public getTargetConnection(): TargetConnection {
        if (!this.targetConnection.url) throw new Error(this.i18n.configureTargetFirst);
        return {
            ...this.targetConnection,
            url: validateTargetUrl(this.targetConnection.url, Boolean(this.settingUtils.get("allowInsecureHttp"))),
        };
    }

    public getSelectedTargetLabel(): string {
        return this.selectedTarget === "1" ? this.i18n.target1 : this.i18n.target2;
    }

    private getTransferMode(): TransferMode {
        return this.settingUtils.get("preserveIds") ? "preserve-ids" : "safe";
    }

    private confirmSelectiveTransferScope(): boolean {
        return window.confirm(
            this.getTransferMode() === "preserve-ids"
                ? this.i18n.preserveTransferWarning
                : this.i18n.safeTransferScopeWarning,
        );
    }

    private readonly handleDocumentSwitch = (event: DocumentEvent) => {
        this.currentDocId = event.detail?.protyle?.block?.id ?? null;
    };

    onLayoutReady() {
        const activeTitle = document.querySelector<HTMLElement>(
            ".layout__wnd--active .protyle:not(.fn__none) .protyle-title[data-node-id]",
        );
        this.currentDocId = activeTitle?.dataset.nodeId ?? this.currentDocId;
    }

    private openTransferMenu(rect?: DOMRect) {
        const menu = new Menu("siyuan-linker-transfer-menu");
        menu.addItem({
            icon: "iconLinker",
            label: this.i18n.transferCurrentNote,
            click: () => void this.runSingleTransfer(),
        });
        menu.open({ x: rect?.right ?? 0, y: rect?.bottom ?? 0, isLeft: true });
    }

    private async validateConnection() {
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.validating, 3000, "info");
            const [version, notebooks] = await Promise.all([getSystemVersion(target), listNotebooks(target)]);
            showMessage(
                this.i18n.connectionSucceededVersion
                    .replace("${version}", version)
                    .replace("${count}", String(notebooks.length)),
                6000,
                "info",
            );
            if (this.readConfiguredSecret(this.selectedTarget)) {
                const legacyKey = this.selectedTarget === "1" ? "sykey" : "sykey2";
                this.legacyTokens[this.selectedTarget] = "";
                this.settingUtils.removePersistedKey(legacyKey);
                await this.settingUtils.save();
            }
        } catch (error) {
            this.reportError(this.i18n.connectionFailed, error);
        }
    }

    private async runSingleTransfer() {
        if (!this.currentDocId) {
            showMessage(this.i18n.noCurrentDocument, 6000, "error");
            return;
        }
        if (!this.confirmSelectiveTransferScope()) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.singleTransfer);
            const result = await transferDocuments([this.currentDocId], this.getTransferMode(), undefined, target);
            this.showTransferResult(this.i18n.transferCompleted, result.warnings, this.i18n.singleTransfer);
        } catch (error) {
            this.reportError(this.i18n.transferFailed, error);
        }
    }

    public async pullNote(docIds: string[]) {
        if (!docIds.length || !this.confirmSelectiveTransferScope()) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.multipleTransfer);
            const result = await transferDocuments(docIds, this.getTransferMode(), target, undefined);
            this.showTransferResult(
                this.i18n.notesPulled.replace("${count}", String(result.count)),
                result.warnings,
                this.i18n.multipleTransfer,
            );
        } catch (error) {
            this.reportError(this.i18n.pullFailed, error);
        }
    }

    private async runPush() {
        if (!window.confirm(this.i18n.fullTransferWarning)) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.transferAll);
            await transferAllData(undefined, target);
            showMessage(this.i18n.transferCompleted, 6000, "info", this.i18n.transferAll);
        } catch (error) {
            this.reportError(this.i18n.transferFailedPartial, error);
        }
    }

    private async runPull() {
        if (!window.confirm(this.i18n.fullPullWarning)) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.pullAll);
            await transferAllData(target, undefined);
            showMessage(this.i18n.pullCompleted, 6000, "info", this.i18n.pullAll);
        } catch (error) {
            this.reportError(this.i18n.pullFailedPartial, error);
        }
    }

    private showTransferResult(message: string, warnings: string[], title: string) {
        if (warnings.length) {
            showMessage(`${message}. ${this.i18n.fileTreeReloadWarning}`, 10000, "error", title);
            return;
        }
        showMessage(message, 6000, "info", title);
    }

    private reportError(prefix: string, error: unknown) {
        console.error(prefix, error);
        const message = error instanceof Error ? error.message : String(error);
        showMessage(`${prefix}: ${message}`, -1, "error");
    }

    onunload() {
        this.eventBus.off("switch-protyle", this.handleDocumentSwitch);
        this.eventBus.off("loaded-protyle-dynamic", this.handleDocumentSwitch);
        this.eventBus.off("loaded-protyle-static", this.handleDocumentSwitch);
        this.targetChangeListeners.clear();
    }
}
