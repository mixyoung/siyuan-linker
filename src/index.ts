import { createApp, type App as VueApp } from "vue";
import {
    confirm as confirmDialog,
    Dialog,
    Menu,
    Plugin,
    showMessage,
    type Custom,
    type IProtyle,
    type MobileCustom,
} from "siyuan";
import App from "./app.vue";
import "@/index.scss";
import { awaitConfirmation, buildConfirmationList, escapeHtml } from "./confirmation-content";
import { getDocumentLocation, getSystemVersion, listNotebooks, readonlySql, validateTargetUrl, type TargetConnection } from "./siyuan-api";
import { transferAllData, transferDocuments, type TransferMode } from "./transfer-service";
import { SettingUtils } from "./libs/setting-utils";
import {
    ADOPT_FULL_CLONE_CONFIRMATION,
    adoptFullCloneDestination,
    createAndMapNotebook,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    resetMirrorPeer,
} from "./mirror-storage";
import { collectDescendantIds } from "./sync-adapters";
import { MirrorOperationError, type MirrorPairStatus } from "./mirror-types";
import { migrateTransferModeSettings, type PersistedTransferMode } from "./settings-migration";

const STORAGE_NAME = "menu-config";
const REMOTE_NOTES_DOCK_TYPE = "siyuan-linker-remote-notes";
const DEFAULT_PAIRING_STATUS: MirrorPairStatus = {
    state: "unknown",
    valid: false,
    reasons: [],
    sourceIdentity: null,
    destinationIdentity: null,
    sourceRecord: null,
    destinationRecord: null,
    allowedNotebookIds: [],
    pending: false,
};

type TargetNumber = "1" | "2";
type DocumentEvent = CustomEvent<{ protyle: IProtyle }>;
type PairingStatusListener = (status: MirrorPairStatus) => void;

export default class SiYuanLinker extends Plugin {
    private settingUtils!: SettingUtils;
    private currentDocId: string | null = null;
    private selectedTarget: TargetNumber = "1";
    private targetConnection: TargetConnection = { url: "", token: "" };
    private targetChangeListeners = new Set<() => void>();
    private pairingStatusListeners = new Set<PairingStatusListener>();
    private pairingStatus: MirrorPairStatus = { ...DEFAULT_PAIRING_STATUS };
    private pairingStatusGeneration = 0;
    private pairingActionInProgress = false;
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
        const migration = migrateTransferModeSettings(loaded);
        this.settingUtils.set("transferMode", migration.transferMode);
        if (migration.removePreserveIds) this.settingUtils.removePersistedKey("preserveIds");
        if (migration.removePreserveIds || loaded?.transferMode !== migration.transferMode) {
            await this.settingUtils.save();
        }

        this.legacyTokens = {
            "1": typeof loaded?.sykey === "string" ? loaded.sykey.trim() : "",
            "2": typeof loaded?.sykey2 === "string" ? loaded.sykey2.trim() : "",
        };
        if (this.legacyTokens["1"] || this.legacyTokens["2"]) {
            showMessage(this.i18n.legacyTokenWarning, 10000, "error");
        }
        const selected = String(this.settingUtils.get("Select") ?? "1");
        this.selectedTarget = selected === "2" ? "2" : "1";
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
                    const selected = String(await this.settingUtils.takeAndSave("Select"));
                    this.selectedTarget = selected === "2" ? "2" : "1";
                    this.syncTargetConnection();
                },
            },
        });

        this.settingUtils.addItem({
            key: "transferMode",
            value: "independent-copy" satisfies PersistedTransferMode,
            type: "select",
            title: this.i18n.transferMode,
            description: this.i18n.transferModeDescription,
            options: {
                "exact-id-mirror": this.i18n.exactIdMirror,
                "independent-copy": this.i18n.independentCopy,
            },
            action: {
                callback: async () => {
                    await this.settingUtils.takeAndSave("transferMode");
                    this.emitPairingStatus();
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
            key: "pairActiveTarget",
            value: "",
            type: "button",
            title: this.i18n.pairActiveTarget,
            description: this.i18n.pairActiveTargetDescription,
            button: { label: this.i18n.pair, callback: () => void this.pairActiveTarget() },
        });
        this.settingUtils.addItem({
            key: "adoptFullClone",
            value: "",
            type: "button",
            title: this.i18n.adoptFullClone,
            description: this.i18n.adoptFullCloneDescription,
            button: { label: this.i18n.adopt, callback: () => void this.adoptActiveTargetFullClone() },
        });
        this.settingUtils.addItem({
            key: "verifyPairing",
            value: "",
            type: "button",
            title: this.i18n.verifyPairing,
            description: this.i18n.verifyPairingDescription,
            button: { label: this.i18n.verify, callback: () => void this.verifyActiveTargetPairing() },
        });
        this.settingUtils.addItem({
            key: "resetPairing",
            value: "",
            type: "button",
            title: this.i18n.resetPairing,
            description: this.i18n.resetPairingDescription,
            button: { label: this.i18n.reset, callback: () => void this.resetActiveTargetPairing() },
        });
        this.settingUtils.addItem({
            key: "createAndMapNotebook",
            value: "",
            type: "button",
            title: this.i18n.createAndMapNotebook,
            description: this.i18n.notebookMapping,
            button: { label: this.i18n.mapNotebook, callback: () => void this.promptCreateAndMapNotebook() },
        });
        this.settingUtils.addItem({
            key: "pairingStatus",
            value: "",
            type: "button",
            title: this.i18n.pairingStatus,
            description: this.i18n.pairingStatusDescription,
            createElement: () => {
                const element = document.createElement("div");
                element.className = "b3-label fn__flex-center";
                element.style.whiteSpace = "pre-line";
                this.updatePairingStatusElement(element);
                return element;
            },
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
        this.pairingStatusGeneration += 1;
        this.pairingStatus = { ...DEFAULT_PAIRING_STATUS, state: "unknown" };
        for (const listener of this.targetChangeListeners) listener();
        this.emitPairingStatus();
        void this.refreshPairingStatus();
    }

    public onTargetChange(listener: () => void): () => void {
        this.targetChangeListeners.add(listener);
        return () => this.targetChangeListeners.delete(listener);
    }

    public onPairingStatusChange(listener: PairingStatusListener): () => void {
        this.pairingStatusListeners.add(listener);
        listener(this.pairingStatus);
        return () => this.pairingStatusListeners.delete(listener);
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

    public getCurrentTransferMode(): TransferMode {
        return this.settingUtils.get("transferMode") === "exact-id-mirror" ? "preserve-ids" : "safe";
    }

    public getCurrentTransferModeLabel(): string {
        return this.getCurrentTransferMode() === "preserve-ids" ? this.i18n.exactIdMirror : this.i18n.independentCopy;
    }

    public getPairingStatus(): MirrorPairStatus {
        return this.pairingStatus;
    }

    public async refreshPairingStatus(): Promise<MirrorPairStatus> {
        const generation = ++this.pairingStatusGeneration;
        const targetSlot = this.selectedTarget;
        const targetUrl = this.targetConnection.url;
        this.pairingStatus = { ...DEFAULT_PAIRING_STATUS, state: "loading" };
        this.emitPairingStatus();
        const isCurrentRequest = () => generation === this.pairingStatusGeneration
            && targetSlot === this.selectedTarget && targetUrl === this.targetConnection.url;
        try {
            const target = this.getTargetConnection();
            const status = await inspectMirrorPair(undefined, target);
            if (!isCurrentRequest()) return this.pairingStatus;
            this.pairingStatus = {
                ...status,
                state: "ready",
                reasons: status.reasons.map((reason) => this.sanitizeSensitiveText(reason)),
            };
        } catch (error) {
            if (!isCurrentRequest()) return this.pairingStatus;
            this.pairingStatus = {
                ...DEFAULT_PAIRING_STATUS,
                state: "unknown",
                reasons: [this.safeErrorText(error)],
            };
        }
        this.emitPairingStatus();
        return this.pairingStatus;
    }

    private setPairingActionsBusy(busy: boolean) {
        this.pairingActionInProgress = busy;
        for (const key of ["pairActiveTarget", "adoptFullClone", "verifyPairing", "resetPairing"]) {
            if (busy) this.settingUtils.disable(key);
            else this.settingUtils.enable(key);
        }
    }

    public async pairActiveTarget(): Promise<void> {
        if (this.pairingActionInProgress) return;
        this.setPairingActionsBusy(true);
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pairing, -1, "info");
            const result = await pairMirrorWorkspaces(undefined, target);
            await this.refreshPairingStatus();
            showMessage(
                this.i18n.pairingSucceeded
                    .replace("${pairId}", this.shortId(result.pairId))
                    .replace("${count}", String(result.allowedNotebookIds.length)),
                8000,
                "info",
            );
        } catch (error) {
            await this.refreshPairingStatus();
            this.reportError(this.i18n.pairingFailed, error);
        } finally {
            this.setPairingActionsBusy(false);
        }
    }

    public async adoptActiveTargetFullClone(): Promise<void> {
        if (this.pairingActionInProgress) return;
        const items = [
            `${this.i18n.effectiveDestination}: ${this.getSelectedTargetLabel()}`,
            this.i18n.adoptFullCloneConfirm,
        ];
        const typed = await this.promptPhraseDialog(
            this.i18n.adoptFullClone,
            items,
            this.i18n.adoptFullClonePrompt,
        );
        if (typed === null) return;
        if (typed !== ADOPT_FULL_CLONE_CONFIRMATION) {
            showMessage(this.i18n.adoptFullCloneConfirmationMismatch, 8000, "error");
            return;
        }
        this.setPairingActionsBusy(true);
        try {
            const target = this.getTargetConnection();
            const result = await adoptFullCloneDestination(undefined, target, typed);
            await this.refreshPairingStatus();
            showMessage(this.i18n.adoptFullCloneSucceeded.replace("${archivePath}", result.archivePath), 10000, "info");
        } catch (error) {
            await this.refreshPairingStatus();
            this.reportError(this.i18n.adoptFullCloneFailed, error);
        } finally {
            this.setPairingActionsBusy(false);
        }
    }

    public async resetActiveTargetPairing(): Promise<void> {
        if (this.pairingActionInProgress) return;
        const current = await this.refreshPairingStatus();
        let force = false;
        if (current.pending) {
            if (!await this.confirmActionWithList(this.i18n.resetPairing, [this.i18n.resetPairingPendingConfirm])) return;
            force = true;
        } else if (!await this.confirmActionWithList(this.i18n.resetPairing, [this.i18n.resetPairingConfirm])) {
            return;
        }
        this.setPairingActionsBusy(true);
        try {
            const target = this.getTargetConnection();
            await resetMirrorPeer(undefined, target, { force });
            await this.refreshPairingStatus();
            showMessage(this.i18n.pairingResetSucceeded, 6000, "info");
        } catch (error) {
            await this.refreshPairingStatus();
            this.reportError(this.i18n.pairingResetFailed, error);
        } finally {
            this.setPairingActionsBusy(false);
        }
    }

    private async verifyActiveTargetPairing() {
        if (this.pairingActionInProgress) return;
        this.setPairingActionsBusy(true);
        const status = await this.refreshPairingStatus();
        try {
            showMessage(
                status.state === "ready" && status.valid && !status.pending ? this.i18n.pairingVerified : this.pairingRequiredMessage(status),
                status.state === "ready" && status.valid && !status.pending ? 6000 : -1,
                status.state === "ready" && status.valid && !status.pending ? "info" : "error",
            );
        } finally {
            this.setPairingActionsBusy(false);
        }
    }

    private emitPairingStatus() {
        this.updatePairingStatusElement();
        for (const listener of this.pairingStatusListeners) listener(this.pairingStatus);
    }

    private updatePairingStatusElement(element = this.settingUtils?.getElement("pairingStatus")) {
        if (element) element.textContent = this.formatPairingStatus(this.pairingStatus);
    }

    private pairingStatusItems(status: MirrorPairStatus): string[] {
        const pairId = status.sourceRecord?.pairId ?? status.destinationRecord?.pairId;
        const state = status.state === "loading"
            ? this.i18n.pairingStateLoading
            : status.state === "unknown"
                ? this.i18n.pairingStateUnknown
                : status.pending
                    ? this.i18n.pairingStatePending
                    : status.valid
                        ? this.i18n.pairingStateValid
                        : pairId
                            ? this.i18n.pairingStateMismatch
                            : this.i18n.pairingStateNotPaired;
        const reasons = status.reasons.length
            ? status.reasons.map((reason) => this.sanitizeSensitiveText(reason)).join("; ")
            : this.i18n.none;
        return [
            `${this.i18n.status}: ${state}`,
            `${this.i18n.pairId}: ${pairId ? this.shortId(pairId) : this.i18n.none}`,
            `${this.i18n.localWorkspaceId}: ${status.sourceIdentity ? this.shortId(status.sourceIdentity.workspaceId) : this.i18n.none}`,
            `${this.i18n.remoteWorkspaceId}: ${status.destinationIdentity ? this.shortId(status.destinationIdentity.workspaceId) : this.i18n.none}`,
            `${this.i18n.allowedNotebooks}: ${status.allowedNotebookIds.length}`,
            `${this.i18n.pendingOrMismatchReasons}: ${reasons}`,
        ];
    }

    private formatPairingStatus(status: MirrorPairStatus): string {
        return this.pairingStatusItems(status).join("\n");
    }

    private pairingRequiredMessage(status = this.pairingStatus): string {
        const reasons = status.reasons.length
            ? status.reasons.map((reason) => this.sanitizeSensitiveText(reason)).join("; ")
            : this.i18n.pairingNotVerified;
        return this.i18n.pairingRequired.replace("${reasons}", reasons);
    }

    private async ensureExactModeReady(): Promise<boolean> {
        if (this.getCurrentTransferMode() !== "preserve-ids") return true;
        const status = await this.refreshPairingStatus();
        if (status.state === "ready" && status.valid && !status.pending) return true;
        showMessage(this.pairingRequiredMessage(status), -1, "error");
        return false;
    }

    private confirmSelectiveTransferScope(): Promise<boolean> {
        const items = this.getCurrentTransferMode() === "preserve-ids"
            ? [
                this.i18n.exactMirrorWarningIdentity,
                this.i18n.exactMirrorWarningConflicts,
                this.i18n.exactMirrorWarningUnsupported,
                this.i18n.exactMirrorWarningRollback,
                ...this.pairingStatusItems(this.pairingStatus),
            ]
            : [
                this.i18n.independentCopyWarningArchive,
                this.i18n.independentCopyWarningNewIds,
                this.i18n.independentCopyWarningExpandedScope,
            ];
        return this.confirmActionWithList(this.i18n.selectiveTransferConfirmTitle, items);
    }

    private confirmActionWithList(
        title: string,
        items: string[],
        question: string = this.i18n.selectiveTransferContinue,
    ): Promise<boolean> {
        return awaitConfirmation((confirm, cancel) => confirmDialog(
            escapeHtml(title),
            buildConfirmationList(items, question),
            confirm,
            cancel,
        ));
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

    private promptPhraseDialog(
        title: string,
        items: string[],
        prompt: string,
    ): Promise<string | null> {
        return new Promise((resolve) => {
            let settled = false;
            const listHtml = items.length ? `<ul class="siyuan-linker-confirm-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "";
            const content = `
<div class="b3-dialog__content" style="padding: 16px;">
    ${listHtml}
    <p class="siyuan-linker-confirm-question" style="margin-top: 12px;">${escapeHtml(prompt)}</p>
    <div style="margin-top: 12px;">
        <input class="b3-text-field fn__block siyuan-linker-dialog-input" type="text" autofocus />
    </div>
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel siyuan-linker-dialog-cancel">${escapeHtml(this.i18n.cancelAction)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text siyuan-linker-dialog-confirm">${escapeHtml(this.i18n.confirmAction)}</button>
</div>`;

            const dialog = new Dialog({
                title: escapeHtml(title),
                content,
                width: "520px",
                destroyCallback: () => {
                    if (!settled) {
                        settled = true;
                        resolve(null);
                    }
                },
            });

            const element = dialog.element;
            const input = element.querySelector<HTMLInputElement>(".siyuan-linker-dialog-input");
            const cancelBtn = element.querySelector<HTMLButtonElement>(".siyuan-linker-dialog-cancel");
            const confirmBtn = element.querySelector<HTMLButtonElement>(".siyuan-linker-dialog-confirm");

            cancelBtn?.addEventListener("click", () => {
                if (!settled) {
                    settled = true;
                    dialog.destroy();
                    resolve(null);
                }
            });

            const doConfirm = () => {
                if (!settled) {
                    settled = true;
                    const value = input?.value?.trim() ?? "";
                    dialog.destroy();
                    resolve(value);
                }
            };

            confirmBtn?.addEventListener("click", doConfirm);
            input?.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    doConfirm();
                }
            });
            setTimeout(() => input?.focus(), 50);
        });
    }

    private promptNotebookMappingDialog(
        localNotebooks: Array<{ id: string; name: string }>,
    ): Promise<{ localNotebookId: string; destinationNotebookName: string } | null> {
        return new Promise((resolve) => {
            let settled = false;
            const optionsHtml = localNotebooks
                .map((nb, idx) => `<option value="${escapeHtml(nb.id)}"${idx === 0 ? " selected" : ""}>${escapeHtml(nb.name)} (${escapeHtml(nb.id)})</option>`)
                .join("");
            const initialName = localNotebooks[0]?.name ?? "";

            const content = `
<div class="b3-dialog__content" style="padding: 16px;">
    <div class="b3-label" style="margin-bottom: 6px;">${escapeHtml(this.i18n.selectLocalNotebook)}</div>
    <select class="b3-select fn__block siyuan-linker-nb-select">${optionsHtml}</select>
    <div style="height: 14px;"></div>
    <div class="b3-label" style="margin-bottom: 6px;">${escapeHtml(this.i18n.targetNotebookName)}</div>
    <input class="b3-text-field fn__block siyuan-linker-nb-name" type="text" value="${escapeHtml(initialName)}" />
</div>
<div class="b3-dialog__action">
    <button class="b3-button b3-button--cancel siyuan-linker-dialog-cancel">${escapeHtml(this.i18n.cancelAction)}</button>
    <div class="fn__space"></div>
    <button class="b3-button b3-button--text siyuan-linker-dialog-confirm">${escapeHtml(this.i18n.confirmAction)}</button>
</div>`;

            const dialog = new Dialog({
                title: escapeHtml(this.i18n.createAndMapNotebook),
                content,
                width: "520px",
                destroyCallback: () => {
                    if (!settled) {
                        settled = true;
                        resolve(null);
                    }
                },
            });

            const element = dialog.element;
            const select = element.querySelector<HTMLSelectElement>(".siyuan-linker-nb-select");
            const nameInput = element.querySelector<HTMLInputElement>(".siyuan-linker-nb-name");
            const cancelBtn = element.querySelector<HTMLButtonElement>(".siyuan-linker-dialog-cancel");
            const confirmBtn = element.querySelector<HTMLButtonElement>(".siyuan-linker-dialog-confirm");

            select?.addEventListener("change", () => {
                const found = localNotebooks.find((nb) => nb.id === select.value);
                if (found && nameInput) {
                    nameInput.value = found.name;
                }
            });

            cancelBtn?.addEventListener("click", () => {
                if (!settled) {
                    settled = true;
                    dialog.destroy();
                    resolve(null);
                }
            });

            const doConfirm = () => {
                if (!settled) {
                    const localNotebookId = select?.value ?? "";
                    const destinationNotebookName = nameInput?.value?.trim() ?? "";
                    if (!localNotebookId || !destinationNotebookName) {
                        showMessage(this.i18n.targetNotebookNameRequired, 6000, "error");
                        return;
                    }
                    settled = true;
                    dialog.destroy();
                    resolve({ localNotebookId, destinationNotebookName });
                }
            };

            confirmBtn?.addEventListener("click", doConfirm);
            nameInput?.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    doConfirm();
                }
            });
            setTimeout(() => nameInput?.focus(), 50);
        });
    }

    public async promptCreateAndMapNotebook(): Promise<void> {
        if (this.pairingActionInProgress) return;
        try {
            const localNotebooks = await listNotebooks();
            if (!localNotebooks.length) {
                showMessage(this.i18n.noNotebooks, 6000, "error");
                return;
            }
            const mappingInput = await this.promptNotebookMappingDialog(localNotebooks);
            if (!mappingInput) return;

            const target = this.getTargetConnection();
            this.setPairingActionsBusy(true);
            showMessage(this.i18n.validating, -1, "info");
            const created = await createAndMapNotebook(
                mappingInput.localNotebookId,
                mappingInput.destinationNotebookName,
                undefined,
                target,
            );
            await this.refreshPairingStatus();
            showMessage(
                this.i18n.notebookMappedSucceeded
                    .replace("${name}", created.name)
                    .replace("${id}", created.id),
                6000,
                "info",
            );
        } catch (error) {
            await this.refreshPairingStatus();
            this.reportError(this.i18n.pairingFailed, error);
        } finally {
            this.setPairingActionsBusy(false);
        }
    }

    private openTransferMenu(rect?: DOMRect) {
        const menu = new Menu("siyuan-linker-transfer-menu");
        menu.addItem({
            icon: "iconLinker",
            label: this.i18n.transferCurrentNote,
            click: () => void this.runSingleTransfer(false),
        });
        menu.addItem({
            icon: "iconLinker",
            label: this.i18n.transferCurrentNoteTree,
            click: () => void this.runSingleTransfer(true),
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
            await this.refreshPairingStatus();
        } catch (error) {
            this.reportError(this.i18n.connectionFailed, error);
        }
    }

    /**
     * Runs a selective transfer; when the exact mirror aborts on first-sync
     * content conflicts (no baseline yet), offers an explicit
     * source-authoritative overwrite and retries once with that consent.
     */
    private async runSelectiveTransfer(docIds: string[], source: TargetConnection | undefined, destination: TargetConnection | undefined, running: string, completed: (result: { count: number; warnings: string[] }) => void) {
        const attempt = (options?: { adoptFirstBaselineConflicts?: boolean }) =>
            transferDocuments(docIds, this.getCurrentTransferMode(), source, destination, options);
        try {
            showMessage(running, -1, "info");
            completed(await attempt());
        } catch (error) {
            const conflicts = error instanceof MirrorOperationError ? error.details.firstSyncConflicts ?? [] : [];
            if (!conflicts.length) {
                throw error;
            }
            const items = [
                this.i18n.firstSyncConflictConfirm,
                ...conflicts.map((id) => `${this.i18n.document}: ${id}`),
            ];
            const confirmed = await this.confirmActionWithList(
                this.i18n.firstSyncConflictTitle,
                items,
            );
            if (!confirmed) {
                throw error;
            }
            showMessage(running, -1, "info");
            completed(await attempt({ adoptFirstBaselineConflicts: true }));
        }
    }

    private async runSingleTransfer(includeDescendants = false) {
        if (!this.currentDocId) {
            showMessage(this.i18n.noCurrentDocument, 6000, "error");
            return;
        }
        if (!await this.ensureExactModeReady() || !await this.confirmSelectiveTransferScope()) return;
        try {
            let docIds = [this.currentDocId];
            if (includeDescendants) {
                try {
                    const loc = await getDocumentLocation(this.currentDocId);
                    const rows = await readonlySql(`SELECT id, parent_id, root_id, box, path, hpath FROM blocks WHERE type = 'd' AND box = '${loc.notebookId}'`);
                    const descIds = collectDescendantIds(this.currentDocId, rows as unknown as Array<{ id: string; parent_id: string; root_id: string; box: string; path: string; hpath: string }>);
                    docIds = [...new Set([this.currentDocId, ...descIds])];
                } catch (error) {
                    console.warn("Unable to enumerate descendants, falling back to current note", error);
                }
            }
            await this.runSelectiveTransfer(
                docIds, undefined, this.getTargetConnection(), this.i18n.transferring,
                (result) => this.showTransferResult(this.i18n.transferCompleted, result.warnings, this.i18n.singleTransfer),
            );
        } catch (error) {
            this.reportError(this.i18n.transferFailed, error);
        } finally {
            await this.refreshPairingStatus();
        }
    }

    public async pullNote(docIds: string[]) {
        if (!docIds.length || !await this.ensureExactModeReady() || !await this.confirmSelectiveTransferScope()) return;
        try {
            await this.runSelectiveTransfer(
                docIds, this.getTargetConnection(), undefined, this.i18n.pulling,
                (result) => this.showTransferResult(
                    this.i18n.notesPulled.replace("${count}", String(result.count)),
                    result.warnings,
                    this.i18n.multipleTransfer,
                ),
            );
        } catch (error) {
            this.reportError(this.i18n.pullFailed, error);
        } finally {
            await this.refreshPairingStatus();
        }
    }

    private async runPush() {
        const items = [
            `${this.i18n.effectiveSource}: ${this.i18n.localWorkspace}`,
            `${this.i18n.effectiveDestination}: ${this.getSelectedTargetLabel()}`,
            `${this.i18n.syncScope}: ${this.i18n.fullWorkspaceData}`,
            `${this.i18n.irreversibleConsequences}: ${this.i18n.fullTransferWarning}`,
        ];
        if (!await this.confirmActionWithList(this.i18n.fullTransferConfirmTitle, items)) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.transferAll);
            await transferAllData(undefined, target);
            showMessage(this.i18n.transferCompleted, 6000, "info", this.i18n.transferAll);
        } catch (error) {
            this.reportError(this.i18n.transferFailedPartial, error);
        } finally {
            await this.refreshPairingStatus();
        }
    }

    private async runPull() {
        const items = [
            `${this.i18n.effectiveSource}: ${this.getSelectedTargetLabel()}`,
            `${this.i18n.effectiveDestination}: ${this.i18n.localWorkspace}`,
            `${this.i18n.syncScope}: ${this.i18n.fullWorkspaceData}`,
            `${this.i18n.irreversibleConsequences}: ${this.i18n.fullPullWarning}`,
        ];
        if (!await this.confirmActionWithList(this.i18n.fullPullConfirmTitle, items)) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.pullAll);
            await transferAllData(target, undefined);
            showMessage(this.i18n.pullCompleted, 6000, "info", this.i18n.pullAll);
        } catch (error) {
            this.reportError(this.i18n.pullFailedPartial, error);
        } finally {
            await this.refreshPairingStatus();
        }
    }

    private showTransferResult(message: string, warnings: string[], title: string) {
        if (warnings.length) {
            showMessage(`${message}. ${this.i18n.fileTreeReloadWarning}`, 10000, "error", title);
            return;
        }
        showMessage(message, 6000, "info", title);
    }

    private shortId(value: string): string {
        return value.length > 8 ? `${value.slice(0, 8)}…` : value;
    }

    private sanitizeSensitiveText(value: string): string {
        let sanitized = value;
        const token = this.targetConnection.token;
        if (token) sanitized = sanitized.split(token).join("[redacted]");
        return sanitized
            .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
            .replace(/([?&](?:token|api[_-]?token|access[_-]?token)=)[^&#\s]+/gi, "$1[redacted]")
            .replace(/("?(?:token|apiToken|accessToken)"?\s*:\s*")[^"]+("?)/gi, "$1[redacted]$2");
    }

    private safeErrorText(error: unknown): string {
        return this.sanitizeSensitiveText(error instanceof Error ? error.message : String(error));
    }

    private formatUiError(error: unknown): string {
        if (!(error instanceof MirrorOperationError)) return this.safeErrorText(error);
        const lines = [
            this.sanitizeSensitiveText(error.message),
            `${this.i18n.mirrorFailureState}: ${error.details.state}`,
            `${this.i18n.mirrorFailureCause}: ${this.sanitizeSensitiveText(error.details.cause)}`,
        ];
        if (error.details.operationId) {
            lines.push(`${this.i18n.mirrorOperationId}: ${this.shortId(error.details.operationId)}`);
        }
        if (error.details.rollbackErrors?.length) {
            lines.push(`${this.i18n.rollbackErrors}: ${error.details.rollbackErrors.map((item) => this.sanitizeSensitiveText(item)).join("; ")}`);
        }
        if (error.details.residualAssetPaths?.length) {
            lines.push(`${this.i18n.residualAssetCleanup}: ${error.details.residualAssetPaths.map((item) => this.sanitizeSensitiveText(item)).join("; ")}`);
        }
        return lines.join(" | ");
    }

    private reportError(prefix: string, error: unknown) {
        console.error(prefix, error);
        showMessage(`${prefix}: ${this.formatUiError(error)}`, -1, "error");
    }

    onunload() {
        this.eventBus.off("switch-protyle", this.handleDocumentSwitch);
        this.eventBus.off("loaded-protyle-dynamic", this.handleDocumentSwitch);
        this.eventBus.off("loaded-protyle-static", this.handleDocumentSwitch);
        this.targetChangeListeners.clear();
        this.pairingStatusListeners.clear();
    }
}
