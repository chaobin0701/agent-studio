<script lang="ts" setup>
import { computed, ref } from "vue";
import {
  useRouter,
  isNavigationFailure,
  NavigationFailureType,
} from "vue-router";
import { ElSelect, ElOption, ElMessage } from "element-plus";
import { useWorkspaceStore } from "#/store/workspace";

import { BasicLayout, UserDropdown } from "@vben/layouts";
import { useUserStore } from "@vben/stores";

import { useAuthStore } from "#/store";

const userStore = useUserStore();
const authStore = useAuthStore();
const workspace = useWorkspaceStore();
const router = useRouter();
const switchPending = ref(false);
async function switchWorkspace(value: number) {
  if (value === workspace.id || switchPending.value || workspace.switching)
    return;
  const previous = workspace.id;
  switchPending.value = true;
  try {
    // Keep route leave guards, but already being on the overview is not a refusal.
    const navigation = await router.push("/overview");
    if (
      isNavigationFailure(navigation) &&
      !isNavigationFailure(navigation, NavigationFailureType.duplicated)
    )
      return;
    if (router.currentRoute.value.path !== "/overview") return;
    await workspace.refresh();
    if (!workspace.items.some((w) => w.id === value && w.enabled)) {
      ElMessage.error("该工作区已停用或不再有访问权限，请选择其他工作区");
      return;
    }
    workspace.switching = true;
    workspace.select(value);
    await authStore.fetchUserInfo();
    // One reload resets workspace-scoped menus, tabs and cached pages together.
    location.reload();
  } catch {
    // An expired session resets the store; do not bring it back during rollback.
    if (workspace.id === value && previous !== undefined)
      workspace.select(previous);
    workspace.switching = false;
    ElMessage.error("工作区切换失败，请重试");
  } finally {
    switchPending.value = false;
  }
}
const name = computed(() => userStore.userInfo?.realName || "管理员");
</script>

<template>
  <div v-if="workspace.switching" class="p-8">正在切换工作区…</div>
  <BasicLayout v-else :text="name" @logout="authStore.logout(false)">
    <template #user-dropdown>
      <div class="flex items-center gap-4">
        <ElSelect
          :model-value="workspace.id"
          :disabled="switchPending"
          :loading="switchPending"
          aria-label="当前工作区"
          placeholder="选择工作区"
          class="w-48"
          @change="switchWorkspace"
        >
          <ElOption
            v-for="w in workspace.items"
            :key="w.id"
            :value="w.id"
            :label="w.name"
            :disabled="!w.enabled"
          />
        </ElSelect>
        <UserDropdown
          :text="name"
          :description="userStore.userInfo?.email || ''"
          :menus="[]"
          @logout="authStore.logout(false)"
        />
      </div>
    </template>
  </BasicLayout>
</template>
