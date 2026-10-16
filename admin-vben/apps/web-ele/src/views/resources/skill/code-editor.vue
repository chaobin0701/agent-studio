<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePreferences } from "@vben/preferences";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import {
  autocompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter, linter } from "@codemirror/lint";
import { yaml, yamlFrontmatter } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { tags } from "@lezer/highlight";
import {
  frontmatterDiagnostics,
  frontmatterSection,
  skillYamlFields,
  type SkillEditorMode,
} from "./frontmatter";

const props = withDefaults(
  defineProps<{
    mode?: SkillEditorMode;
    readonly?: boolean;
    savable?: boolean;
    height?: number;
    label?: string;
  }>(),
  {
    mode: "yaml",
    readonly: false,
    savable: true,
    height: 230,
    label: "Skill YAML 代码编辑器",
  },
);
const text = defineModel<string>({ required: true });
const emit = defineEmits<{ save: [] }>();
const container = ref<HTMLElement>(),
  { isDark } = usePreferences();
const access = new Compartment(),
  appearance = new Compartment();
let editor: EditorView | undefined;
let syncing = false;
const accessExtensions = () => [
  EditorState.readOnly.of(props.readonly),
  EditorView.editable.of(!props.readonly),
];
const colors = syntaxHighlighting(
  HighlightStyle.define([
    {
      tag: [tags.propertyName, tags.attributeName],
      color: "var(--el-color-primary)",
    },
    { tag: [tags.string, tags.content], color: "var(--el-color-success)" },
    {
      tag: [tags.number, tags.bool, tags.null],
      color: "var(--el-color-warning)",
    },
    {
      tag: tags.comment,
      color: "var(--el-text-color-secondary)",
      fontStyle: "italic",
    },
    { tag: [tags.keyword, tags.meta], color: "var(--el-color-danger)" },
    {
      tag: [tags.heading, tags.strong],
      color: "var(--el-color-primary)",
      fontWeight: "bold",
    },
    { tag: tags.emphasis, fontStyle: "italic" },
  ]),
);
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
        padding: "10px 0",
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
      ".cm-tooltip-autocomplete ul li[aria-selected]": {
        backgroundColor: "var(--el-color-primary-light-9)",
        color: "var(--el-color-primary)",
      },
      ".skill-field-help": {
        maxWidth: "360px",
        padding: "8px 12px",
        fontFamily: "var(--font-family, sans-serif)",
      },
    },
    { dark: isDark.value },
  );
}
function complete(context: CompletionContext) {
  if (props.readonly) return null;
  const section = frontmatterSection(context.state.doc.toString(), props.mode);
  if (
    !section ||
    context.pos < section.offset ||
    context.pos > section.offset + section.yaml.length
  )
    return null;
  const line = context.state.doc.lineAt(context.pos);
  const prefix = line.text.slice(0, context.pos - line.from);
  if (!/^[a-z-]*$/.test(prefix) || (!prefix && !context.explicit)) return null;
  return {
    from: line.from,
    options: skillYamlFields.map((f) => ({
      ...f,
      type: "property",
      apply: `${f.label}: `,
    })),
    validFor: /^[a-z-]*$/,
  };
}
const help = hoverTooltip((view, pos) => {
  const section = frontmatterSection(view.state.doc.toString(), props.mode);
  if (
    !section ||
    pos < section.offset ||
    pos > section.offset + section.yaml.length
  )
    return null;
  const line = view.state.doc.lineAt(pos),
    match = /^([a-z-]+)\s*:/.exec(line.text);
  const field = match && skillYamlFields.find((f) => f.label === match[1]);
  if (!match || !field || pos > line.from + field.label.length) return null;
  return {
    pos: line.from,
    end: line.from + field.label.length,
    above: true,
    create() {
      const dom = document.createElement("div");
      dom.className = "skill-field-help";
      dom.textContent = field.detail;
      return { dom };
    },
  };
});
onMounted(() => {
  editor = new EditorView({
    parent: container.value!,
    doc: text.value,
    extensions: [
      basicSetup,
      props.mode === "yaml" ? yaml() : yamlFrontmatter({ content: markdown() }),
      colors,
      indentUnit.of("  "),
      EditorView.lineWrapping,
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
          key: "Mod-s",
          run: () => {
            if (!props.readonly && props.savable) emit("save");
            return true;
          },
        },
        indentWithTab,
      ]),
      autocompletion({ override: [complete] }),
      help,
      lintGutter(),
      linter(
        (view) => frontmatterDiagnostics(view.state.doc.toString(), props.mode),
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
<template>
  <div class="skill-code-editor w-full min-w-0 overflow-hidden rounded border">
    <div ref="container" />
    <div
      class="editor-status flex items-center justify-between border-t px-3 py-1 text-xs"
    >
      <span
        >{{ mode === "yaml" ? "YAML" : "SKILL.md · YAML + Markdown" }} · 2
        空格缩进</span
      >
      <span>{{
        readonly
          ? "只读，可选择复制"
          : savable
            ? "Ctrl / ⌘ + S 保存"
            : "编辑后点击创建"
      }}</span>
    </div>
  </div>
</template>
<style scoped>
.skill-code-editor {
  border-color: var(--el-border-color);
}
.editor-status {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  border-color: var(--el-border-color);
}
</style>
