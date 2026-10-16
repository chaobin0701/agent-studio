import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { resetAllStores, useAccessStore, useUserStore } from '@vben/stores';
import type { Recordable } from '@vben/types';

import { defineStore } from 'pinia';

import { useWorkspaceStore } from '#/store/workspace';

import { getAdminIdentityApi, loginApi, toUserInfo } from '#/api';

export const useAuthStore = defineStore('auth', () => {
  const accessStore = useAccessStore();
  const userStore = useUserStore();
  const router = useRouter();
  const loginLoading = ref(false);

  async function authLogin(params: Recordable<any>) {
    loginLoading.value = true;
    try {
      const { accessToken } = await loginApi({
        username: String(params.username || ''),
        password: String(params.password || ''),
      });
      accessStore.setAccessToken(accessToken);
      try {
        const userInfo = await fetchUserInfo();
        await router.replace(userInfo.homePath || preferences.app.defaultHomePath);
        return { userInfo };
      } catch (error) {
        resetAllStores();
        throw error;
      }
    } finally {
      loginLoading.value = false;
    }
  }

  async function logout(redirect = true) {
    const current = router.currentRoute.value;
    resetAllStores();
    await router.replace({
      path: LOGIN_PATH,
      query: redirect && current.path !== LOGIN_PATH
        ? { redirect: encodeURIComponent(current.fullPath) }
        : {},
    });
  }

  async function fetchUserInfo() {
    await useWorkspaceStore().initialize();
    const identity = await getAdminIdentityApi();
    const userInfo = toUserInfo(identity);
    userStore.setUserInfo(userInfo);
    accessStore.setAccessCodes(identity.permissionCodes);
    return userInfo;
  }

  function $reset() {
    loginLoading.value = false;
  }

  return { $reset, authLogin, fetchUserInfo, loginLoading, logout };
});
