import { reactive } from "vue";
import type {
  ChatAttachment,
  ChatSession,
  ChatTurn,
  ChatInteraction,
  ChatInteractionResponse,
  ChatQuota,
} from "./types";

export interface ChatbotApi {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  events(
    path: string,
    onEvent: (event: string, data: any) => void,
    signal: AbortSignal,
  ): Promise<void>;
  upload(path: string, file: File): Promise<ChatAttachment>;
  download(path: string): Promise<Blob>;
}
export interface ChatAgent {
  id: number;
  name: string;
  version: number;
  supportsImages: boolean;
  modelPlanId?: number;
  modelPlanVersionId?: number;
  imageInputReason?: string;
  imageConfigOutdated?: boolean;
}
interface Session extends ChatSession {
  agentId: number;
}
interface Pending {
  sessionId: string;
  requestId: string;
  message: string;
  attachmentIds: string[];
}
interface BufferState {
  messages: ChatTurn[];
  draft: string;
  attachments: ChatAttachment[];
  runId: string | null;
  runStatus: "running" | "waiting" | null;
  respondingId?: string;
  interactionErrors: Record<string, string>;
  loading: boolean;
  error: string;
  pending?: Pending;
  loaded: boolean;
}
const blank = (): BufferState => ({
  messages: [],
  draft: "",
  attachments: [],
  runId: null,
  runStatus: null,
  interactionErrors: {},
  loading: false,
  error: "",
  loaded: false,
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const message = (error: any) =>
  error?.response?.data?.error?.message ??
  error?.response?.data?.message ??
  error?.message ??
  "请求未完成，请重试";
const errorStatus = (error: any) => error?.response?.status ?? error?.status;

/** Shared conversation state, not a second execution/retry engine. Reconnects
 * only inspect the durable run. A POST is repeated solely by explicit user action. */
export function createChatbotClient(
  api: ChatbotApi,
  namespace: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
  const state = reactive({
    sessions: [] as Session[],
    agents: [] as ChatAgent[],
    activeId: null as string | null,
    selectedAgentId: undefined as number | undefined,
    buffers: { new: blank() } as Record<string, BufferState>,
    ready: false,
    loading: false,
    error: "",
    canDelete: false,
    canRename: true,
    creating: false,
    quota: null as ChatQuota | null,
  });
  let disposed = false,
    initial: Promise<void> | undefined,
    creating: Promise<string> | undefined,
    searchGeneration = 0;
  const observers = new Map<string, AbortController>();
  const submitting = new WeakSet<BufferState>();
  const previews = new Map<string, string>();
  const previewing = new Map<string, Promise<void>>();
  let capabilities: Promise<void> | undefined;
  let quotaRefresh: Promise<void> | undefined;
  async function refreshQuota() {
    if (quotaRefresh) return quotaRefresh;
    quotaRefresh = (async () => {
      try {
        const result = await api.request<{ quota?: ChatQuota | null }>(
          "GET",
          "/chat-status",
        );
        if (!disposed) state.quota = result.quota ?? null;
      } catch {
        // Permission and configuration failures intentionally hide this optional status.
        if (!disposed) state.quota = null;
      }
    })();
    try {
      await quotaRefresh;
    } finally {
      quotaRefresh = undefined;
    }
  }
  async function refreshCapabilities() {
    if (capabilities) return capabilities;
    capabilities = (async () => {
      const options = await api.request<{
        agents: ChatAgent[];
        canDelete: boolean;
        canRename: boolean;
      }>("GET", "/options");
      if (disposed) return;
      state.agents = options.agents;
      state.canDelete = options.canDelete;
      state.canRename = options.canRename;
      state.selectedAgentId ??= options.agents[0]?.id;
    })();
    try {
      await capabilities;
    } finally {
      capabilities = undefined;
    }
  }
  function releasePreview(id: string) {
    const url = previews.get(id);
    if (url) URL.revokeObjectURL(url);
    previews.delete(id);
    for (const buffer of Object.values(state.buffers))
      for (const item of [
        ...buffer.attachments,
        ...buffer.messages.flatMap((m) => m.attachments ?? []),
      ])
        if (item.id === id) item.previewUrl = undefined;
  }
  function bindPreview(id: string, url: string) {
    for (const buffer of Object.values(state.buffers))
      for (const item of [
        ...buffer.attachments,
        ...buffer.messages.flatMap((m) => m.attachments ?? []),
      ])
        if (item.id === id) item.previewUrl = url;
  }
  async function preview(sessionId: string, file: ChatAttachment) {
    if (file.status !== "ready" || !file.mimeType.startsWith("image/")) return;
    const cached = previews.get(file.id);
    if (cached) {
      bindPreview(file.id, cached);
      return;
    }
    const existing = previewing.get(file.id);
    if (existing) return existing;
    const pending = (async () => {
      try {
        // Authenticated download returns only the server-normalized image.
        const blob = await api.download(
          `/sessions/${sessionId}/attachments/${file.id}`,
        );
        if (
          disposed ||
          !state.buffers[sessionId] ||
          !blob.type.startsWith("image/")
        )
          return;
        const url = URL.createObjectURL(blob);
        previews.set(file.id, url);
        bindPreview(file.id, url);
        if (previews.size > 20) releasePreview(previews.keys().next().value!);
      } catch {
        /* A thumbnail failure must not fail an otherwise usable attachment. */
      }
    })();
    previewing.set(file.id, pending);
    try {
      await pending;
    } finally {
      previewing.delete(file.id);
    }
  }
  async function previewRecent(id: string, buffer: BufferState) {
    const files = [
      ...buffer.messages.flatMap((m) => m.attachments ?? []),
      ...buffer.attachments,
    ]
      .filter((f) => f.status === "ready" && f.mimeType.startsWith("image/"))
      .slice(-12);
    for (let i = 0; i < files.length && !disposed; i += 2)
      await Promise.all(files.slice(i, i + 2).map((f) => preview(id, f)));
  }
  function read(key: string) {
    try {
      return storage?.getItem(namespace + ":" + key) ?? null;
    } catch {
      return null;
    }
  }
  function save(key: string, value: string | null) {
    try {
      value === null
        ? storage?.removeItem(namespace + ":" + key)
        : storage?.setItem(namespace + ":" + key, value);
    } catch {
      /* restricted storage does not disable chat */
    }
  }
  const current = () =>
    state.buffers[state.activeId ?? "new"] ??
    (state.buffers[state.activeId ?? "new"] = blank());
  function draft(value: string) {
    current().draft = value;
    save("draft:" + (state.activeId ?? "new"), value);
  }
  async function search(query = "") {
    const generation = ++searchGeneration;
    const rows = await api.request<Session[]>(
      "GET",
      "/sessions?q=" + encodeURIComponent(query),
    );
    if (!disposed && generation === searchGeneration) state.sessions = rows;
  }
  async function load(id: string) {
    const buffer = state.buffers[id] ?? (state.buffers[id] = blank());
    buffer.loading = true;
    try {
      const detail = await api.request<{
        session: Session;
        messages: ChatTurn[];
        activeRunId: string | null;
        attachments: ChatAttachment[];
      }>("GET", "/sessions/" + id);
      if (disposed) return;
      buffer.messages = detail.messages;
      buffer.runId = detail.activeRunId;
      buffer.runStatus = buffer.runId
        ? detail.messages.some(
            (m) =>
              m.runId === buffer.runId &&
              (m.status === "waiting" ||
                m.interactions?.some((i) => i.status === "pending")),
          )
          ? "waiting"
          : "running"
        : null;
      buffer.loaded = true;
      buffer.error = "";
      if (!state.sessions.some((s) => s.id === id))
        state.sessions.unshift(detail.session);
      if (state.activeId === id) state.selectedAgentId = detail.session.agentId;
      if (!buffer.draft) buffer.draft = read("draft:" + id) ?? "";
      try {
        const selected: unknown = JSON.parse(read("attachments:" + id) ?? "[]");
        if (Array.isArray(selected) && !buffer.attachments.length)
          buffer.attachments = (detail.attachments ?? []).filter((a) =>
            selected.includes(a.id),
          );
      } catch {
        save("attachments:" + id, null);
      }
      if (buffer.pending) {
        const accepted = detail.messages.find(
          (m) => m.requestId === buffer.pending!.requestId,
        );
        if (accepted) {
          buffer.pending = undefined;
          save("pending:" + id, null);
          buffer.draft = "";
          buffer.attachments = [];
          save("draft:" + id, null);
          save("attachments:" + id, null);
        }
      }
      void previewRecent(id, buffer);
      if (buffer.runId && buffer.runStatus === "running")
        observe(id, buffer.runId);
    } catch (error) {
      if (!disposed) buffer.error = message(error);
      throw error;
    } finally {
      buffer.loading = false;
    }
  }
  async function open(id: string) {
    if (state.creating || !uuid.test(id)) return;
    state.activeId = id;
    save("active", id);
    const buffer = state.buffers[id] ?? (state.buffers[id] = blank());
    try {
      const pending = read("pending:" + id);
      if (pending) {
        const p = JSON.parse(pending);
        if (p.sessionId === id && uuid.test(p.requestId)) buffer.pending = p;
      }
    } catch {
      save("pending:" + id, null);
    }
    if (!buffer.loaded || !buffer.runId || buffer.runStatus === "waiting")
      await load(id).catch(() => {});
  }
  function newConversation(agentId = state.selectedAgentId) {
    if (state.creating) return;
    state.activeId = null;
    state.selectedAgentId = agentId;
    state.buffers.new = blank();
    save("active", null);
    save("draft:new", null);
  }
  async function initialize(id?: string) {
    if (!initial)
      initial = (async () => {
        state.loading = true;
        state.error = "";
        try {
          await Promise.all([refreshCapabilities(), refreshQuota()]);
          if (disposed) return;
          await search();
          if (disposed) return;
          state.ready = true;
          const restore = id ?? read("active");
          if (restore && uuid.test(restore)) await open(restore);
          else current().draft = read("draft:new") ?? "";
        } catch (error) {
          if (!disposed) {
            state.error = message(error);
            initial = undefined;
          }
        } finally {
          state.loading = false;
        }
      })();
    await initial;
    if (id && id !== state.activeId && state.ready) await open(id);
  }
  async function ensureSession() {
    if (state.activeId) return state.activeId;
    if (creating) return creating;
    if (!state.selectedAgentId) throw Error("请先选择已发布的 Agent");
    state.creating = true;
    const buffer = current();
    creating = (async () => {
      const session = await api.request<Session>("POST", "/sessions", {
        agentId: state.selectedAgentId,
      });
      if (disposed) throw Error("对话已关闭");
      state.sessions.unshift(session);
      state.activeId = session.id;
      state.buffers[session.id] = buffer;
      state.buffers.new = blank();
      save("active", session.id);
      save("draft:" + session.id, buffer.draft);
      save("draft:new", null);
      return session.id;
    })();
    try {
      return await creating;
    } finally {
      creating = undefined;
      state.creating = false;
    }
  }
  async function refresh() {
    try {
      await refreshCapabilities();
      await refreshQuota();
      if (disposed) return;
      state.error = "";
      await search();
      if (state.activeId) await load(state.activeId);
      else await initialize();
    } catch (error) {
      if (!disposed) state.error = message(error);
    }
  }
  function observe(id: string, runId: string) {
    if (disposed || observers.has(runId)) return;
    const buffer = state.buffers[id];
    if (!buffer) return;
    const controller = new AbortController();
    observers.set(runId, controller);
    const path = `/sessions/${id}/runs/${runId}`;
    const assistant = () =>
      buffer.messages.find((m) => m.id === runId + ":assistant");
    let terminal = false;
    let waiting = false;
    const interaction = (value: ChatInteraction) => {
      const target = assistant();
      if (!target || !value || value.runId !== runId) return;
      target.interactions ??= [];
      const index = target.interactions.findIndex((i) => i.id === value.id);
      if (index < 0) target.interactions.push(value);
      else target.interactions[index] = value;
      target.status = "waiting";
      buffer.runStatus = "waiting";
      waiting = true;
    };
    const event = (name: string, value: any) => {
      if (disposed || controller.signal.aborted) return;
      const target = assistant();
      if (name === "answer_delta" && target && typeof value.text === "string")
        target.content += value.text;
      if (name === "answer_reset" && target && typeof value.text === "string")
        target.content = value.text;
      if (
        name === "progress" &&
        target &&
        typeof value.id === "string" &&
        typeof value.text === "string"
      ) {
        target.progress ??= [];
        const index = target.progress.findIndex(
          (p) => typeof p !== "string" && p.id === value.id,
        );
        if (index < 0) target.progress.push(value);
        else target.progress[index] = value;
      }
      if (
        name === "retry_status" &&
        target &&
        typeof value.message === "string"
      )
        buffer.error = value.state === "waiting" ? value.message : "";
      if (name === "done" || name === "error") terminal = true;
      if (name === "interaction_required" && value?.interaction) {
        interaction(value.interaction);
        // A waiting stream has ended normally. Keep its active run so the
        // composer cannot submit a new task or replay the original message.
        controller.abort();
      }
    };
    void (async () => {
      try {
        await api.events(path + "/events", event, controller.signal);
      } catch {
        /* reconnect by GET only */
      }
      let failures = 0;
      while (!disposed && !controller.signal.aborted && !terminal && !waiting) {
        try {
          const turn = await api.request<any>("GET", path);
          failures = 0;
          if (turn.status === "waiting") {
            for (const item of turn.interactions ??
              (turn.interaction ? [turn.interaction] : []))
              interaction(item);
            buffer.runStatus = "waiting";
            waiting = true;
            break;
          }
          if (turn.status !== "running") {
            terminal = true;
            break;
          }
          event("answer_reset", { text: turn.partialAnswer });
          for (const progress of turn.progress ?? [])
            event("progress", progress);
        } catch (error) {
          if ([401, 403, 404].includes(errorStatus(error)) || ++failures >= 3) {
            buffer.error =
              message(error) + "；点击刷新恢复状态，不会自动重发消息。";
            break;
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      if (!disposed && (terminal || waiting)) {
        if (terminal) {
          buffer.runId = null;
          buffer.runStatus = null;
        }
        await load(id).catch(() => {});
        await Promise.all([search().catch(() => {}), refreshQuota()]);
      }
    })()
      .catch((error) => {
        if (!disposed) buffer.error = message(error);
      })
      .finally(() => {
        if (observers.get(runId) === controller) observers.delete(runId);
      });
  }
  async function respond(response: ChatInteractionResponse) {
    const id = state.activeId,
      buffer = current();
    if (
      !id ||
      !buffer.runId ||
      buffer.respondingId ||
      buffer.runStatus !== "waiting"
    )
      return;
    const interaction = buffer.messages
      .flatMap((m) => m.interactions ?? [])
      .find(
        (i) =>
          i.id === response.interactionId &&
          i.runId === buffer.runId &&
          i.status === "pending",
      );
    if (
      !interaction ||
      interaction.revision !== response.revision ||
      interaction.kind !== response.kind
    )
      return;
    const runId = buffer.runId;
    const body: ChatInteractionResponse =
      response.kind === "approval"
        ? {
            kind: "approval",
            interactionId: interaction.id,
            revision: interaction.revision,
            decision: response.decision,
          }
        : {
            kind: "question",
            interactionId: interaction.id,
            revision: interaction.revision,
            ...(response.skip ? { skip: true as const } : response.optionId
              ? { optionId: response.optionId }
              : { text: response.text?.trim() }),
          };
    if (
      body.kind === "approval" &&
      !["approve", "reject"].includes(body.decision)
    )
      return;
    if (
      body.kind === "question" &&
      !(body.skip || (body.optionId
        ? interaction.options?.some((o) => o.id === body.optionId)
        : interaction.allowCustom && body.text && body.text.length <= 4000))
    )
      return;
    buffer.respondingId = interaction.id;
    delete buffer.interactionErrors[interaction.id];
    try {
      await api.request(
        "POST",
        `/sessions/${id}/runs/${runId}/interactions/${interaction.id}/respond`,
        body,
      );
      if (disposed) return;
      interaction.revision += 1;
      buffer.runStatus = 'running';
      interaction.status = body.kind === 'approval' ? body.decision === 'approve' ? 'approved' : 'rejected' : body.skip ? 'skipped' : 'answered';
      if (body.kind === 'question') interaction.answer = body.skip ? { skipped: true } : body.optionId ? { optionId: body.optionId, text: interaction.options?.find(option => option.id === body.optionId)?.label } : { text: body.text };
      observers.get(runId)?.abort();
      observers.delete(runId);
      await load(id);
      await search();
    } catch (error) {
      if (disposed) return;
      // An uncertain POST is reconciled by reading durable state. It is never
      // retried automatically and cannot become an ordinary chat message.
      await load(id).catch(() => {});
      const currentInteraction = buffer.messages
        .flatMap((m) => m.interactions ?? [])
        .find((i) => i.id === interaction.id);
      if (currentInteraction?.status === "pending") {
        buffer.interactionErrors[interaction.id] =
          message(error) +
          ([400, 401, 403, 404, 409].includes(errorStatus(error))
            ? "；请刷新后重试。"
            : "；提交结果尚未确认。请先刷新状态，确认仍待处理后再提交同一答复。");
      } else if (!currentInteraction) {
        buffer.error = message(error);
      }
    } finally {
      buffer.respondingId = undefined;
    }
  }
  async function submit(pending: Pending) {
    const buffer = state.buffers[pending.sessionId];
    if (!buffer) return;
    buffer.loading = true;
    buffer.error = "";
    buffer.pending = pending;
    save("pending:" + pending.sessionId, JSON.stringify(pending));
    try {
      const turn = await api.request<{ id: string }>(
        "POST",
        `/sessions/${pending.sessionId}/messages`,
        {
          requestId: pending.requestId,
          message: pending.message,
          attachmentIds: pending.attachmentIds,
          stream: false,
        },
      );
      if (disposed) return;
      buffer.pending = undefined;
      save("pending:" + pending.sessionId, null);
      buffer.draft = "";
      buffer.attachments = [];
      save("attachments:" + pending.sessionId, null);
      save("draft:" + pending.sessionId, null);
      await load(pending.sessionId);
      observe(pending.sessionId, turn.id);
      await search();
    } catch (error) {
      if (disposed) return;
      buffer.error = message(error);
      // A definitive validation rejection was never admitted. Network/5xx keep
      // the original key for explicit retry, without silently repeating tools.
      if ([400, 401, 403, 404, 409, 413, 429].includes(errorStatus(error))) {
        buffer.pending = undefined;
        save("pending:" + pending.sessionId, null);
      } else {
        await load(pending.sessionId).catch(() => {});
        if (buffer.pending)
          buffer.error =
            "提交结果尚未确认。请先刷新状态，或点击“重试本次提交”；不会自动重发。";
      }
    } finally {
      buffer.loading = false;
    }
  }
  async function send() {
    const buffer = current();
    if (
      buffer.runId ||
      buffer.loading ||
      buffer.pending ||
      submitting.has(buffer)
    )
      return;
    if (!buffer.draft.trim() && !buffer.attachments.length) return;
    if (buffer.attachments.some((a) => a.status !== "ready")) {
      buffer.error = "请等待附件处理完成，或移除失败的文件";
      return;
    }
    submitting.add(buffer);
    try {
      const id = await ensureSession();
      await submit({
        sessionId: id,
        requestId: crypto.randomUUID(),
        message: buffer.draft.trim(),
        attachmentIds: buffer.attachments.map((a) => a.id),
      });
    } catch (error) {
      buffer.error = message(error);
    } finally {
      submitting.delete(buffer);
    }
  }
  async function upload(files: File[]) {
    const buffer = current();
    if (buffer.runId || buffer.pending || buffer.loading) return;
    buffer.error = "";
    try {
      if (
        files.some((f) => /\.(png|jpe?g|webp)$/i.test(f.name)) &&
        !state.agents.find((a) => a.id === state.selectedAgentId)
          ?.supportsImages
      )
        await refreshCapabilities();
      for (const file of files) {
        if (buffer.attachments.length >= 5) {
          buffer.error = "每轮最多 5 个附件";
          break;
        }
        const image = /\.(png|jpe?g|webp)$/i.test(file.name);
        if (
          !/\.(md|pdf|docx|png|jpe?g|webp)$/i.test(file.name) ||
          file.size > (image ? 5242880 : 2097152)
        ) {
          buffer.error =
            "支持 Markdown/PDF/DOCX（2 MB）、PNG/JPEG/WebP（5 MB）";
          continue;
        }
        if (
          image &&
          !state.agents.find((a) => a.id === state.selectedAgentId)
            ?.supportsImages
        ) {
          buffer.error =
            state.agents.find((a) => a.id === state.selectedAgentId)
              ?.imageInputReason ?? "当前 Agent 的已发布模型方案未开启图片输入";
          continue;
        }
        const id = await ensureSession();
        if (disposed) return;
        // Multiple native file-picker change callbacks can share session creation.
        if (buffer.attachments.length >= 5) {
          buffer.error = "每轮最多 5 个附件";
          break;
        }
        const temporary: ChatAttachment = {
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          mimeType: file.type,
          status: "uploading",
        };
        buffer.attachments.push(temporary);
        try {
          const ready = await api.upload(`/sessions/${id}/attachments`, file);
          if (disposed) return;
          const index = buffer.attachments.findIndex(
            (a) => a.id === temporary.id,
          );
          if (index >= 0) {
            buffer.attachments[index] = ready;
            void preview(id, ready);
          }
          save(
            "attachments:" + id,
            JSON.stringify(
              buffer.attachments
                .filter((a) => a.status === "ready")
                .map((a) => a.id),
            ),
          );
        } catch (error) {
          temporary.status = "failed";
          temporary.error = message(error);
          const index = buffer.attachments.findIndex(
            (a) => a.id === temporary.id,
          );
          if (index >= 0) buffer.attachments[index] = { ...temporary };
        }
      }
    } catch (error) {
      buffer.error = message(error);
    }
  }
  async function cancel() {
    const buffer = current();
    if (buffer.respondingId) return;
    const id = state.activeId,
      runId = buffer.runId;
    if (id && runId)
      try {
        await api.request("POST", `/sessions/${id}/runs/${runId}/cancel`, {});
        await load(id);
        await search();
      } catch (error) {
        buffer.error = message(error);
      }
  }
  async function rename(id: string, title: string) {
    await api.request("PATCH", "/sessions/" + id, { title });
    await search();
  }
  async function remove(id: string) {
    await api.request("DELETE", "/sessions/" + id);
    for (const m of state.buffers[id]?.messages ?? []) {
      if (m.runId) observers.get(m.runId)?.abort();
    }
    const buffer = state.buffers[id];
    for (const file of [
      ...(buffer?.attachments ?? []),
      ...(buffer?.messages.flatMap((m) => m.attachments ?? []) ?? []),
    ])
      releasePreview(file.id);
    delete state.buffers[id];
    save("draft:" + id, null);
    save("pending:" + id, null);
    save("attachments:" + id, null);
    if (state.activeId === id) newConversation();
    await search();
  }
  async function download(id: string) {
    const sessionId = state.activeId;
    if (!sessionId) return;
    const messages = current().messages;
    const attachment = messages
      .flatMap((m) => m.attachments ?? [])
      .find((a) => a.id === id);
    const producer = messages.find((m) =>
      m.artifacts?.some((a) => a.kind === "execution_file" && a.id === id),
    );
    const artifact = producer?.artifacts?.find((a) => a.id === id);
    const path = attachment
      ? `/sessions/${sessionId}/attachments/${id}`
      : producer
        ? `/sessions/${sessionId}/runs/${producer.runId}/artifacts/${id}`
        : null;
    if (!path) return;
    try {
      const blob = await api.download(path);
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download =
        attachment?.name ?? String(artifact?.data?.filename ?? "download");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      current().error = message(error);
    }
  }
  return {
    state,
    current,
    initialize,
    open,
    load,
    search,
    refresh,
    refreshCapabilities,
    refreshQuota,
    draft,
    send,
    respond,
    upload,
    cancel,
    rename,
    remove,
    download,
    newConversation,
    retryPending: () =>
      current().pending ? submit(current().pending!) : Promise.resolve(),
    removeAttachment: (id: string) => {
      current().attachments = current().attachments.filter((a) => a.id !== id);
      if (state.activeId)
        save(
          "attachments:" + state.activeId,
          JSON.stringify(
            current()
              .attachments.filter((a) => a.status === "ready")
              .map((a) => a.id),
          ),
        );
    },
    dispose: () => {
      disposed = true;
      for (const observer of observers.values()) observer.abort();
      observers.clear();
      for (const id of [...previews.keys()]) releasePreview(id);
    },
  };
}
export type ChatbotClient = ReturnType<typeof createChatbotClient>;
