import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {copyWorkspaceResource} from '../dist/workspaces/workspace-copy.js';
import {currentWorkspaceId} from '../dist/workspaces/workspace-context.js';

function fixture() {
 const document='---\nname: portable-support\ndescription: 可移植指导\nallowed-kbs: [999999]\n---\n\n核实后回答\n';
 const rows=new Map([
  [10,{kind:'agent',resource_key:'support',name:'Agent',config:{promptVersionId:30,modelPlanVersionId:null,toolVersionIds:[],skillVersionIds:[20],knowledgeBaseIds:[40],skillPolicies:[{skillVersionId:20,mode:'restricted',allowedTools:[],allowedKnowledgeBaseIds:[40]}]}}],
  [20,{kind:'skill',resource_key:'portable_support',name:'Skill',config:{document,permissionMode:'agent',description:'指导',instructions:'核实后回答',allowedTools:[],allowedKnowledgeBaseIds:[]}}],
  [30,{prompt_key:'business',name:'Prompt',prompt_type:'system',description:'业务',template:'业务',variables:{}}],
  [40,{name:'KB',description:'KB',draft_config:{},retrieval_config:{}}],
 ]);
 const writes=[],reads=[];let next=100;
 const permissions=['agent_config.read','agent_config.manage','prompts.read','prompts.manage','documents.read','knowledge_bases.manage'];
 const db={
  platformQuery:async(sql,args)=>({rows:sql.includes('FROM workspaces')?[{id:args[1],role:'owner',permission_codes:[]}]:permissions.map(code=>({code}))}),
  transaction:async(work)=>work({query:async(sql,args=[])=>{
   if(currentWorkspaceId()===1) {
    if(sql.startsWith('SET TRANSACTION'))return {rows:[]};
    if(sql.startsWith('SELECT id FROM agent_resource_versions'))return {rows:[{id:args[0]===1?10:20}]};
    reads.push(args[0]);return {rows:rows.has(args[0])?[structuredClone(rows.get(args[0]))]:[]};
   }
   assert.equal(currentWorkspaceId(),2);
   if(sql.startsWith('INSERT INTO audit_logs'))return {rows:[]};
   const id=next++;writes.push({sql,args,id});return {rows:[{id}]};
  }}),
 };
 return {db,writes,reads,document};
}

test('workspace copy remaps Agent resources without copying retired Skill policies',async()=>{
 const f=fixture();await copyWorkspaceResource(f.db,1,1,{targetWorkspaceId:2,kind:'agent',id:1});
 const resources=f.writes.filter(w=>w.sql.startsWith('INSERT INTO agent_resources'));
 const versions=f.writes.filter(w=>w.sql.startsWith('INSERT INTO agent_resource_versions'));
 const skill=versions.find(w=>w.args[0]===resources.find(r=>r.args[0]==='skill').id);
 const agent=JSON.parse(versions.find(w=>w.args[0]===resources.find(r=>r.args[0]==='agent').id).args[1]);
 const kb=f.writes.find(w=>w.sql.startsWith('INSERT INTO knowledge_bases'));
 assert.deepEqual(agent.skillVersionIds,[skill.id]);assert.deepEqual(agent.knowledgeBaseIds,[kb.id]);
 assert.deepEqual(agent.skillPolicies,[]);
 assert.equal(JSON.parse(skill.args[1]).document,f.document);
});

test('copying a portable Skill does not copy knowledge declared in its YAML',async()=>{
 const f=fixture();const out=await copyWorkspaceResource(f.db,1,1,{targetWorkspaceId:2,kind:'skill',id:2});
 assert.equal(out.copied,1);assert.deepEqual(f.reads,[20]);
 assert.equal(f.writes.some(w=>w.sql.startsWith('INSERT INTO knowledge_bases')),false);
 assert.equal(JSON.parse(f.writes.find(w=>w.sql.startsWith('INSERT INTO agent_resource_versions')).args[1]).document,f.document);
});
