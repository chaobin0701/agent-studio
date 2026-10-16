<script lang="ts" setup>
import type { VbenFormSchema } from '@vben/common-ui';

import { AuthenticationLogin, z } from '@vben/common-ui';

import { useAuthStore } from '#/store';

defineOptions({ name: 'Login' });
const authStore = useAuthStore();

const formSchema: VbenFormSchema[] = [
  {
    component: 'VbenInput',
    componentProps: { autocomplete: 'username', placeholder: '邮箱或用户名' },
    fieldName: 'username',
    label: '邮箱或用户名',
    rules: z.string().min(1, '请输入邮箱或用户名'),
  },
  {
    component: 'VbenInputPassword',
    componentProps: { autocomplete: 'current-password', placeholder: '密码' },
    fieldName: 'password',
    label: '密码',
    rules: z.string().min(1, '请输入密码'),
  },
];
</script>

<template>
  <AuthenticationLogin
    :form-schema="formSchema"
    :loading="authStore.loginLoading"
    :show-code-login="false"
    :show-forget-password="false"
    :show-qrcode-login="false"
    :show-remember-me="false"
    :show-register="false"
    :show-third-party-login="false"
    title="管理后台"
    sub-title="使用管理员账号登录"
    @submit="authStore.authLogin"
  />
</template>
