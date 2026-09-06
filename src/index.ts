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
import {
    ADOPT_FULL_CLONE_CONFIRMATION,
    adoptFullCloneDestination,
    inspectMirrorPair,
    pairMirrorWorkspaces,
    resetMirrorPeer,
} from "./mirror-storage";
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
        if (this.pairingActionInProgress || !window.confirm(this.i18n.adoptFullCloneConfirm)) return;
        const typed = window.prompt(this.i18n.adoptFullClonePrompt);
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
        if (current.pending) {
            showMessage(this.i18n.pendingRecoveryRequired, -1, "error");
            return;
        }
        if (!window.confirm(this.i18n.resetPairingConfirm)) return;
        this.setPairingActionsBusy(true);
        try {
            const target = this.getTargetConnection();
            await resetMirrorPeer(undefined, target);
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

    private formatPairingStatus(status: MirrorPairStatus): string {
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
        ].join("\n");
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

    private confirmSelectiveTransferScope(): boolean {
        if (this.getCurrentTransferMode() === "preserve-ids") {
            return window.confirm(
                `${this.i18n.exactMirrorTransferWarning}\n\n${this.formatPairingStatus(this.pairingStatus)}`,
            );
        }
        return window.confirm(this.i18n.independentCopyTransferWarning);
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
            await this.refreshPairingStatus();
        } catch (error) {
            this.reportError(this.i18n.connectionFailed, error);
        }
    }

    private async runSingleTransfer() {
        if (!this.currentDocId) {
            showMessage(this.i18n.noCurrentDocument, 6000, "error");
            return;
        }
        if (!await this.ensureExactModeReady() || !this.confirmSelectiveTransferScope()) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.singleTransfer);
            const result = await transferDocuments([this.currentDocId], this.getCurrentTransferMode(), undefined, target);
            this.showTransferResult(this.i18n.transferCompleted, result.warnings, this.i18n.singleTransfer);
        } catch (error) {
            this.reportError(this.i18n.transferFailed, error);
        } finally {
            await this.refreshPairingStatus();
        }
    }

    public async pullNote(docIds: string[]) {
        if (!docIds.length || !await this.ensureExactModeReady() || !this.confirmSelectiveTransferScope()) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.multipleTransfer);
            const result = await transferDocuments(docIds, this.getCurrentTransferMode(), target, undefined);
            this.showTransferResult(
                this.i18n.notesPulled.replace("${count}", String(result.count)),
                result.warnings,
                this.i18n.multipleTransfer,
            );
        } catch (error) {
            this.reportError(this.i18n.pullFailed, error);
        } finally {
            await this.refreshPairingStatus();
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
        } finally {
            await this.refreshPairingStatus();
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
