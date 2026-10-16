<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePreferences } from "@vben/preferences";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
const props = defineProps<{
  readonly: boolean;
  height: number;
  label: string;
  allowEmpty: boolean;
}>();
const text = defineModel<string>({ required: true });
const emit = defineEmits<{ format: [] }>();
const container = ref<HTMLElement>();
const { isDark } = usePreferences();
const access = new Compartment(),
  appearance = new Compartment();
let editor: EditorView | undefined;
let syncing = false;
const accessExtensions = () => [
  EditorState.readOnly.of(props.readonly),
  EditorView.editable.of(!props.readonly),
];
function theme() {
  return EditorView.theme(
    {
      "&": {
        height: `${props.height}px`,
        backgroundColor: "var(--el-bg-color)",
        color: "var(--el-text-color-primary)",
      },
      "&.cm-focused": { outline: "1px solid var(--el-color-primary)" },
      ".cm-scroller": {
        overflow: "auto",
        fontFamily:
          "var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
        fontSize: "13px",
        lineHeight: "1.7",
      },
      ".cm-content": {
        padding: "8px 0",
        caretColor: "var(--el-color-primary)",
      },
      ".cm-line": { padding: "0 12px" },
      ".cm-gutters": {
        backgroundColor: "var(--el-fill-color-light)",
        color: "var(--el-text-color-secondary)",
        borderRightColor: "var(--el-border-color-light)",
      },
      ".cm-activeLine, .cm-activeLineGutter": {
        backgroundColor: "var(--el-fill-color-lighter)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "var(--el-color-primary-light-8)" },
      ".cm-cursor": { borderLeftColor: "var(--el-color-primary)" },
      ".cm-tooltip, .cm-panels": {
        backgroundColor: "var(--el-bg-color-overlay)",
        color: "var(--el-text-color-primary)",
        borderColor: "var(--el-border-color)",
      },
    },
    { dark: isDark.value },
  );
}
onMounted(() => {
  editor = new EditorView({
    parent: container.value!,
    doc: text.value,
    extensions: [
      basicSetup,
      json(),
      indentUnit.of("  "),
      EditorView.lineWrapping,
      syntaxHighlighting(
        HighlightStyle.define([
          { tag: tags.propertyName, color: "var(--el-color-primary)" },
          { tag: tags.string, color: "var(--el-color-success)" },
          {
            tag: [tags.number, tags.bool, tags.null],
            color: "var(--el-color-warning)",
          },
        ]),
      ),
      access.of(accessExtensions()),
      appearance.of(theme()),
      EditorView.contentAttributes.of({
        "aria-label": props.label,
        "aria-multiline": "true",
        spellcheck: "false",
        tabindex: "0",
      }),
      keymap.of([
        {
          key: "Mod-Shift-f",
          run: () => {
            if (!props.readonly) emit("format");
            return true;
          },
        },
        indentWithTab,
      ]),
      lintGutter(),
      linter(
        (view) =>
          props.allowEmpty && !view.state.doc.toString().trim()
            ? []
            : jsonParseLinter()(view),
        { delay: 150 },
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !syncing)
          text.value = update.state.doc.toString();
      }),
    ],
  });
});
watch(text, (value) => {
  if (!editor || value === editor.state.doc.toString()) return;
  syncing = true;
  try {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value },
    });
  } finally {
    syncing = false;
  }
});
watch(
  () => props.readonly,
  () => editor?.dispatch({ effects: access.reconfigure(accessExtensions()) }),
);
watch([isDark, () => props.height], () =>
  editor?.dispatch({ effects: appearance.reconfigure(theme()) }),
);
onBeforeUnmount(() => {
  editor?.destroy();
  editor = undefined;
});
</script>
<template><div ref="container" /></template>
