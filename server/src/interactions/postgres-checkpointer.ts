import { BaseCheckpointSaver, WRITES_IDX_MAP, compareWritesSortKeys, writesSortKey, type ChannelVersions, type Checkpoint, type CheckpointMetadata, type CheckpointTuple, type CheckpointListOptions, type PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { DatabaseService } from "../database.service";

type Stored = { namespace: string; checkpoint_id: string; parent_id: string | null; checkpoint_type: string; checkpoint: Buffer; metadata_type: string; metadata: Buffer };
type StoredWrite = { task_id: string; task_path: string; idx: number; channel: string; value_type: string; value: Buffer };
const maxBytes = 4 * 1024 * 1024;

/** Official LangGraph serialization, private workspace-scoped durable storage.
 * Every instance is bound to one host-authorized Run; it cannot open another thread. */
export class PostgresCheckpointSaver extends BaseCheckpointSaver {
  constructor(private readonly db: Pick<DatabaseService, "query" | "transaction">, private readonly runId: string) { super(); }
  private coordinates(config: RunnableConfig) {
    if (config.configurable?.thread_id !== this.runId) throw new TypeError("Checkpoint thread does not match authorized Run");
    const namespace = String(config.configurable?.checkpoint_ns ?? "");
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (namespace.length > 1000 || (checkpointId && checkpointId.length > 200)) throw new RangeError("Invalid checkpoint identity");
    return { namespace, checkpointId };
  }
  private config(namespace: string, checkpointId: string): RunnableConfig {
    return { configurable: { thread_id: this.runId, checkpoint_ns: namespace, checkpoint_id: checkpointId } };
  }
  private async tuple(row: Stored): Promise<CheckpointTuple> {
    const writes = (await this.db.query<StoredWrite>("SELECT task_id,task_path,idx,channel,value_type,value FROM agent_native_checkpoint_writes WHERE run_id=$1 AND namespace=$2 AND checkpoint_id=$3", [this.runId,row.namespace,row.checkpoint_id])).rows;
    writes.sort((a,b) => compareWritesSortKeys(writesSortKey(a.task_path,a.task_id,a.idx),writesSortKey(b.task_path,b.task_id,b.idx)));
    return {
      config: this.config(row.namespace,row.checkpoint_id),
      checkpoint: await this.serde.loadsTyped(row.checkpoint_type,row.checkpoint) as Checkpoint,
      metadata: await this.serde.loadsTyped(row.metadata_type,row.metadata) as CheckpointMetadata,
      ...(row.parent_id ? { parentConfig: this.config(row.namespace,row.parent_id) } : {}),
      pendingWrites: await Promise.all(writes.map(async (write) => [write.task_id,write.channel,await this.serde.loadsTyped(write.value_type,write.value)] as [string,string,unknown])),
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { namespace,checkpointId } = this.coordinates(config);
    const row = (await this.db.query<Stored>("SELECT c.* FROM agent_native_checkpoints c JOIN agent_interaction_threads t ON t.run_id=c.run_id WHERE c.run_id=$1 AND c.namespace=$2 AND ($3::text IS NULL OR c.checkpoint_id=$3) AND t.expires_at>now() AND t.status NOT IN ('cancelled','expired','completed') ORDER BY c.checkpoint_id DESC LIMIT 1",[this.runId,namespace,checkpointId??null])).rows[0];
    return row ? this.tuple(row) : undefined;
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const { namespace } = this.coordinates(config);
    const before = options.before ? this.coordinates(options.before).checkpointId : undefined;
    const limit = Math.max(1,Math.min(200,options.limit??100));
    const rows = (await this.db.query<Stored>("SELECT c.* FROM agent_native_checkpoints c JOIN agent_interaction_threads t ON t.run_id=c.run_id WHERE c.run_id=$1 AND c.namespace=$2 AND ($3::text IS NULL OR c.checkpoint_id<$3) AND t.expires_at>now() AND t.status NOT IN ('cancelled','expired','completed') ORDER BY c.checkpoint_id DESC LIMIT $4",[this.runId,namespace,before??null,limit])).rows;
    for (const row of rows) {
      const tuple = await this.tuple(row);
      if (!options.filter || Object.entries(options.filter).every(([key,value]) => JSON.stringify((tuple.metadata as Record<string,unknown>|undefined)?.[key])===JSON.stringify(value))) yield tuple;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const { namespace,checkpointId: parentId } = this.coordinates(config);
    const [checkpointType,body] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType,meta] = await this.serde.dumpsTyped(metadata);
    if (body.byteLength>maxBytes || meta.byteLength>1024*1024) throw new RangeError("Native checkpoint exceeds private storage limit");
    await this.db.transaction(async (c) => {
      const thread = (await c.query("SELECT run_id FROM agent_interaction_threads WHERE run_id=$1 AND expires_at>now() AND status IN ('running','resuming') FOR UPDATE",[this.runId])).rows[0];
      if (!thread) throw new Error("Checkpoint Run is not active");
      const usage = (await c.query<{n:number}>("SELECT (COALESCE(sum(octet_length(checkpoint)+octet_length(metadata)),0)+(SELECT COALESCE(sum(octet_length(value)),0) FROM agent_native_checkpoint_writes WHERE run_id=$1))::int AS n FROM agent_native_checkpoints WHERE run_id=$1",[this.runId])).rows[0]?.n??0;
      if (usage+body.byteLength+meta.byteLength>16*maxBytes) throw new RangeError("Native checkpoint Run storage exceeded");
      await c.query("INSERT INTO agent_native_checkpoints(run_id,namespace,checkpoint_id,parent_id,checkpoint_type,checkpoint,metadata_type,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(run_id,namespace,checkpoint_id) DO NOTHING",[this.runId,namespace,checkpoint.id,parentId??null,checkpointType,Buffer.from(body),metadataType,Buffer.from(meta)]);
    });
    return this.config(namespace,checkpoint.id);
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath=""): Promise<void> {
    const { namespace,checkpointId } = this.coordinates(config);
    if (!checkpointId || writes.length>200 || taskId.length>200 || taskPath.length>2000) throw new RangeError("Invalid native checkpoint writes");
    const values = await Promise.all(writes.map(async ([channel,value],index) => {
      const [type,data] = await this.serde.dumpsTyped(value);
      if (data.byteLength>maxBytes || channel.length>300) throw new RangeError("Native write exceeds limit");
      return {channel,index:WRITES_IDX_MAP[channel]??index,type,data};
    }));
    await this.db.transaction(async(c) => {
      if (!(await c.query("SELECT run_id FROM agent_interaction_threads WHERE run_id=$1 AND expires_at>now() AND status IN ('running','resuming') FOR UPDATE",[this.runId])).rowCount) throw new Error("Checkpoint Run is not active");
      const bytes=values.reduce((n,value)=>n+value.data.byteLength,0);
      const usage=(await c.query<{n:number}>("SELECT (COALESCE(sum(octet_length(checkpoint)+octet_length(metadata)),0)+(SELECT COALESCE(sum(octet_length(value)),0) FROM agent_native_checkpoint_writes WHERE run_id=$1))::int AS n FROM agent_native_checkpoints WHERE run_id=$1",[this.runId])).rows[0]?.n??0;
      if(usage+bytes>16*maxBytes) throw new RangeError("Native checkpoint Run storage exceeded");
      for (const item of values) await c.query(`INSERT INTO agent_native_checkpoint_writes(run_id,namespace,checkpoint_id,task_id,task_path,idx,channel,value_type,value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(run_id,namespace,checkpoint_id,task_id,idx) ${item.index<0?"DO UPDATE SET channel=EXCLUDED.channel,value_type=EXCLUDED.value_type,value=EXCLUDED.value,task_path=EXCLUDED.task_path":"DO NOTHING"}`,[this.runId,namespace,checkpointId,taskId,taskPath,item.index,item.channel,item.type,Buffer.from(item.data)]);
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    if (threadId!==this.runId) throw new TypeError("Unauthorized checkpoint thread");
    await this.db.transaction(async(c)=>{
      await c.query("SELECT run_id FROM agent_interaction_threads WHERE run_id=$1 FOR UPDATE",[this.runId]);
      await c.query("DELETE FROM agent_native_checkpoint_writes WHERE run_id=$1",[this.runId]);
      await c.query("DELETE FROM agent_native_checkpoints WHERE run_id=$1",[this.runId]);
    });
  }
}
