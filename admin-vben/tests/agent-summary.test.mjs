import assert from 'node:assert/strict';
import test from 'node:test';
import {agentSummary} from '../apps/web-ele/src/views/resources/agent-summary.ts';
const published={id:1,status:'published',name:'Current Agent',responsibility:'current task',mode:'single',modelPlanVersionId:7};
const draft={id:2,status:'draft',name:'Draft Agent',responsibility:'unfinished task',mode:'multi',modelPlanVersionId:8};
const models=[{id:7,name:'Current model'},{id:8,name:'New model'}];
test('all Agent list facts consistently come from the effective version',()=>{
 const row={name:'Current Agent',currentVersionId:1,hasUnpublishedChanges:true,versions:[draft,published]};
 assert.deepEqual(agentSummary(row,models),{name:'Current Agent',responsibility:'current task',mode:'single',model:'Current model',state:'changed'});
 assert.equal(agentSummary({...row,hasUnpublishedChanges:false},models).state,'published','opening an identical working draft does not announce unpublished changes');
});
test('unpublished Agents use their draft, while broken current pointers never silently fall back',()=>{
 const row={name:'Initial name',versions:[draft,published]};
 assert.equal(agentSummary(row,models).name,'Draft Agent');assert.equal(agentSummary(row,models).state,'draft');
 const broken=agentSummary({...row,currentVersionId:9},models);assert.equal(broken.state,'missing');assert.notEqual(broken.responsibility,draft.responsibility);assert.notEqual(broken.model,'New model');
});
