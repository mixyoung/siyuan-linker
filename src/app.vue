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
      <p v-if="selectedDocuments.length" class="info-item">
        {{ plugin.i18n.selectedNotes }}:
        <span class="info-value">{{ selectedDocuments.map((item) => item.name).join(', ') }}</span>
      </p>
      <button
        v-if="selectedDocuments.length"
        class="action-button"
        :disabled="pulling"
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
      unsubscribeTargetChange: null as null | (() => void),
    };
  },
  computed: {
    selectedIds(): string[] {
      return this.selectedDocuments.map((item) => item.id);
    },
  },
  async mounted() {
    this.unsubscribeTargetChange = this.plugin.onTargetChange(() => {
      this.notebooks = [];
      this.fileTreeData = [];
      this.selectedDocuments = [];
      void this.refresh();
    });
    await this.refresh();
  },
  beforeUnmount() {
    this.unsubscribeTargetChange?.();
  },
  methods: {
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
  cursor: wait;
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

.status.error {
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
  font-size: 14px;
}

.info-value {
  font-weight: 600;
  color: var(--b3-theme-primary);
}
</style>
