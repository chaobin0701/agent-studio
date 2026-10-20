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
const custom = ref(false);
const pending = computed(() => props.interaction.status === "pending");
const blocked = computed(
  () => props.disabled || props.submitting || !pending.value,
);
const canSubmit = computed(
  () =>
    !blocked.value && (custom.value ? !!text.value.trim() : !!selected.value),
);
const status = computed(
  () =>
    ({
      pending: props.interaction.kind === "approval" ? "等待确认" : "等待回答",
      answered: "已回答",
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
const argumentsText = computed(() =>
  JSON.stringify(props.interaction.arguments ?? {}, null, 2),
);
watch(
  () => props.interaction.id,
  () => {
    selected.value = "";
    text.value = "";
    custom.value = false;
  },
);
function question() {
  if (!canSubmit.value) return;
  emit("respond", {
    kind: "question",
    interactionId: props.interaction.id,
    revision: props.interaction.revision,
    ...(custom.value
      ? { text: text.value.trim() }
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
            :class="{ 'is-selected': !custom && selected === option.id }"
            :aria-pressed="!custom && selected === option.id"
            :disabled="blocked"
            @click="
              selected = option.id;
              custom = false;
            "
          >
            {{ option.label }}
          </button>
          <button
            v-if="interaction.allowCustom"
            type="button"
            class="chatbot-interaction-option"
            :class="{ 'is-selected': custom }"
            :aria-pressed="custom"
            :disabled="blocked"
            @click="custom = true"
          >
            自由填写
          </button>
        </div>
        <ElInput
          v-if="custom || !interaction.options?.length"
          v-model="text"
          type="textarea"
          :rows="2"
          :maxlength="4000"
          :disabled="blocked"
          aria-label="填写回答"
          placeholder="填写你的回答"
          @input="custom = true"
        />
        <div class="chatbot-interaction-actions">
          <ElButton
            type="primary"
            :disabled="!canSubmit"
            :loading="submitting"
            @click="question()"
            >提交回答</ElButton
          >
          <ElButton :disabled="blocked" @click="$emit('cancel')"
            >取消任务</ElButton
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
      <details class="chatbot-interaction-arguments" open>
        <summary>调用参数</summary>
        <pre>{{ argumentsText }}</pre>
      </details>
      <template v-if="pending">
        <p class="chatbot-interaction-note">批准仅适用于本次调用及以上参数。</p>
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
</template>
