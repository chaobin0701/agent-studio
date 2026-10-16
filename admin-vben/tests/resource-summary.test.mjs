import test from 'node:test';
import assert from 'node:assert/strict';
import {agentCopySource,resourceSummary} from '../apps/web-ele/src/views/resources/resource-summary.ts';
test('Agent copies the effective immutable version, never a newer unfinished draft',()=>{
 const row={name:'Stable',currentVersionId:1,versions:[{id:2,status:'draft',name:'Unpublished'},{id:1,status:'published',name:'Stable'}]};
 assert.deepEqual(agentCopySource(row),{versionId:1,name:'Stable',published:true});
 assert.equal(agentCopySource({...row,currentVersionId:99}),undefined);
 assert.deepEqual(agentCopySource({...row,currentVersionId:null}),{versionId:2,name:'Unpublished',published:false});
 assert.equal(agentCopySource({versions:[]}),undefined);
});
test('reusable resource list facts distinguish publication, saved drafts and actual changes',()=>{
 const row={hasUnpublishedChanges:false,versions:[{id:2,status:'draft',description:'new instructions'},{id:1,status:'published',description:'current instructions'}]};
 assert.deepEqual(resourceSummary(row),{description:'current instructions',state:'published'});
 assert.equal(resourceSummary({...row,hasUnpublishedChanges:true}).state,'changed');
 assert.deepEqual(resourceSummary({versions:[row.versions[0]]}),{description:'new instructions',state:'draft'});
});
