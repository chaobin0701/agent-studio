import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toolFetch } = require('../dist/tool-management/network.js');

test('restricted tool transport handles cancellation, empty replies and bounded bodies', async t => {
  const previous = process.env.AGENT_TOOL_ALLOWED_HOSTS;
  process.env.AGENT_TOOL_ALLOWED_HOSTS = '127.0.0.1';
  const server = createServer((request, response) => {
    if (request.url === '/empty') { response.writeHead(204); response.end(); return; }
    if (request.url === '/large') { response.end(Buffer.alloc(4 * 1024 * 1024 + 1)); return; }
    if (request.url === '/stream') {
      response.writeHead(200, {'content-type':'text/event-stream'});
      response.write('data: first\n\n');
      const timer = setInterval(() => response.write('data: next\n\n'), 1);
      response.on('close', () => clearInterval(timer));
      return;
    }
    response.end('still alive');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (previous === undefined) delete process.env.AGENT_TOOL_ALLOWED_HOSTS; else process.env.AGENT_TOOL_ALLOWED_HOSTS = previous; });
  const empty = await toolFetch(base + '/empty'); assert.equal(empty.status, 204); assert.equal(empty.body, null);
  for (let i = 0; i < 20; i++) {
    const response = await toolFetch(base + '/stream');
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
    const inFlight = reader.read();
    await reader.cancel();
    assert.equal((await inFlight).done, true);
  }
  const large = await toolFetch(base + '/large');
  await assert.rejects(large.arrayBuffer(), error => error.code === 'tool_response_too_large');
  assert.equal(await (await toolFetch(base + '/')).text(), 'still alive');
});
