<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>
<template>
  <header class="mb-4 flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="break-words text-xl font-semibold leading-7">{{ title }}</h1>
      <p v-if="description" class="mt-1 text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap items-center gap-2">
      <slot />
    </div>
  </header>
</template>
