import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSchema,normalizeContract,resolveContract,validateStructured,OutputContractError,parseJson,schemaExample} from '@agent-studio/output-contract';
import {agentSchema} from '../dist/agent-management/resource.types.js';
import {outputTask,agentOutputContract,preflightOutput} from '../dist/ai/agent/output-contract.js';
import {publicIntegrationError} from '../dist/integrations/quota-error.js';
const schema={type:'object',properties:{count:{type:'integer',description:'Number of confirmed items',minimum:0},items:{type:'array',items:{type:'object',properties:{name:{type:['string','null'],description:'Known name'}},required:['name']},maxItems:8}},required:['count','items']};
test('canonical nested schema defaults disallow extras, retains descriptions and never mutates source',()=>{
 const before=structuredClone(schema),s=normalizeSchema(schema);
 assert.equal(s.additionalProperties,false);assert.equal(s.properties.items.items.additionalProperties,false);assert.equal(s.properties.count.description,schema.properties.count.description);assert.deepEqual(before,schema);
 const other={required:['items','count'],properties:{items:{...schema.properties.items},count:{...schema.properties.count}},type:'object',additionalProperties:false};
 assert.deepEqual(normalizeSchema(other),s);assert.equal(agentOutputContract({mode:'json',schema},3).schemaHash,agentOutputContract({mode:'json',schema:other},3).schemaHash);
});
test('unsupported keywords, missing items, bad required, contradictory constraints, enum types and bounds reject with paths',()=>{
 for(const [bad,path] of [
  [{type:'object',properties:{actions:{type:'array'}}},'$.properties.actions.items'],
  [{type:'object',anyOf:[]},'$.anyOf'],
  [{type:'object',properties:{name:{type:'string',pattern:'(a+)+$'}}},'$.properties.name.pattern'],
  [{type:'object',properties:{a:{type:'string',minLength:5,maxLength:2}}},'$.properties.a'],
  [{type:'object',properties:{a:{type:'integer',minimum:0.1,maximum:0.2}}},'$.properties.a'],
  [{type:'object',properties:{a:{type:'number',minimum:2,exclusiveMaximum:2}}},'$.properties.a'],
  [{type:'object',properties:{a:{type:'integer',enum:['1']}}},'$.properties.a.enum'],
  [{type:'object',required:['missing']},'$.required'],
  [{type:'object',properties:{a:{$ref:'file:///private'}}},'$.properties.a.type'],
 ])assert.throws(()=>normalizeSchema(bad),e=>e instanceof OutputContractError&&e.issues[0].path===path);
});
test('literal property names are not schema keywords, null union works',()=>{
 const s={type:'object',properties:{pattern:{type:['string','null']}},required:['pattern']};
 assert.deepEqual(validateStructured(s,{pattern:null}),[]);
});
test('strict result validation never strips fields, coerces primitive types, or supplies defaults',()=>{
 const valid={count:1,items:[{name:null}]};assert.deepEqual(validateStructured(schema,valid),[]);
 for(const value of [{count:'1',items:[]},{items:[]},{count:1,items:[],extra:true},{count:1,items:[{name:'a',extra:1}]}]){
  const original=structuredClone(value);assert.ok(validateStructured(schema,value).length);assert.deepEqual(value,original);
 }
});
test('legacy unset, explicit text, versioned JSON and caller conflict are distinct',()=>{
 assert.deepEqual(resolveContract(undefined),{mode:'text',source:'legacy'});
 assert.equal(resolveContract(undefined,schema).source,'request');
 assert.equal(resolveContract({mode:'json',schema},schema).source,'agent');
 assert.throws(()=>resolveContract({mode:'text'},schema),e=>e.code==='output_contract_conflict');
 assert.throws(()=>preflightOutput({mode:'text'},3,schema),e=>e.getStatus()===400&&e.getResponse().code==='output_contract_conflict');
 const config={responsibility:'General',promptVersionId:1,modelPlanVersionId:1,toolVersionIds:[],skillVersionIds:[],knowledgeBaseIds:[],runtime:{}};
 assert.equal(Object.hasOwn(agentSchema.parse(config),'output'),false);
 assert.deepEqual(agentSchema.parse({...config,output:{mode:'text'}}).output,{mode:'text'});
 assert.equal(agentSchema.safeParse({...config,output:{mode:'json',schema:{type:'object',pattern:'x'}}}).success,false);
});
test('resolved request contract records hash and version, source remains caller for legacy',()=>{
 const pinned=outputTask(undefined,42,schema);assert.equal(pinned.outputContract.source,'request');assert.equal(pinned.outputContract.agentVersionId,42);assert.match(pinned.outputContract.schemaHash,/^[a-f0-9]{64}$/);assert.ok(pinned.outputSchema);
 assert.equal('outputSchema' in outputTask({mode:'text'},42),false);
});
test('JSON syntax reports line/column; examples are local and pass the same validator',()=>{
 assert.match(parseJson('{\n"x":,\n}').error,/第 2 行/);
 assert.deepEqual(validateStructured(schema,schemaExample(schema)),[]);
 assert.equal(schemaExample({type:'object',properties:{items:{type:'array',minItems:1000000000,items:{type:'string'}}},required:['items']}),undefined);
});
test('bounded safe public failures expose issue paths, not result bodies',()=>{
 const result=publicIntegrationError(new OutputContractError('output_validation_failed',[{path:'$.count',message:'字段类型不匹配'}]));
 assert.equal(result.status,502);assert.equal(result.code,'output_validation_failed');assert.deepEqual(result.issues,[{path:'$.count',message:'字段类型不匹配'}]);
});
