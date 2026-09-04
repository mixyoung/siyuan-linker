<template>
  <ul class="file-tree">
    <li v-for="item in items" :key="item.id">
      <div :class="['tree-item', { selected: selectedIds.includes(item.id) }]">
        <button
          class="expand-button"
          :class="{ hidden: !item.hasChildren }"
          :title="item.expanded ? i18n.collapse : i18n.expand"
          @click.stop="$emit('toggle-expand', item)"
        >
          {{ item.loading ? '…' : (item.expanded ? '▾' : '▸') }}
        </button>
        <span class="document-icon" aria-hidden="true">▤</span>
        <button class="document-name" @click.stop="$emit('toggle-select', item)">
          {{ item.name }}
        </button>
      </div>
      <FileTree
        v-if="item.expanded && item.children.length"
        :items="item.children"
        :selected-ids="selectedIds"
        :i18n="i18n"
        @toggle-expand="$emit('toggle-expand', $event)"
        @toggle-select="$emit('toggle-select', $event)"
      />
    </li>
  </ul>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import type { FileTreeNode } from "../FileTreeApi";

export default defineComponent({
  name: "FileTree",
  props: {
    items: {
      type: Array as PropType<FileTreeNode[]>,
      required: true,
    },
    selectedIds: {
      type: Array as PropType<string[]>,
      required: true,
    },
    i18n: {
      type: Object as PropType<Record<string, string>>,
      required: true,
    },
  },
  emits: ["toggle-expand", "toggle-select"],
});
</script>

<style scoped>
.file-tree {
  list-style: none;
  margin: 0;
  padding-left: 14px;
  color: var(--b3-theme-on-background);
}

.tree-item {
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 2px 4px;
  border-radius: 5px;
}

.tree-item:hover,
.tree-item.selected {
  background-color: var(--b3-list-hover);
}

.expand-button,
.document-name {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.expand-button {
  width: 24px;
  padding: 2px;
  flex: 0 0 24px;
}

.expand-button.hidden {
  visibility: hidden;
}

.document-icon {
  margin-right: 5px;
  color: var(--b3-theme-primary);
}

.document-name {
  min-width: 0;
  padding: 4px 2px;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
