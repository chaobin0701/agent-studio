import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

test('PostgreSQL: application switches preserve existing quotas, default new applications off and reject invalid policy shapes', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const client=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});
  const schema=`optional_limit_test_${randomUUID().replaceAll('-','')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}",public`);
    await client.query('CREATE TABLE integration_apps(id integer PRIMARY KEY,daily_token_limit bigint)');
    await client.query('INSERT INTO integration_apps VALUES(1,NULL),(2,1000)');
    const sql=(await readFile(new URL('../migrations/0057_optional_application_limits.sql',import.meta.url),'utf8')).split('-- Down Migration')[0];
    await client.query(sql);
    const rows=(await client.query('SELECT * FROM integration_apps ORDER BY id')).rows;
    assert.deepEqual(rows[0].limit_settings,{requestsPerMinute:true,concurrency:true,dailyRequests:true,dailyTokenLimit:false});
    assert.equal(rows[1].limit_settings.dailyTokenLimit,true);
    assert.equal(rows[1].daily_token_limit,'1000');
    const created=(await client.query('INSERT INTO integration_apps(id,daily_token_limit) VALUES(3,500) RETURNING limit_settings')).rows[0];
    assert.deepEqual(created.limit_settings,{requestsPerMinute:false,concurrency:false,dailyRequests:false,dailyTokenLimit:false});
    for(const policy of [{},[],{...created.limit_settings,dailyRequests:'false'},{...created.limit_settings,extra:true}]){
      await client.query('SAVEPOINT invalid_policy');
      await assert.rejects(client.query('UPDATE integration_apps SET limit_settings=$1 WHERE id=3',[JSON.stringify(policy)]),error=>error.code==='23514');
      await client.query('ROLLBACK TO SAVEPOINT invalid_policy');
    }
  } finally {await client.query('ROLLBACK');await client.end();}
});
