import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Client} from 'pg';

test('Agent current-version migration preserves production, falls back predictably and leaves immutable history intact', {skip:process.env.KB_INTEGRATION!=='1'},async()=>{
  const c=new Client({host:process.env.POSTGRES_HOST??'127.0.0.1',port:Number(process.env.POSTGRES_PORT??5433),user:process.env.POSTGRES_USER??'grounded',password:process.env.POSTGRES_PASSWORD,database:process.env.POSTGRES_DB??'agent_studio'});
  await c.connect();
  try {
    await c.query('BEGIN');
    const schema=`agent_version_${randomUUID().replaceAll('-','')}`;
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`SET LOCAL search_path TO "${schema}", public`);
    const dir=new URL('../migrations/',import.meta.url),files=(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort();
    const migration='0048_agent_current_version.sql';
    for(const file of files.filter(f=>f<migration))await c.query((await readFile(new URL(file,dir),'utf8')).split('-- Down Migration')[0]);
    const fixtures=[];
    for(const key of ['prod_preferred','test_fallback','dev_fallback','published_fallback','draft_only']) {
      const r=(await c.query("INSERT INTO agent_resources(kind,resource_key,name) VALUES('agent',$1,$1) RETURNING id::int",[key])).rows[0].id;
      const versions=[];
      for(let n=1;n<=3;n++)versions.push((await c.query('INSERT INTO agent_resource_versions(resource_id,version,status,config) VALUES($1,$2,$3,$4) RETURNING id::int',[r,n,key==='draft_only'?'draft':'published',JSON.stringify({fixture:key,version:n})])).rows[0].id);
      const envs=key==='prod_preferred'?['prod','test','dev']:key==='test_fallback'?['test','dev']:key==='dev_fallback'?['dev']:[];
      for(let n=0;n<envs.length;n++)await c.query('INSERT INTO agent_environment_bindings(agent_id,environment,version_id) VALUES($1,$2,$3)',[r,envs[n],versions[n]]);
      fixtures.push({r,versions,key,expected:envs.length?versions[0]:key==='draft_only'?null:versions[2]});
    }
    const before=(await c.query('SELECT id,config,status FROM agent_resource_versions ORDER BY id')).rows;
    const oldBindings=(await c.query('SELECT * FROM agent_environment_bindings ORDER BY agent_id,environment')).rows;
    await c.query((await readFile(new URL(migration,dir),'utf8')).split('-- Down Migration')[0]);
    for(const f of fixtures)assert.equal((await c.query('SELECT current_version_id::int FROM agent_resources WHERE id=$1',[f.r])).rows[0].current_version_id,f.expected,f.key);
    assert.deepEqual((await c.query('SELECT id,config,status FROM agent_resource_versions ORDER BY id')).rows,before);
    assert.deepEqual((await c.query('SELECT * FROM agent_environment_bindings ORDER BY agent_id,environment')).rows,oldBindings);
    await c.query('SAVEPOINT invalid_current');
    await assert.rejects(c.query('UPDATE agent_resources SET current_version_id=$2 WHERE id=$1',[fixtures[4].r,fixtures[4].versions[0]]),e=>e.code==='23503');
    await c.query('ROLLBACK TO SAVEPOINT invalid_current');
    const metadata=(await readFile(new URL('0054_resource_version_metadata.sql',dir),'utf8'));
    await c.query(metadata.split('-- Down Migration')[0]);
    assert.deepEqual((await c.query('SELECT id,config,status FROM agent_resource_versions ORDER BY id')).rows,before,'metadata migration preserves immutable configuration and publication status');
    for(const f of fixtures){
      const rows=(await c.query('SELECT display_name,updated_at FROM agent_resource_versions WHERE resource_id=$1',[f.r])).rows;
      assert.ok(rows.every(v=>v.display_name===f.key&&v.updated_at instanceof Date));
    }
    await c.query('SAVEPOINT immutable_name');
    await assert.rejects(c.query("UPDATE agent_resource_versions SET display_name='Changed' WHERE id=$1",[fixtures[0].versions[0]]),/immutable/);
    await c.query('ROLLBACK TO SAVEPOINT immutable_name');
    await c.query("UPDATE agent_resources SET name='Renamed resource' WHERE id=$1",[fixtures[0].r]);
    assert.equal((await c.query('SELECT display_name FROM agent_resource_versions WHERE id=$1',[fixtures[0].versions[0]])).rows[0].display_name,fixtures[0].key,'resource metadata never renames historical snapshots');
    const legacy=(await c.query("INSERT INTO agent_resource_versions(resource_id,version,config) VALUES($1,4,'{}') RETURNING display_name,updated_at",[fixtures[0].r])).rows[0];
    assert.equal(legacy.display_name,'Renamed resource','old clients that omit metadata still insert valid drafts');
    assert.ok(legacy.updated_at instanceof Date);
    await c.query(metadata.split('-- Down Migration')[1]);
    assert.equal((await c.query('SELECT count(*)::int AS count FROM agent_resource_versions')).rows[0].count,before.length+1,'down migration preserves every version');
  } finally {await c.query('ROLLBACK');await c.end();}
});
