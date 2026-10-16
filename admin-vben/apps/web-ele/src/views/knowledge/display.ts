export function dateTime(value?: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "—";
}

export function requestMessage(error: any, fallback: string) {
  const message =
    error?.response?.data?.error?.message ?? error?.response?.data?.message;
  return Array.isArray(message)
    ? message.join("；")
    : typeof message === "string"
      ? message
      : fallback;
}

export function chunkKind(kind?: string) {
  return (
    (
      {
        general: "普通分块",
        parent: "父分块",
        child: "子分块",
        faq: "历史文档分块",
      } as Record<string, string>
    )[kind || "general"] || kind
  );
}

export function sourceLocation(chunk: any, filename = "") {
  const locator = chunk.sourceLocator;
  const start = locator?.start ?? chunk.sourceStartLine;
  const end = locator?.end ?? chunk.sourceEndLine;
  if (start == null) return "未记录位置";
  const type =
    locator?.type ||
    (/\.pdf$/i.test(filename)
      ? "pdf_page"
      : /\.docx$/i.test(filename)
        ? "docx_paragraph"
        : /^FAQ(?:$|:)/i.test(filename)
          ? "faq_entry"
          : "markdown_lines");
  const range =
    end != null && end !== start ? `${start}–${end}` : String(start);
  return (
    (
      {
        pdf_page: `第 ${range} 页`,
        docx_paragraph: `第 ${range} 段`,
        faq_entry: `历史来源 ${range}`,
        markdown_lines: `第 ${range} 行`,
      } as Record<string, string>
    )[type] || `来源位置 ${range}`
  );
}

export function configSummary(config: any) {
  if (!config) return "未记录配置";
  const mode = config.indexMode === "high_quality" ? "向量" : "经济";
  const chunks =
    config.chunkMode === "parent_child"
      ? `父子分块 ${config.parentChars}/${config.childChars} 字`
      : `普通分块 ${config.chunkChars} 字`;
  return `${mode} · ${chunks}`;
}

export function configFields(config: any) {
  return [
    { label: "构建配置", value: configSummary(config) },
    {
      label: "重叠字数",
      value:
        config.chunkMode === "parent_child"
          ? config.childOverlapChars
          : config.overlapChars,
    },
    { label: "向量模型方案 ID", value: config.embeddingProfileId ?? "未使用" },
  ];
}
