<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  ElFormItem,
  ElInput,
  ElSelect,
  ElOption,
  ElInputNumber,
  ElSwitch,
  ElDivider,
  ElTable,
  ElTableColumn,
  ElButton,
  ElAlert,
  ElCollapse,
  ElCollapseItem,
} from "element-plus";
import HelpTip from "#/components/HelpTip.vue";
import JsonValueEditor from "#/components/JsonValueEditor.vue";
import { validateHeaders } from "#/components/json-validation";
import CredentialPicker from "./CredentialPicker.vue";
import SchemaEditor from "./SchemaEditor.vue";
import {
  builtinToolConfig,
  httpToolConfig,
  uiToolConfig,
  type BuiltinToolOption,
} from "./create-config";
const config = defineModel<any>({ required: true });
const props = defineProps<{
  options: any;
  disabled?: boolean;
  creating?: boolean;
  section?: "all" | "connection" | "parameters" | "result" | "runtime";
}>();
const show = (section: string) =>
  !props.section || props.section === "all" || props.section === section;
const emit = defineEmits<{ valid: [value: boolean] }>();
const errors = ref({ input: false, output: false, headers: false });
watch(
  () => config.value,
  () => {
    errors.value = { input: false, output: false, headers: false };
    emit("valid", true);
  },
);
const remote = computed(() => config.value.type === "mcp");
const questionTool = computed(
  () => config.value.type === "builtin" && config.value.target === "ask_user",
);
const builtinOptions = computed<BuiltinToolOption[]>(
  () => props.options?.tools ?? [],
);
function selectBuiltin(target: string) {
  if (!props.creating || props.disabled) return;
  config.value = builtinToolConfig(builtinOptions.value, target);
}
function selectType(type: string) {
  if (!props.creating || props.disabled || config.value.type === type) return;
  if (type === "rest") config.value = httpToolConfig();
  else if (type === "ui") config.value = uiToolConfig();
  else if (type === "builtin") {
    const option =
      builtinOptions.value.find((item) => item.key === "ask_user") ??
      builtinOptions.value[0];
    if (option) selectBuiltin(option.key);
  }
}
const uiCatalog = computed({
  get: () => config.value.uiCatalog,
  set: value => { config.value.uiCatalog = value; config.value.parameters = value?.parameters ?? { type: "object", properties: {} }; },
});
function validateCatalog(value: any) {
  return value?.adapter === "assistant-ui" && value?.version && value?.parameters?.type === "object" && Object.keys(value?.components ?? {}).length
    ? undefined : "请粘贴展示站导出的完整组件目录";
}
const outputEnabled = computed({
  get: () => !!config.value.outputSchema,
  set: (value) => {
    if (value) config.value.outputSchema = { type: "object", properties: {} };
    else delete config.value.outputSchema;
    validity("output", true);
  },
});
function validity(field: "input" | "output" | "headers", valid: boolean) {
  errors.value[field] = !valid;
  emit("valid", !Object.values(errors.value).some(Boolean));
}
function mappingMode(value: string) {
  config.value.endpoint.mappingMode = value;
  config.value.endpoint.bindings ??= [];
  config.value.endpoint.headers ??= {};
}
function addBinding() {
  config.value.endpoint.bindings ??= [];
  config.value.endpoint.bindings.push({
    source: Object.keys(config.value.parameters?.properties ?? {})[0] ?? "",
    location: "query",
    target: "",
  });
}
function credential(value: number | undefined) {
  if (value) config.value.endpoint.credentialId = value;
  else delete config.value.endpoint.credentialId;
}
</script>
<template>
  <div v-show="show('connection')">
    <ElFormItem label="工具类型"
      ><ElSelect
        v-if="creating"
        :model-value="config.type"
        :disabled="disabled"
        @change="selectType"
      >
        <ElOption value="rest" label="HTTP 工具" />
        <ElOption value="ui" label="生成式 UI（assistant-ui）" />
        <ElOption
          value="builtin"
          label="内置工具"
          :disabled="!builtinOptions.length"
        /> </ElSelect
      ><span v-else>{{
        config.type === "rest"
          ? "HTTP 工具"
          : config.type === "builtin"
            ? "内置工具"
            : config.type === "ui" ? "生成式 UI（assistant-ui）" : "MCP 工具"
      }}</span></ElFormItem
    >
    <ElFormItem
      v-if="creating && config.type === 'builtin'"
      label="内置工具"
      required
    >
      <ElSelect
        :model-value="config.target"
        filterable
        :disabled="disabled"
        placeholder="选择已注册的内置工具"
        @change="selectBuiltin"
      >
        <ElOption
          v-for="tool in builtinOptions"
          :key="tool.key"
          :value="tool.key"
          :label="tool.key === 'ask_user' ? 'ask_user · 向用户提问' : tool.key"
        />
      </ElSelect>
    </ElFormItem>
    <template v-if="config.type === 'ui'">
      <ElAlert title="从展示站运行 npm run ui:catalog 导出目录并粘贴。保存、测试并发布此 Tool 版本后，由 Agent 显式绑定。新增组件不需要后端部署。" type="info" :closable="false" class="mb-4" />
      <ElFormItem label="展示站组件目录" required>
        <JsonValueEditor v-model="uiCatalog" kind="object" label="组件目录" :height="320" :readonly="disabled" :validate-value="validateCatalog" @valid="value => validity('input', value)" />
      </ElFormItem>
      <p v-if="config.uiCatalog" class="mb-4 text-sm text-muted-foreground">{{ Object.keys(config.uiCatalog.components ?? {}).join(' · ') }} · {{ config.uiCatalog.version }}</p>
    </template>
    <ElFormItem label="用途 / 使用时机" required
      ><ElInput
        v-model="config.description"
        type="textarea"
        :rows="3"
        placeholder="说明工具能做什么、模型应在什么情况下调用。"
    /></ElFormItem>
    <ElFormItem v-if="config.type === 'builtin'" label="代码实现"
      ><span>{{ config.target }}（由代码注册，不可修改）</span></ElFormItem
    >
    <template v-if="remote">
      <ElFormItem label="原生工具 / 服务版本"
        ><span
          >{{ config.target }} · #{{ config.mcpVersionId ?? "内置插件" }}</span
        ></ElFormItem
      >
      <ElAlert
        title="MCP 的原生参数契约不可编辑。服务变化后，请在 MCP 管理中获取工具并创建新版本；不会自动改变 Agent 已绑定版本。"
        type="info"
        :closable="false"
        class="mb-4"
      />
    </template>
    <template v-if="config.type === 'rest'">
      <ElDivider>HTTP 连接</ElDivider>
      <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-[160px_minmax(0,1fr)]">
        <ElFormItem label="请求方法"
          ><ElSelect
            v-model="config.endpoint.method"
            :disabled="disabled"
            @change="
              (value) => {
                if (value !== 'GET') {
                  config.readOnly = false;
                  config.maxRetries = 0;
                  config.requiresApproval = true;
                }
              }
            "
            ><ElOption
              v-for="method in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']"
              :key="method"
              :value="method"
              :label="method" /></ElSelect
        ></ElFormItem>
        <ElFormItem label="请求 URL" required>
          <template #label
            ><span class="inline-flex items-center gap-1"
              >请求 URL<HelpTip
                text="默认仅访问公网 HTTPS；HTTP 和内网地址需部署端配置允许访问的主机，服务重定向被阻止。路径可使用 {参数名}，并在下方配置路径映射。"
                long /></span
          ></template>
          <ElInput
            v-model="config.endpoint.url"
            placeholder="https://api.example.com/items/{item_id}"
          />
        </ElFormItem>
      </div>
      <ElFormItem label="认证凭证"
        ><CredentialPicker
          :model-value="config.endpoint.credentialId"
          :disabled="disabled || !!config.endpoint.credentialEnv"
          @update:model-value="credential"
      /></ElFormItem>
      <ElCollapse class="mb-4"
        ><ElCollapseItem title="高级连接设置：固定请求头 / 旧凭证兼容">
          <ElFormItem label="固定请求头（JSON）"
            ><JsonValueEditor
              v-model="config.endpoint.headers"
              kind="object"
              label="固定请求头"
              :height="180"
              :readonly="disabled"
              :validate-value="validateHeaders"
              @valid="(value) => validity('headers', value)" /><HelpTip
              text="所有值必须为字符串。Authorization 等认证信息请使用上方凭证管理，不要放在固定请求头中。"
              long
          /></ElFormItem>
          <ElFormItem label="兼容凭证环境变量"
            ><ElInput
              :model-value="config.endpoint.credentialEnv ?? ''"
              placeholder="旧配置兼容；新配置建议使用凭证管理"
              @update:model-value="
                (value) => {
                  if (value) config.endpoint.credentialEnv = value;
                  else delete config.endpoint.credentialEnv;
                }
              "
          /></ElFormItem> </ElCollapseItem
      ></ElCollapse>
    </template>
  </div>
  <div v-show="show('parameters')">
    <ElDivider v-if="!section || section === 'all'">输入参数与映射</ElDivider>
    <ElFormItem label="模型调用时提供的参数"
      ><SchemaEditor
        v-model="config.parameters"
        :disabled="disabled || config.type !== 'rest'"
        :advanced-only="config.type !== 'rest'"
        @valid="(value) => validity('input', value)"
    /></ElFormItem>
    <template v-if="config.type === 'rest'">
      <ElFormItem label="参数发送方式"
        ><ElSelect
          :model-value="config.endpoint.mappingMode ?? 'legacy'"
          @change="mappingMode"
          ><ElOption value="explicit" label="显式映射（推荐）" /><ElOption
            value="legacy"
            label="兼容模式：GET → Query，其他方法 → JSON Body" /></ElSelect
        ><HelpTip
          text="将模型输入转换为 HTTP 参数。例如模型提供 order_id：映射到 path 后替换 URL 的 {order_id}；映射到 query 则发送 ?order_id=123；body 可使用 customer.id 表示嵌套字段。显式模式只发送已配置映射的参数。"
          long
      /></ElFormItem>
      <template v-if="config.endpoint.mappingMode === 'explicit'">
        <ElTable :data="config.endpoint.bindings ?? []">
          <ElTableColumn label="模型输入参数"
            ><template #default="{ row }"
              ><ElSelect v-model="row.source" filterable :disabled="disabled"
                ><ElOption
                  v-for="name in Object.keys(
                    config.parameters.properties ?? {},
                  )"
                  :key="name"
                  :value="name"
                  :label="name" /></ElSelect></template
          ></ElTableColumn>
          <ElTableColumn label="发送位置" width="155"
            ><template #default="{ row }"
              ><ElSelect v-model="row.location" :disabled="disabled"
                ><ElOption value="path" label="URL 路径" /><ElOption
                  value="query"
                  label="Query 查询参数" /><ElOption
                  value="header"
                  label="请求头 Header" /><ElOption
                  v-if="config.endpoint.method !== 'GET'"
                  value="body"
                  label="JSON 请求体" /></ElSelect></template
          ></ElTableColumn>
          <ElTableColumn label="接口字段名"
            ><template #default="{ row }"
              ><ElInput
                v-model="row.target"
                :disabled="disabled"
                placeholder="例如 order_id、customer.id" /></template
          ></ElTableColumn>
          <ElTableColumn width="75"
            ><template #default="{ $index }"
              ><ElButton
                link
                :disabled="disabled"
                @click="config.endpoint.bindings.splice($index, 1)"
                >移除</ElButton
              ></template
            ></ElTableColumn
          >
        </ElTable>
        <ElButton class="my-3" :disabled="disabled" @click="addBinding"
          >添加映射</ElButton
        >
      </template>
    </template>
  </div>
  <div v-show="show('result') && config.type !== 'ui'">
    <ElDivider v-if="!section || section === 'all'">返回结果</ElDivider>
    <ElFormItem v-if="config.type === 'rest'" label="结果提取路径"
      ><ElInput
        v-model="config.endpoint.resultPath"
        placeholder="例如 data.order；留空返回完整结果" /><HelpTip
        text="从响应 JSON 中提取模型需要的部分。若填写 data.order，返回对象里的 data.order；路径不存在时报告错误。输出结构校验应用于提取后的结果。"
        long
    /></ElFormItem>
    <ElFormItem label="校验输出结构"
      ><ElSwitch
        v-model="outputEnabled"
        :disabled="disabled || remote" /><HelpTip
        text="开启后，返回结果必须满足下方 JSON Schema，否则工具调用判定为失败。JSON 格式校验与实际结构校验是两回事。"
        long
    /></ElFormItem>
    <ElFormItem v-if="outputEnabled" label="输出 JSON Schema"
      ><SchemaEditor
        v-model="config.outputSchema"
        advanced-only
        :disabled="disabled || remote"
        @valid="(value) => validity('output', value)"
    /></ElFormItem>
  </div>
  <div v-show="show('runtime') && config.type !== 'ui'">
    <ElDivider v-if="!section || section === 'all'">安全与执行策略</ElDivider>
    <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
      <ElFormItem label="仅读取，不修改数据"
        ><ElSwitch
          v-model="config.readOnly"
          :disabled="
            disabled ||
            (config.type === 'rest' && config.endpoint.method !== 'GET')
          "
          @change="
            (value) => {
              if (!value && !config.idempotencyHeader) config.maxRetries = 0;
            }
          " /><HelpTip
          text="表示实际调用不会修改外部数据，例如查询订单、查询天气；创建订单、发消息、删除记录不应开启。这不是编辑锁，也不能阻止远端写入，必须按真实行为声明。当前 HTTP 工具仅 GET 可标记只读；未知 MCP 工具默认关闭。系统据此判断自动重试是否安全，审批仍由旁边的开关独立控制。"
          long
      /></ElFormItem>
      <ElFormItem label="调用前需批准"
        ><ElSwitch
          v-model="config.requiresApproval"
          :disabled="disabled || questionTool" /><HelpTip
          text="开启后，执行会在调用此工具前等待用户批准；批准仅适用于本次调用及其参数，与是否只读独立。后台真实测试也需确认批准本次调用。修改后需发布新版本并更新 Agent。"
          long
      /></ElFormItem>
    </div>
    <ElFormItem
      v-if="!config.readOnly && config.type === 'rest'"
      label="幂等请求头"
      ><ElInput
        :model-value="config.idempotencyHeader ?? ''"
        placeholder="例如 Idempotency-Key"
        @update:model-value="
          (value) => {
            if (value) config.idempotencyHeader = value;
            else {
              delete config.idempotencyHeader;
              config.maxRetries = 0;
            }
          }
        " /><HelpTip
        text="写入工具开启重试前必须配置，且远端接口必须真正支持此请求头，避免重复创建或扣费。仅填写名称不代表接口具备幂等能力。"
        long
    /></ElFormItem>
    <div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
      <ElFormItem label="单次调用超时（毫秒）"
        ><ElInputNumber v-model="config.timeoutMs" :min="1000" :max="120000"
      /></ElFormItem>
      <ElFormItem label="失败后最大重试次数"
        ><ElInputNumber
          v-model="config.maxRetries"
          :min="0"
          :max="3"
          :disabled="
            disabled ||
            questionTool ||
            (!config.readOnly &&
              (config.type !== 'rest' || !config.idempotencyHeader))
          " /><HelpTip
          :text="`含首次调用，最多 ${(config.maxRetries ?? 0) + 1} 次尝试；只重试临时错误。HTTP 写入重试需服务端支持幂等；MCP 写入不自动重试。`"
          long
      /></ElFormItem>
    </div>
  </div>
</template>
