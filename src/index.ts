import { createApp } from "vue";
import {
    Plugin,
    showMessage,
    Menu,
} from "siyuan";
import App from "./app.vue";
import "@/index.scss";
import {
    downloadFile,
    exportAllData,
    getDocumentLocation,
    getNotebookName,
    getNoteData,
    getResourceLinks,
    importAllData,
    isconnect,
    markTransferredReadonly,
    putBinaryFile,
    putTextFile,
    refreshFileTree,
    setNotebookConf,
    transferDatabaseResources,
    type TargetConnection,
} from "@/myapi";
import { SettingUtils } from "./libs/setting-utils";

const STORAGE_NAME = "menu-config";
const REMOTE_NOTES_DOCK_TYPE = "siyuan-linker-remote-notes";

type TargetNumber = "1" | "2";

export default class SiYuanLinker extends Plugin {
    private settingUtils!: SettingUtils;
    private currentDocId: string | null = null;
    private selectedTarget: TargetNumber = "1";
    private targetConnection: TargetConnection = { url: "", token: "" };
    private targetChangeListeners = new Set<() => void>();

    async onload() {
        this.addIcons(`<symbol id="iconTransfer" viewBox="0 0 32 32">
<path d="M27.414 19.414l-4-4c-0.781-0.781-2.047-0.781-2.828 0s-0.781 2.047 0 2.828l1.586 1.586h-12.172c-1.105 0-2 0.895-2 2s0.895 2 2 2h12.172l-1.586 1.586c-0.781 0.781-0.781 2.047 0 2.828 0.39 0.39 0.902 0.586 1.414 0.586s1.024-0.195 1.414-0.586l4-4c0.781-0.781 0.781-2.047 0-2.828zM10.586 10.586l-4 4c-0.781 0.781-0.781 2.047 0 2.828 0.39 0.39 0.902 0.586 1.414 0.586s1.024-0.195 1.414-0.586l1.586-1.586h12.172c1.105 0 2-0.895 2-2s-0.895-2-2-2h-12.172l1.586-1.586c0.781-0.781 0.781-2.047 0-2.828s-2.047-0.781-2.828 0l-4 4c-0.781 0.781-0.781 2.047 0 2.828z"></path>
</symbol>
<symbol id="iconSaving" viewBox="0 0 32 32">
<path d="M28 22h-24c-1.105 0-2-0.895-2-2v-12c0-1.105 0.895-2 2-2h24c1.105 0 2 0.895 2 2v12c0 1.105-0.895 2-2 2zM4 8v12h24v-12h-24zM16 18l-6-6h4v-4h4v4h4l-6 6zM26 24h-20c-1.105 0-2-0.895-2-2v-2h24v2c0 1.105-0.895 2-2 2z"></path>
</symbol>`);

        this.addTopBar({
            icon: "iconTransfer",
            title: this.i18n.dataTransfer,
            position: "right",
            callback: () => {
                const anchor = document.querySelector("#barPlugins")?.getBoundingClientRect();
                this.openTransferMenu(anchor);
            },
        });

        let remoteNotesApp: ReturnType<typeof createApp> | null = null;
        this.addDock({
            config: {
                position: "RightTop",
                size: { width: 300, height: 0 },
                icon: "iconSaving",
                title: this.i18n.remoteNotes,
            },
            data: null,
            type: REMOTE_NOTES_DOCK_TYPE,
            init: (dock) => {
                const mountPoint = document.createElement("div");
                mountPoint.className = "siyuan-linker-remote-notes-dock";
                mountPoint.style.height = "100%";
                mountPoint.style.width = "100%";
                dock.element.appendChild(mountPoint);
                remoteNotesApp = createApp(App, { plugin: this });
                remoteNotesApp.mount(mountPoint);
            },
            destroy: () => {
                remoteNotesApp?.unmount();
                remoteNotesApp = null;
            },
        });

        this.setupSettings();
        await this.settingUtils.load();
        this.selectedTarget = String(this.settingUtils.get("Select") ?? "1") as TargetNumber;
        this.syncTargetConnection();

        this.eventBus.on("switch-protyle", this.handleDocumentSwitch);
        this.eventBus.on("loaded-protyle-dynamic", this.handleDocumentSwitch);
        this.eventBus.on("loaded-protyle-static", this.handleDocumentSwitch);
    }

    private setupSettings() {
        this.settingUtils = new SettingUtils({ plugin: this, name: STORAGE_NAME });

        this.addTextSetting("sykey", this.i18n.targetToken1, this.i18n.targetToken1Description, "1");
        this.addTextSetting("syurl", this.i18n.targetUrl1, this.i18n.targetUrl1Description, "1");
        this.addTextSetting("sykey2", this.i18n.targetToken2, this.i18n.targetToken2Description, "2");
        this.addTextSetting("syurl2", this.i18n.targetUrl2, this.i18n.targetUrl2Description, "2");

        this.settingUtils.addItem({
            key: "Select",
            value: "1",
            type: "select",
            title: this.i18n.targetSource,
            description: this.i18n.targetSourceDescription,
            options: {
                1: this.i18n.target1,
                2: this.i18n.target2,
            },
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
            button: {
                label: this.i18n.validate,
                callback: () => void this.validateConnection(),
            },
        });

        this.settingUtils.addItem({
            key: "push",
            value: "",
            type: "button",
            title: this.i18n.transferAll,
            description: this.i18n.transferAllDescription,
            button: {
                label: this.i18n.transfer,
                callback: () => void this.runPush(),
            },
        });

        this.settingUtils.addItem({
            key: "pull",
            value: "",
            type: "button",
            title: this.i18n.pullAll,
            description: this.i18n.pullAllDescription,
            button: {
                label: this.i18n.pull,
                callback: () => void this.runPull(),
            },
        });

        this.addCheckboxSetting("islog", true, this.i18n.enableLogging, this.i18n.enableLoggingDescription);
        this.addCheckboxSetting("readonlyText", false, this.i18n.markReadonly, this.i18n.markReadonlyDescription);
        this.addCheckboxSetting("isrefresh", true, this.i18n.refreshAfterPull, this.i18n.refreshAfterPullDescription);
    }

    private addTextSetting(
        key: string,
        title: string,
        description: string,
        targetNumber: TargetNumber,
    ) {
        this.settingUtils.addItem({
            key,
            value: "",
            type: "textinput",
            title,
            description,
            action: {
                callback: async () => {
                    await this.settingUtils.takeAndSave(key);
                    if (this.selectedTarget === targetNumber) {
                        this.syncTargetConnection();
                    }
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
            action: {
                callback: async () => {
                    await this.settingUtils.takeAndSave(key);
                },
            },
        });
    }

    private syncTargetConnection() {
        const suffix = this.selectedTarget === "1" ? "" : "2";
        const rawUrl = String(this.settingUtils.get(`syurl${suffix}`) ?? "").trim();
        this.targetConnection = {
            url: rawUrl.replace(/\/+$/, ""),
            token: String(this.settingUtils.get(`sykey${suffix}`) ?? "").trim(),
        };
        for (const listener of this.targetChangeListeners) {
            listener();
        }
    }

    public onTargetChange(listener: () => void): () => void {
        this.targetChangeListeners.add(listener);
        return () => this.targetChangeListeners.delete(listener);
    }

    public getTargetConnection(): TargetConnection {
        if (!this.targetConnection.url) {
            throw new Error(this.i18n.configureTargetFirst);
        }
        return { ...this.targetConnection };
    }

    public getSelectedTargetLabel(): string {
        return this.selectedTarget === "1" ? this.i18n.target1 : this.i18n.target2;
    }

    private readonly handleDocumentSwitch = (event: CustomEvent) => {
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
            icon: "iconTransfer",
            label: this.i18n.transferCurrentNote,
            click: () => void this.runSingleTransfer(),
        });
        menu.open({
            x: rect?.right ?? 0,
            y: rect?.bottom ?? 0,
            isLeft: true,
        });
    }

    private async validateConnection() {
        let target: TargetConnection;
        try {
            target = this.getTargetConnection();
        } catch {
            showMessage(this.i18n.configureTargetFirst, 6000, "error");
            return;
        }
        showMessage(this.i18n.validating, 3000, "info");
        const connected = await isconnect(target);
        showMessage(
            connected ? this.i18n.connectionSucceeded : this.i18n.connectionFailed,
            6000,
            connected ? "info" : "error",
        );
    }

    private async runSingleTransfer() {
        const docId = this.currentDocId;
        if (!docId) {
            showMessage(this.i18n.noCurrentDocument, 6000, "error");
            return;
        }

        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.singleTransfer);
            const location = await getDocumentLocation(docId);
            const noteContent = await getNoteData(location.path);
            const outputContent = this.settingUtils.get("readonlyText")
                ? markTransferredReadonly(noteContent)
                : noteContent;

            await putTextFile(location.path, outputContent, target);
            await transferDatabaseResources(noteContent, undefined, target);
            await setNotebookConf(location.notebookId, await getNotebookName(location.notebookId), target);

            const resources = await getResourceLinks(docId);
            for (const resourcePath of resources) {
                await putBinaryFile(resourcePath, await downloadFile(resourcePath), target);
            }
            await refreshFileTree(target);
            showMessage(this.i18n.transferCompleted, 6000, "info", this.i18n.singleTransfer);
        } catch (error) {
            this.reportError(this.i18n.transferFailed, error);
        }
    }

    public async pullNote(docIds: string[]) {
        if (!docIds.length) return;
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.multipleTransfer);
            for (const docId of docIds) {
                const location = await getDocumentLocation(docId, target);
                const noteContent = await getNoteData(location.path, target);
                const outputContent = this.settingUtils.get("readonlyText")
                    ? markTransferredReadonly(noteContent)
                    : noteContent;

                await putTextFile(location.path, outputContent);
                await transferDatabaseResources(noteContent, target, undefined);
                await setNotebookConf(
                    location.notebookId,
                    await getNotebookName(location.notebookId, target),
                );

                const resources = await getResourceLinks(docId, target);
                for (const resourcePath of resources) {
                    await putBinaryFile(resourcePath, await downloadFile(resourcePath, target));
                }
            }
            if (this.settingUtils.get("isrefresh")) {
                await refreshFileTree();
            }
            showMessage(
                this.i18n.notesPulled.replace("${count}", String(docIds.length)),
                6000,
                "info",
                this.i18n.multipleTransfer,
            );
        } catch (error) {
            this.reportError(this.i18n.pullFailed, error);
        }
    }

    private async runPush() {
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.transferring, -1, "info", this.i18n.transferAll);
            const archivePath = await exportAllData();
            await importAllData(await downloadFile(archivePath), target);
            showMessage(this.i18n.transferCompleted, 6000, "info", this.i18n.transferAll);
        } catch (error) {
            this.reportError(this.i18n.transferFailed, error);
        }
    }

    private async runPull() {
        try {
            const target = this.getTargetConnection();
            showMessage(this.i18n.pulling, -1, "info", this.i18n.pullAll);
            const archivePath = await exportAllData(target);
            await importAllData(await downloadFile(archivePath, target));
            showMessage(this.i18n.pullCompleted, 6000, "info", this.i18n.pullAll);
        } catch (error) {
            this.reportError(this.i18n.pullFailed, error);
        }
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
