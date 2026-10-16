import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database.service";
import type { CompositionSnapshot } from "../agent-management/runtime-scope";
import type { ReadonlyContextFile } from "../ai/deep-agents/managed-harness";
import type { LlmImage } from "../ai/providers/provider.types";

type Parsed =
  | {
      ok: true;
      content: Uint8Array;
      parsedText?: string;
      mimeType: string;
      width?: number;
      height?: number;
    }
  | { ok: false; error: string };
type Attachment = {
  id: string;
  name: string;
  kind: "image" | "document";
  mimeType: string;
  size: number;
  status: string;
  error?: string;
  expiresAt: string;
  width?: number;
  height?: number;
  content?: Buffer;
  parsedText?: string;
};
const columns = `id,name,kind,mime_type AS "mimeType",byte_size AS size,CASE WHEN expires_at<=now() THEN 'expired' ELSE status END AS status,error_message AS error,expires_at AS "expiresAt",width,height`;
export function supportsConversationImages(composition: CompositionSnapshot) {
  const deployments =
    composition.agents.get(composition.entryVersionId)?.modelPlan?.config
      .deployments ?? [];
  return (
    deployments.length > 0 &&
    deployments.every(
      (d) =>
        "supportsImageInput" in d.config &&
        d.config.supportsImageInput === true,
    )
  );
}

/** Called only after ChatbotService resolves an owned, live session. No URL/path input. */
@Injectable()
export class ChatbotAttachmentService {
  constructor(private readonly db: DatabaseService) {}
  async upload(
    sessionId: string,
    file: Express.Multer.File,
    imagesEnabled: boolean,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException("请选择文件");
    let originalName = file.originalname;
    if ([...originalName].every((c) => c.charCodeAt(0) <= 255))
      try {
        originalName = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.from(originalName, "latin1"),
        );
      } catch {
        /* A genuine Latin-1 name is retained. */
      }
    const name = originalName
        .normalize("NFC")
        .replace(/[\x00-\x1f\x7f/\\"<>]/gu, "_")
        .slice(0, 220),
      extension = extname(name).toLowerCase();
    const image = [".png", ".jpg", ".jpeg", ".webp"].includes(extension);
    if (!image && ![".md", ".pdf", ".docx"].includes(extension))
      throw new BadRequestException(
        "仅支持 Markdown、PDF、DOCX、PNG、JPEG、WebP",
      );
    if (file.size > (image ? 5242880 : 2097152))
      throw new BadRequestException(
        image ? "图片不超过 5 MB" : "文档不超过 2 MB",
      );
    if (image && !imagesEnabled)
      throw new BadRequestException(
        "当前已发布模型方案未开启图片输入，请选择支持图片的 Agent，或先更新模型部署并发布方案",
      );
    const id = randomUUID(),
      hash = createHash("sha256").update(file.buffer).digest("hex");
    await this.db.query(
      `INSERT INTO chatbot_attachments(id,session_id,name,kind,mime_type,byte_size,sha256,content) VALUES($1,$2,$3,$4,'application/octet-stream',$5,$6,$7)`,
      [
        id,
        sessionId,
        image ? name.replace(/\.[^.]+$/u, ".jpg") : name,
        image ? "image" : "document",
        file.size,
        hash,
        file.buffer,
      ],
    );
    try {
      const parsed = await this.parse(file.buffer, extension);
      if (!parsed.ok) throw new BadRequestException(parsed.error);
      const content = Buffer.from(parsed.content);
      await this.db.query(
        `UPDATE chatbot_attachments a SET content=$2,byte_size=$3,sha256=$4,mime_type=$5,parsed_text=$6,width=$7,height=$8,status='ready' WHERE id=$1 AND status='processing' AND expires_at>now() AND EXISTS(SELECT 1 FROM chatbot_sessions s WHERE s.id=a.session_id AND s.deleted_at IS NULL)`,
        [
          id,
          content,
          content.length,
          createHash("sha256").update(content).digest("hex"),
          parsed.mimeType,
          parsed.parsedText ?? null,
          parsed.width ?? null,
          parsed.height ?? null,
        ],
      );
    } catch (error) {
      await this.db.query(
        "UPDATE chatbot_attachments SET status='failed',content=NULL,parsed_text=NULL,purged_at=now(),error_message=$2 WHERE id=$1 AND status='processing'",
        [
          id,
          error instanceof BadRequestException
            ? error.message
            : "文件处理超时或失败，请重试",
        ],
      );
    }
    return this.get(sessionId, id);
  }
  private parse(bytes: Buffer, extension: string): Promise<Parsed> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(require.resolve("./attachment-parser.worker"), {
        workerData: { bytes, extension },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
      });
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Attachment processing timeout"));
      }, 20000);
      worker.once("message", (result: Parsed) => {
        clearTimeout(timeout);
        void worker.terminate();
        resolve(result);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timeout);
        if (code) reject(new Error("Attachment parser stopped"));
      });
    });
  }
  async get(sessionId: string, id: string, bytes = false) {
    const row = (
      await this.db.query<Attachment>(
        `SELECT ${columns}${bytes ? ',content,parsed_text AS "parsedText"' : ""} FROM chatbot_attachments WHERE session_id=$1 AND id=$2`,
        [sessionId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("附件不存在");
    return row;
  }
  async list(sessionId: string) {
    return (
      await this.db.query<Attachment>(
        `SELECT ${columns} FROM chatbot_attachments WHERE session_id=$1 ORDER BY created_at DESC LIMIT 100`,
        [sessionId],
      )
    ).rows;
  }
  async forTurns(sessionId: string) {
    return (
      await this.db.query<Attachment & { turnId: string }>(
        `SELECT a.id,a.name,a.kind,a.mime_type AS "mimeType",a.byte_size AS size,CASE WHEN a.expires_at<=now() THEN 'expired' ELSE a.status END AS status,a.error_message AS error,a.expires_at AS "expiresAt",l.turn_id AS "turnId" FROM chatbot_attachments a JOIN chatbot_turn_attachments l ON l.attachment_id=a.id WHERE a.session_id=$1 ORDER BY a.created_at`,
        [sessionId],
      )
    ).rows;
  }
  async resolve(
    sessionId: string,
    ids: string[],
    composition: CompositionSnapshot,
    c: Pick<DatabaseService, "query"> = this.db,
  ) {
    const rows = (
      await c.query<Attachment>(
        `SELECT ${columns},content,parsed_text AS "parsedText" FROM chatbot_attachments WHERE session_id=$1 AND id=ANY($2::uuid[]) ORDER BY created_at`,
        [sessionId, [...new Set(ids)]],
      )
    ).rows;
    if (
      rows.length !== new Set(ids).size ||
      rows.some((r) => r.status !== "ready" || !r.content)
    )
      throw new BadRequestException(
        "附件不属于此会话、尚未就绪或已过期，请重新上传",
      );
    if (
      rows.some((r) => r.kind === "image") &&
      !supportsConversationImages(composition)
    )
      throw new BadRequestException("当前发布的模型方案不支持图片输入");
    if (rows.reduce((n, r) => n + (r.parsedText?.length ?? 0), 0) > 60000)
      throw new BadRequestException(
        "本轮文档文本合计不超过 60,000 字，请减少附件",
      );
    return {
      metadata: rows.map(
        ({ content: _bytes, parsedText: _text, ...metadata }) => metadata,
      ),
      contextFiles: rows
        .filter((r) => r.kind === "document")
        .map(
          (r) =>
            ({
              path: `/context/attachment-${r.id}.txt`,
              title: r.name,
              content: r.parsedText!,
              contextSource: "conversation_attachment",
              reference: {
                kind: "conversation_attachment",
                id: r.id,
                title: r.name,
              },
            }) satisfies ReadonlyContextFile,
        ),
      images: rows
        .filter((r) => r.kind === "image")
        .map(
          (r) =>
            ({
              id: r.id,
              mimeType: "image/jpeg" as const,
              data: r.content!,
              width: r.width!,
              height: r.height!,
            }) satisfies LlmImage,
        ),
    };
  }
  async link(c: PoolClient, turnId: string, ids: string[]) {
    for (const id of new Set(ids))
      await c.query(
        "INSERT INTO chatbot_turn_attachments(turn_id,attachment_id) VALUES($1,$2)",
        [turnId, id],
      );
  }
  async validate(sessionId: string, id: string) {
    const row = await this.get(sessionId, id);
    if (
      row.status !== "ready" ||
      new Date(row.expiresAt).getTime() <= Date.now()
    )
      throw new BadRequestException("附件已失效，请重新上传");
  }
}
