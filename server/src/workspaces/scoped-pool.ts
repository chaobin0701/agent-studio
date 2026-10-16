import { Pool, type PoolClient } from 'pg';
import { currentWorkspaceId } from './workspace-context';

/** Both Drizzle and handwritten SQL must use the same non-owner RLS boundary.
 * Never reuse a connection's previous workspace, including after rollback. */
export function scopedPool(pool: Pool): Pool {
  const connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE agent_studio_workspace_runtime');
      await client.query("SELECT set_config('app.workspace_id',$1,false)", [String(currentWorkspaceId())]);
    } catch (error) {
      client.release(true);
      throw error;
    }
    let released = false;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'release') return (error?: Error | boolean) => {
          if (released) return;
          released = true;
          // Reset asynchronously before returning this connection to the pool.
          void target.query('RESET ROLE; RESET app.workspace_id').then(
            () => target.release(error), () => target.release(true),
          );
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect') return connect;
      if (property === 'query') return async (...args: any[]) => {
        const client = await connect();
        try { return await (client.query as any)(...args); }
        finally { client.release(); }
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
