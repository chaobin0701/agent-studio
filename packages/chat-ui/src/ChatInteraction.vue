<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInput } from "element-plus";
import type { ChatInteraction, ChatInteractionResponse } from "./types";

const props = defineProps<{
  interaction: ChatInteraction;
  disabled?: boolean;
  submitting?: boolean;
  error?: string;
}>();
const emit = defineEmits<{
  respond: [response: ChatInteractionResponse];
  cancel: [];
}>();
const selected = ref("");
const text = ref("");
const pending = computed(() => props.interaction.status === "pending");
const blocked = computed(
  () => props.disabled || props.submitting || !pending.value,
);
const selectedOption = computed(() => props.interaction.options?.find(option => option.id === selected.value));
const responseText = computed(() => text.value.trim() ? [selectedOption.value?.label, text.value.trim()].filter(Boolean).join("\n补充：") : "");
const canSubmit = computed(() => !blocked.value && (!!selected.value || !!responseText.value) && responseText.value.length <= 4000);
const status = computed(
  () =>
    ({
      pending: props.interaction.kind === "approval" ? "等待确认" : "等待回答",
      answered: "已回答",
      skipped: "已跳过",
      approved: "已批准",
      rejected: "已拒绝",
      expired: "已过期",
      cancelled: "已取消",
    })[props.interaction.status],
);
const answer = computed(
  () =>
    props.interaction.answer?.text ??
    props.interaction.options?.find(
      (option) => option.id === props.interaction.answer?.optionId,
    )?.label,
);
watch(
  () => props.interaction.id,
  () => {
    selected.value = "";
    text.value = "";
  },
);
function question() {
  if (!canSubmit.value) return;
  emit("respond", {
    kind: "question",
    interactionId: props.interaction.id,
    revision: props.interaction.revision,
    ...(responseText.value
      ? { text: responseText.value }
      : { optionId: selected.value }),
  });
}
function approval(decision: "approve" | "reject") {
  if (blocked.value) return;
  emit("respond", {
    kind: "approval",
    interactionId: props.interaction.id,
    revision: props.interaction.revision,
    decision,
  });
}
</script>
<template>
  <section
    v-if="pending"
    class="chatbot-interaction"
    :aria-label="interaction.kind === 'approval' ? '工具审批' : '补充信息'"
    :aria-busy="submitting"
  >
    <div class="chatbot-interaction-heading">
      <span>{{
        interaction.kind === "approval" ? "执行前确认" : "补充信息"
      }}</span>
      <span class="chatbot-interaction-status" role="status">{{
        submitting ? "正在提交…" : status
      }}</span>
    </div>
    <template v-if="interaction.kind === 'question'">
      <h3>{{ interaction.question }}</h3>
      <template v-if="pending">
        <div
          class="chatbot-interaction-options"
          role="group"
          :aria-label="interaction.question"
        >
          <button
            v-for="option in interaction.options"
            :key="option.id"
            type="button"
            class="chatbot-interaction-option"
            :class="{ 'is-selected': selected === option.id }"
            :aria-pressed="selected === option.id"
            :disabled="blocked"
            @click="
              selected = selected === option.id ? '' : option.id;
            "
          >
            {{ option.label }}
          </button>
        </div>
        <ElInput
          v-if="interaction.allowCustom"
          v-model="text"
          type="textarea"
          :rows="2"
          :maxlength="4000"
          :disabled="blocked"
          aria-label="补充信息"
          placeholder="补充信息（可选），也可以直接填写你的回答"
        />
        <p v-if="responseText.length > 4000" class="chatbot-error" role="alert">选项与补充信息合计不能超过 4000 字。</p>
        <div class="chatbot-interaction-actions">
          <ElButton :disabled="blocked" @click="$emit('respond', { kind: 'question', interactionId: interaction.id, revision: interaction.revision, skip: true })">跳过</ElButton>
          <ElButton
            type="primary"
            :disabled="!canSubmit"
            :loading="submitting"
            @click="question()"
            >提交</ElButton
          >
        </div>
      </template>
      <p v-else-if="answer" class="chatbot-interaction-answer">{{ answer }}</p>
    </template>
    <template v-else>
      <h3>{{ interaction.toolName }}</h3>
      <p v-if="interaction.description" class="chatbot-interaction-description">
        {{ interaction.description }}
      </p>
      <template v-if="pending">
        <p class="chatbot-interaction-note">批准仅适用于本次调用。</p>
        <div class="chatbot-interaction-actions">
          <ElButton
            type="primary"
            :disabled="blocked"
            :loading="submitting"
            @click="approval('approve')"
            >批准本次调用</ElButton
          >
          <ElButton :disabled="blocked" @click="approval('reject')"
            >拒绝</ElButton
          >
        </div>
      </template>
    </template>
    <p v-if="error" class="chatbot-error" role="alert">{{ error }}</p>
  </section>
  <div v-else class="chatbot-interaction-record">
    <div class="chatbot-interaction-record-heading"><span>{{ interaction.kind === 'question' ? '补充信息' : '执行确认' }}</span><span>{{ status }}</span></div>
    <p>{{ interaction.kind === 'question' ? interaction.question : interaction.toolName }}</p>
    <p v-if="answer" class="chatbot-interaction-answer">{{ answer }}</p>
  </div>
</template>
