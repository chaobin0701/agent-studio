/** Dedicated bounded maintenance function, not arbitrary privileged business SQL. */
export async function purgeUnavailableArtifacts(query: {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rows: Array<{ purged: number }> }>;
}) {
  const result = await query.query(
    "SELECT purge_unavailable_execution_artifacts($1) AS purged",
    [200],
  );
  return result.rows[0]?.purged ?? 0;
}
