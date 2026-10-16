<script setup lang="ts">
import { MdEditor, MdPreview, type ToolbarNames } from "md-editor-v3";
import { defineAsyncComponent } from "vue";
const CodeEditor = defineAsyncComponent(() => import("./code-editor.vue"));
import { usePreferences } from "@vben/preferences";
import DOMPurify from "dompurify";
import "md-editor-v3/lib/style.css";
const props = withDefaults(
  defineProps<{ readonly?: boolean; source?: boolean; savable?: boolean }>(),
  { readonly: false, source: false, savable: true },
);
const text = defineModel<string>({ required: true });
const emit = defineEmits<{ save: [] }>();
const { isDark } = usePreferences();
const toolbars: ToolbarNames[] = [
  "bold",
  "italic",
  "title",
  "quote",
  "unorderedList",
  "orderedList",
  "task",
  "codeRow",
  "code",
  "link",
  "table",
  "-",
  "revoke",
  "next",
  "save",
  "=",
  "pageFullscreen",
  "preview",
  "previewOnly",
  "catalog",
];
// Also sanitize generated HTML; never load remote images or execute skill code.
const sanitize = (html: string) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "img",
      "iframe",
      "script",
      "style",
      "object",
      "embed",
      "svg",
      "math",
      "form",
    ],
    FORBID_ATTR: ["style"],
  });
</script>
<template>
  <CodeEditor
    v-if="source"
    v-model="text"
    mode="skill"
    label="SKILL.md 完整源码"
    :height="480"
    :readonly="readonly"
    :savable="savable"
    @save="emit('save')"
  />
  <MdPreview
    v-else-if="readonly"
    :model-value="text"
    :theme="isDark ? 'dark' : 'light'"
    preview-theme="github"
    :sanitize="sanitize"
    no-highlight
    no-mermaid
    no-katex
    no-echarts
    no-img-zoom-in
  />
  <MdEditor
    v-else
    v-model="text"
    :theme="isDark ? 'dark' : 'light'"
    preview-theme="github"
    :sanitize="sanitize"
    :preview="!source"
    :toolbars="
      source
        ? ['revoke', 'next', 'save', '=', 'pageFullscreen']
        : toolbars.filter((t) => savable || t !== 'save')
    "
    :style="{ height: '480px' }"
    no-highlight
    no-mermaid
    no-katex
    no-echarts
    no-img-zoom-in
    no-prettier
    :auto-focus="false"
    @on-save="savable && emit('save')"
  />
</template>
