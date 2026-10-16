import { parentPort, workerData } from "node:worker_threads";
import sharp from "sharp";
import { parseDocument } from "../documents/extract-document";

async function parse() {
  const { extension } = workerData as { extension: string };
  const bytes = Buffer.from(workerData.bytes);
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const image = sharp(bytes, {
      limitInputPixels: 16000000,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
      (metadata.pages ?? 1) > 1
    )
      throw new Error("image");
    const result = await image
      .rotate()
      .resize({
        width: 2048,
        height: 2048,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });
    return {
      content: result.data,
      mimeType: "image/jpeg",
      width: result.info.width,
      height: result.info.height,
    };
  }
  if (extension === ".pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("format");
  if (
    extension === ".docx" &&
    bytes.subarray(0, 4).toString("hex") !== "504b0304"
  )
    throw new Error("format");
  const parsed = await parseDocument(bytes, "attachment" + extension);
  if (parsed.extractedText.length > 24000) throw new Error("text_limit");
  return {
    content: bytes,
    parsedText: parsed.extractedText,
    mimeType:
      extension === ".md"
        ? "text/markdown"
        : extension === ".pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}
void parse()
  .then((result) => parentPort!.postMessage({ ok: true, ...result }))
  .catch((error) =>
    parentPort!.postMessage({
      ok: false,
      error:
        error instanceof Error && error.message === "text_limit"
          ? "文档解析文本超过 24,000 字，请拆分后上传"
          : "文件无法解析。仅支持可读取文本的 Markdown、PDF、DOCX 和有效的 PNG/JPEG/WebP 图片，不支持扫描 PDF 或动画图片。",
    }),
  );
