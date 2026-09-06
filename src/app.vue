<template>
  <div class="remote-notes">
    <div class="header-container">
      <h1 class="title">{{ plugin.i18n.remoteNotes }}</h1>
      <select
        v-model="selectedNotebookId"
        class="select-box"
        :aria-label="plugin.i18n.notebook"
        @change="loadRoot"
      >
        <option v-for="option in notebooks" :key="option.id" :value="option.id">
          {{ option.name }}
        </option>
      </select>
      <button class="action-button refresh-button" :disabled="loading" @click="refresh">
        {{ plugin.i18n.refresh }}
      </button>
    </div>

    <p v-if="loading" class="status">{{ plugin.i18n.loading }}</p>
    <p v-else-if="error" class="status error">{{ error }}</p>
    <p v-else-if="!notebooks.length" class="status">{{ plugin.i18n.noNotebooks }}</p>

    <div v-else class="tree-container">
      <FileTree
        :items="fileTreeData"
        :selected-ids="selectedIds"
        :i18n="plugin.i18n"
        @toggle-expand="toggleExpand"
        @toggle-select="toggleSelect"
      />
    </div>

    <div class="info-container">
      <p class="info-item">
        {{ plugin.i18n.targetService }}:
        <span class="info-value">{{ plugin.getSelectedTargetLabel() }}</span>
      </p>
      <p class="info-item">
        {{ plugin.i18n.transferMode }}:
        <span class="info-value">{{ transferModeLabel }}</span>
      </p>
      <p class="info-item">
        {{ plugin.i18n.pairingStatus }}:
        <span :class="['info-value', { 'pairing-invalid': !pairingUsable }]">{{ pairingStatusLabel }}</span>
      </p>
      <p v-if="pairingDetail" class="pairing-detail">{{ pairingDetail }}</p>
      <p v-if="exactMode && !pairingUsable" class="status error pairing-required">
        {{ plugin.i18n.dockPairingRequired }}
      </p>
      <p v-if="selectedDocuments.length" class="info-item">
        {{ plugin.i18n.selectedNotes }}:
        <span class="info-value">{{ selectedDocuments.map((item) => item.name).join(', ') }}</span>
      </p>
      <button
        v-if="selectedDocuments.length"
        class="action-button"
        :disabled="!canPull"
        @click="pullSelected"
      >
        {{ pulling ? plugin.i18n.pulling : plugin.i18n.pullNotes }}
      </button>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import FileTree from "./MyVue/FileTree.vue";
import { listDocuments, listNotebooks, type FileTreeNode, type NotebookOption } from "./FileTreeApi";
import type SiYuanLinker from "./index";
import type { MirrorPairStatus } from "./mirror-types";

export default defineComponent({
  name: "App",
  components: { FileTree },
  props: {
    plugin: {
      type: Object as PropType<SiYuanLinker>,
      required: true,
    },
  },
  data() {
    return {
      notebooks: [] as NotebookOption[],
      selectedNotebookId: "",
      fileTreeData: [] as FileTreeNode[],
      selectedDocuments: [] as FileTreeNode[],
      loading: false,
      pulling: false,
      error: "",
      pairingStatus: this.plugin.getPairingStatus() as MirrorPairStatus,
      transferMode: this.plugin.getCurrentTransferMode(),
      unsubscribeTargetChange: null as null | (() => void),
      unsubscribePairingStatus: null as null | (() => void),
    };
  },
  computed: {
    selectedIds(): string[] {
      return this.selectedDocuments.map((item) => item.id);
    },
    exactMode(): boolean {
      return this.transferMode === "preserve-ids";
    },
    transferModeLabel(): string {
      return this.exactMode ? this.plugin.i18n.exactIdMirror : this.plugin.i18n.independentCopy;
    },
    pairingUsable(): boolean {
      return this.pairingStatus.state === "ready" && this.pairingStatus.valid && !this.pairingStatus.pending;
    },
    pairingStatusLabel(): string {
      if (this.pairingStatus.state === "loading") return this.plugin.i18n.pairingStateLoading;
      if (this.pairingStatus.state === "unknown") return this.plugin.i18n.pairingStateUnknown;
      if (this.pairingStatus.pending) return this.plugin.i18n.pairingStatePending;
      if (this.pairingStatus.valid) return this.plugin.i18n.pairingStateValid;
      if (this.pairingStatus.sourceRecord || this.pairingStatus.destinationRecord) {
        return this.plugin.i18n.pairingStateMismatch;
      }
      return this.plugin.i18n.pairingStateNotPaired;
    },
    pairingDetail(): string {
      const pairId = this.pairingStatus.sourceRecord?.pairId ?? this.pairingStatus.destinationRecord?.pairId;
      const details = [
        pairId ? `${this.plugin.i18n.pairId} ${this.shortId(pairId)}` : "",
        `${this.plugin.i18n.allowedNotebooks} ${this.pairingStatus.allowedNotebookIds.length}`,
      ].filter(Boolean);
      if (this.pairingStatus.reasons.length) {
        details.push(this.pairingStatus.reasons.join("; "));
      }
      return details.join(" · ");
    },
    canPull(): boolean {
      return !this.pulling && (!this.exactMode || this.pairingUsable);
    },
  },
  async mounted() {
    this.unsubscribeTargetChange = this.plugin.onTargetChange(() => {
      this.notebooks = [];
      this.fileTreeData = [];
      this.selectedDocuments = [];
      void this.refresh();
    });
    this.unsubscribePairingStatus = this.plugin.onPairingStatusChange((status) => {
      this.pairingStatus = status;
      this.transferMode = this.plugin.getCurrentTransferMode();
    });
    await this.refresh();
  },
  beforeUnmount() {
    this.unsubscribeTargetChange?.();
    this.unsubscribePairingStatus?.();
  },
  methods: {
    shortId(value: string): string {
      return value.length > 8 ? `${value.slice(0, 8)}…` : value;
    },
    async refresh() {
      this.loading = true;
      this.error = "";
      this.selectedDocuments = [];
      try {
        const target = this.plugin.getTargetConnection();
        this.notebooks = await listNotebooks(target);
        if (!this.notebooks.some((item) => item.id === this.selectedNotebookId)) {
          this.selectedNotebookId = this.notebooks[0]?.id ?? "";
        }
        await this.loadRoot();
      } catch (error) {
        console.error("Failed to refresh remote notes:", error);
        this.fileTreeData = [];
        this.error = this.plugin.i18n.loadRemoteNotesFailed;
      } finally {
        this.loading = false;
      }
    },
    async loadRoot() {
      this.selectedDocuments = [];
      if (!this.selectedNotebookId) {
        this.fileTreeData = [];
        return;
      }
      this.loading = true;
      this.error = "";
      try {
        this.fileTreeData = await listDocuments(
          this.plugin.getTargetConnection(),
          this.selectedNotebookId,
        );
      } catch (error) {
        console.error("Failed to load remote document tree:", error);
        this.fileTreeData = [];
        this.error = this.plugin.i18n.loadRemoteNotesFailed;
      } finally {
        this.loading = false;
      }
    },
    async toggleExpand(item: FileTreeNode) {
      if (!item.hasChildren || item.loading) return;
      if (item.expanded) {
        item.expanded = false;
        return;
      }
      if (!item.loaded) {
        item.loading = true;
        try {
          item.children = await listDocuments(
            this.plugin.getTargetConnection(),
            item.box,
            item.path,
          );
          item.loaded = true;
        } catch (error) {
          console.error("Failed to load child documents:", error);
          this.error = this.plugin.i18n.loadRemoteNotesFailed;
          return;
        } finally {
          item.loading = false;
        }
      }
      item.expanded = true;
    },
    toggleSelect(item: FileTreeNode) {
      const index = this.selectedDocuments.findIndex((selected) => selected.id === item.id);
      if (index === -1) {
        this.selectedDocuments.push(item);
      } else {
        this.selectedDocuments.splice(index, 1);
      }
    },
    async pullSelected() {
      if (!this.canPull) return;
      this.pulling = true;
      try {
        await this.plugin.pullNote(this.selectedDocuments.map((item) => item.id));
      } finally {
        this.pulling = false;
      }
    },
  },
});
</script>

<style scoped>
.remote-notes {
  padding: 10px;
  color: var(--b3-theme-on-background);
  font-family: Avenir, Helvetica, Arial, sans-serif;
}

.header-container {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title {
  margin: 0 4px 12px 0;
  font-size: 20px;
}

.select-box {
  min-width: 0;
  margin-bottom: 12px;
  padding: 3px 5px;
  border: 1px solid var(--b3-border-color);
  border-radius: 4px;
  background: var(--b3-theme-surface);
  color: var(--b3-theme-on-background);
}

.action-button {
  padding: 4px 10px;
  border: 1px solid var(--b3-border-color);
  border-radius: 5px;
  background: transparent;
  color: var(--b3-theme-on-background);
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background-color: var(--b3-list-hover);
}

.action-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.refresh-button {
  margin: 0 0 12px auto;
}

.tree-container {
  margin-left: -14px;
  overflow: hidden;
}

.status {
  padding: 12px 4px;
  color: var(--b3-theme-on-surface);
}

.status.error,
.pairing-invalid {
  color: var(--b3-card-error-color);
}

.info-container {
  margin-top: 20px;
  padding: 15px;
  border-radius: 8px;
  background-color: var(--b3-theme-surface);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.info-item {
  margin: 6px 0;
  font-size: 14px;
}

.info-value {
  font-weight: 600;
  color: var(--b3-theme-primary);
}

.pairing-detail {
  margin: 4px 0 8px;
  color: var(--b3-theme-on-surface);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.pairing-required {
  margin: 6px 0;
  padding: 8px 0;
}
</style>
