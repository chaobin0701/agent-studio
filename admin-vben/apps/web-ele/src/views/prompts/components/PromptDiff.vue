<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { usePreferences } from "@vben/preferences";
import { useMediaQuery } from "@vueuse/core";
import { html, parse } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui-base";
import DOMPurify from "dompurify";
import {
  ElAlert,
  ElButton,
  ElRadioButton,
  ElRadioGroup,
  ElTag,
} from "element-plus";
import "diff2html/bundles/css/diff2html.min.css";
import { createPromptPatch } from "./prompt-diff";
const props = withDefaults(
  defineProps<{
    left: string;
    right: string;
    leftLabel?: string;
    rightLabel?: string;
    fileName?: string;
  }>(),
  { leftLabel: "旧版本", rightLabel: "新版本", fileName: "prompt.txt" },
);
const { isDark } = usePreferences();
const wide = useMediaQuery("(min-width: 768px)");
const root = ref<HTMLElement>(),
  format = ref<"side-by-side" | "line-by-line">(
    wide.value ? "side-by-side" : "line-by-line",
  ),
  expanded = ref(false),
  output = ref(""),
  error = ref(""),
  added = ref(0),
  removed = ref(0);
const same = computed(() => props.left === props.right);
watch(wide, (value) => {
  if (!value) format.value = "line-by-line";
});
let generation = 0,
  timer: ReturnType<typeof setTimeout>;
watch(
  () => [
    props.left,
    props.right,
    props.fileName,
    format.value,
    expanded.value,
    isDark.value,
  ],
  () => {
    clearTimeout(timer);
    const request = ++generation;
    timer = setTimeout(async () => {
      error.value = "";
      output.value = "";
      added.value = removed.value = 0;
      if (props.left.length + props.right.length > 200000) {
        error.value = "内容过大，请缩小比较范围。";
        return;
      }
      try {
        const patch = createPromptPatch(
          props.left,
          props.right,
          expanded.value,
          props.fileName,
        );
        if (patch === undefined)
          throw new Error("差异计算超时，请缩小比较范围。");
        const parsed = parse(patch);
        if (
          parsed.reduce(
            (n, file) =>
              n +
              file.blocks.reduce(
                (count, block) => count + block.lines.length,
                0,
              ),
            0,
          ) > 6000
        )
          throw new Error(
            "差异展示超过 6000 行，请缩小比较范围；完整原文仍可在内容页查看。",
          );
        added.value = parsed.reduce((n, file) => n + file.addedLines, 0);
        removed.value = parsed.reduce((n, file) => n + file.deletedLines, 0);
        output.value = DOMPurify.sanitize(
          html(parsed, {
            drawFileList: false,
            outputFormat: format.value,
            matching: "lines",
            maxLineLengthHighlight: 2000,
            matchingMaxComparisons: 1000,
            colorScheme: isDark.value
              ? ColorSchemeType.DARK
              : ColorSchemeType.LIGHT,
          }),
        );
        await nextTick();
        if (request === generation && root.value)
          new Diff2HtmlUI(root.value, undefined, {
            highlight: false,
          }).synchronisedScroll();
      } catch (e) {
        error.value = e instanceof Error ? e.message : "差异计算失败";
      }
    }, 100);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++generation;
  clearTimeout(timer);
});
</script>
<template>
  <div class="prompt-diff space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <span>{{ leftLabel }} → {{ rightLabel }}</span
      ><ElTag type="success">+{{ added }} 行</ElTag
      ><ElTag type="danger">−{{ removed }} 行</ElTag>
      <ElRadioGroup v-model="format" size="small" class="ml-auto"
        ><ElRadioButton value="side-by-side">左右对比</ElRadioButton
        ><ElRadioButton value="line-by-line"
          >统一视图</ElRadioButton
        ></ElRadioGroup
      >
      <ElButton v-if="!same" size="small" @click="expanded = !expanded">{{
        expanded ? "收起未修改内容" : "展开全部内容"
      }}</ElButton>
    </div>
    <ElAlert v-if="error" :title="error" type="warning" :closable="false" />
    <ElAlert
      v-else-if="same"
      :title="left ? '没有差异，已展示全部内容' : '没有差异，两个版本均为空'"
      type="info"
      :closable="false"
    />
    <div
      v-if="!error && (left || right)"
      ref="root"
      class="max-h-[60vh] overflow-auto"
      aria-label="版本差异"
      v-html="output"
    />
  </div>
</template>
