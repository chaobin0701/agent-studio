import assert from 'node:assert/strict';
import test from 'node:test';
import { embedWithProfile, embeddingProfileSchema } from '../dist/documents/profile-embedding.js';

const profile = embeddingProfileSchema.parse({ provider:'openai-compatible',baseUrl:'https://embedding.example.invalid/v1',model:'fixture',dimensions:2 });
const runtime = { embedding:{ baseUrl:profile.baseUrl,apiKey:'fixture-only',connections:{} } };
test('OpenAI-compatible embedding sorts batch indexes and uses the configured credential', async (t) => {
  t.mock.method(globalThis,'fetch',async (url,options) => {
    assert.equal(url,`${profile.baseUrl}/embeddings`);
    assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body).input,['first','second']);
    return Response.json({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]});
  });
  assert.deepEqual(await embedWithProfile(profile,['first','second'],runtime),[[1,0],[0,1]]);
});
test('embedding rejects credential redirection, malformed vectors and duplicate indexes', async (t) => {
  const fetchMock = t.mock.method(globalThis,'fetch',async()=>Response.json({data:[{index:0,embedding:[1,0]},{index:0,embedding:[1,0]}]}));
  await assert.rejects(embedWithProfile({...profile,baseUrl:'http://127.0.0.1'},['test'],runtime));
  await assert.rejects(embedWithProfile({...profile,secretRef:'jwt_secret'},['test'],runtime));
  assert.equal(fetchMock.mock.callCount(),0);
  await assert.rejects(embedWithProfile(profile,['one','two'],runtime));
  fetchMock.mock.mockImplementation(async()=>Response.json({data:[{index:0,embedding:[0,0]}]}));
  await assert.rejects(embedWithProfile(profile,['one'],runtime));
});
test('multimodal embeddings use one request per independent input',async(t)=>{
  let count=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    count++; assert.ok(url.endsWith('/embeddings/multimodal'));
    assert.equal(JSON.parse(options.body).input.length,1);
    return Response.json({data:{embedding:[1,0]}});
  });
  await embedWithProfile({...profile,provider:'volcengine-multimodal'},['one','two'],runtime);
  assert.equal(count,2);
});
