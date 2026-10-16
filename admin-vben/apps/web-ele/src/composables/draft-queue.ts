export type DraftWrite = {
  identity: string;
  revision: number;
  payload: string;
};
export type DraftSaveState = {
  saving: boolean;
  error: string;
  conflict: boolean;
};

/** One optimistic write at a time. Never acknowledge newer edits or another resource. */
export function createDraftQueue(options: {
  read: () => DraftWrite | undefined;
  write: (draft: DraftWrite) => Promise<{ revision: number }>;
  accept: (draft: DraftWrite, result: { revision: number }) => void;
  state: (value: DraftSaveState) => void;
  delay?: number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<boolean> | undefined;
  let epoch = 0;
  let conflict = false;
  let disposed = false;
  const cancelTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  async function persist(): Promise<boolean> {
    cancelTimer();
    if (pending) return pending;
    if (conflict || disposed) return false;
    const draft = options.read();
    if (!draft) return true;
    const current = epoch;
    options.state({ saving: true, error: "", conflict: false });
    pending = (async () => {
      try {
        const result = await options.write(draft);
        if (current !== epoch) return false;
        options.accept(draft, result);
        options.state({ saving: false, error: "", conflict: false });
        return true;
      } catch (failure: any) {
        if (current === epoch) {
          conflict = failure.response?.status === 409;
          const message =
            failure.response?.data?.error?.message ??
            failure.response?.data?.message;
          options.state({
            saving: false,
            conflict,
            error:
              typeof message === "string"
                ? message
                : "草稿保存失败，编辑内容仍保留，请重试",
          });
        }
        return false;
      }
    })();
    const okay = await pending;
    pending = undefined;
    if (okay && current === epoch && options.read()) schedule();
    if (current !== epoch && !disposed) schedule();
    return okay;
  }
  function schedule() {
    cancelTimer();
    if (!disposed && !conflict && options.read())
      timer = setTimeout(() => {
        void persist();
      }, options.delay ?? 800);
  }
  async function flush() {
    cancelTimer();
    if (pending && !(await pending)) return false;
    while (options.read()) {
      if (!(await persist())) return false;
      cancelTimer();
    }
    return !conflict;
  }
  function reset() {
    cancelTimer();
    epoch++;
    conflict = false;
    options.state({ saving: false, error: "", conflict: false });
  }
  return {
    schedule,
    flush,
    reset,
    dispose: () => {
      reset();
      disposed = true;
    },
  };
}
