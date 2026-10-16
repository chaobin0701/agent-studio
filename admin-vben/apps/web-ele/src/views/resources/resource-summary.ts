type Version = {
  id: number;
  status: string;
  name?: string;
  description?: string;
};
type Resource = {
  name?: string;
  currentVersionId?: number | null;
  hasUnpublishedChanges?: boolean;
  versions?: Version[];
};
/** Facts for reusable resources; publication does not upgrade pinned Agent dependencies. */
export function resourceSummary(resource: Resource | Record<string, any>) {
  const versions: Version[] = Array.isArray(resource.versions)
    ? resource.versions
    : [];
  const published = versions.find((v) => v.status === "published");
  const draft = versions.find((v) => v.status === "draft");
  return {
    description: (published ?? draft)?.description ?? "",
    state: !published
      ? "draft"
      : resource.hasUnpublishedChanges
        ? "changed"
        : "published",
  } as const;
}
/** Copy the effective Agent, or its saved draft if it has never been published. */
export function agentCopySource(resource: Resource | Record<string, any>) {
  const versions: Version[] = Array.isArray(resource.versions)
    ? resource.versions
    : [];
  const version = resource.currentVersionId
    ? versions.find(
        (v) => v.id === resource.currentVersionId && v.status === "published",
      )
    : (versions.find((v) => v.status === "draft") ??
      versions.find((v) => v.status === "published"));
  if (!version || !Number.isSafeInteger(version.id) || version.id <= 0)
    return undefined;
  return {
    versionId: version.id,
    name: version.name ?? resource.name ?? "Agent",
    published: version.status === "published",
  };
}
