import { createHash, randomUUID } from "node:crypto";
import { extname, basename } from "node:path";
import type { AgentArtifact } from "../ai/agent/execution-contract";
import { redactToolData } from "../tool-management/network";

export const FILE_ARTIFACT_KIND = "execution_file";
export const FILE_OUTPUT_LIMITS = Object.freeze({
  files: 5,
  fileBytes: 128 * 1024,
  totalBytes: 512 * 1024,
  workspaceBytes: 128 * 1024 * 1024,
  retentionDays: 7,
});
const extensions = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".yaml",
  ".yml",
  ".py",
  ".js",
  ".ts",
  ".sql",
  ".sh",
  ".xml",
  ".html",
]);
export class FileOutputError extends Error {
  constructor(
    readonly code:
      | "artifact_outputs_disabled"
      | "artifact_output_invalid"
      | "artifact_limit_exceeded",
  ) {
    super(code);
    this.name = "FileOutputError";
  }
}
export function validOutputPath(path: string): boolean {
  return (
    path.length <= 240 &&
    /^\/workspace\/outputs\/(?:[A-Za-z0-9][A-Za-z0-9_-]{0,40}\/){0,4}[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u.test(
      path,
    ) &&
    extensions.has(extname(path).toLowerCase())
  );
}
export type PendingFileOutput = Readonly<{
  id: string;
  producerVersionId: number;
  filename: string;
  content: string;
  byteSize: number;
  sha256: string;
  expiresAt: string;
}>;
export function fileDescriptor(file: PendingFileOutput): AgentArtifact {
  return {
    kind: FILE_ARTIFACT_KIND,
    id: file.id,
    data: {
      filename: file.filename,
      mimeType: "application/octet-stream",
      byteSize: file.byteSize,
      sha256: file.sha256,
      expiresAt: file.expiresAt,
    },
  };
}

/** Shared bounded live collector, not graph state or persistence. Members submit
 * only their own completed workspace. No default capture of scratch/history. */
export class FileOutputCollector {
  private readonly selected: PendingFileOutput[] = [];
  private bytes = 0;
  constructor(private readonly enabled: boolean) {}
  capture(
    producerVersionId: number,
    allowed: boolean,
    paths: readonly string[],
    state: unknown,
  ): AgentArtifact[] {
    if (!paths.length) return [];
    if (!this.enabled || !allowed)
      throw new FileOutputError("artifact_outputs_disabled");
    if (
      !Number.isSafeInteger(producerVersionId) ||
      producerVersionId <= 0 ||
      new Set(paths).size !== paths.length
    )
      throw new FileOutputError("artifact_output_invalid");
    if (paths.length + this.selected.length > FILE_OUTPUT_LIMITS.files)
      throw new FileOutputError("artifact_limit_exceeded");
    const files =
      state && typeof state === "object" && !Array.isArray(state)
        ? (state as Record<string, unknown>)
        : {};
    const additions: PendingFileOutput[] = [];
    let size = 0;
    for (const path of paths) {
      if (!validOutputPath(path) || !Object.hasOwn(files, path))
        throw new FileOutputError("artifact_output_invalid");
      const file = files[path] as { content?: unknown } | undefined;
      const raw =
        Array.isArray(file?.content) &&
        file.content.every((line) => typeof line === "string")
          ? file.content.join("\n")
          : file?.content;
      if (
        typeof raw !== "string" ||
        Buffer.from(raw, "utf8").toString("utf8") !== raw ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)
      )
        throw new FileOutputError("artifact_output_invalid");
      if (Buffer.byteLength(raw) > FILE_OUTPUT_LIMITS.fileBytes)
        throw new FileOutputError("artifact_limit_exceeded");
      const content = redactToolData(raw) as string;
      const byteSize = Buffer.byteLength(content);
      size += byteSize;
      if (
        byteSize > FILE_OUTPUT_LIMITS.fileBytes ||
        size + this.bytes > FILE_OUTPUT_LIMITS.totalBytes
      )
        throw new FileOutputError("artifact_limit_exceeded");
      additions.push(
        Object.freeze({
          id: randomUUID(),
          producerVersionId,
          filename: basename(path),
          content,
          byteSize,
          sha256: createHash("sha256").update(content).digest("hex"),
          expiresAt: new Date(
            Date.now() + FILE_OUTPUT_LIMITS.retentionDays * 86400000,
          ).toISOString(),
        }),
      );
    }
    this.selected.push(...additions);
    this.bytes += size;
    return additions.map(fileDescriptor);
  }
  forResult(artifacts: readonly AgentArtifact[]): PendingFileOutput[] {
    const ids = new Set(
      artifacts
        .filter((file) => file.kind === FILE_ARTIFACT_KIND)
        .map((file) => file.id),
    );
    return this.selected.filter((file) => ids.has(file.id));
  }
  fromMember(
    artifacts: readonly AgentArtifact[],
    producerVersionId: number,
  ): AgentArtifact[] {
    return artifacts
      .filter((artifact) => artifact.kind === FILE_ARTIFACT_KIND)
      .map((artifact) => {
        const file = this.selected.find(
          (file) =>
            file.id === artifact.id &&
            file.producerVersionId === producerVersionId,
        );
        if (
          !file ||
          JSON.stringify(fileDescriptor(file)) !== JSON.stringify(artifact)
        )
          throw new FileOutputError("artifact_output_invalid");
        return fileDescriptor(file);
      });
  }
}
