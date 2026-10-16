import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const ts=require('typescript'),{computed,ref}=require('vue');
function evaluate(path,start,end,configuration,names){
  const source=readFileSync(new URL(path,import.meta.url),'utf8');
  const code=ts.transpileModule(source.slice(source.indexOf(start),source.indexOf(end)),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const context={computed,config:ref(configuration)};
  runInNewContext(`${code}\nglobalThis.page={${names}};`,context);
  return {...context,page:context.page};
}
test('Agent budget switches preserve numeric values and the state of independent limits',()=>{
  const f=evaluate('../apps/web-ele/src/views/resources/fields.vue','const taskBudget','const memberChoices',{executionLimits:{maxModelCalls:7,maxToolCalls:9,maxTotalTokens:23000}},'setTaskLimitEnabled,taskBudget');
  f.page.setTaskLimitEnabled('maxTotalTokens',false);
  assert.equal(f.config.value.executionLimits.maxTotalTokens,23000);
  assert.deepEqual(JSON.parse(JSON.stringify(f.config.value.executionLimits.enabled)),{maxModelCalls:true,maxToolCalls:true,maxTotalTokens:false});
  f.page.setTaskLimitEnabled('maxTotalTokens',true);
  assert.equal(f.config.value.executionLimits.maxTotalTokens,23000);
});
test('an Agent without a custom task budget does not implicitly enable all budgets when adding one',()=>{
  const f=evaluate('../apps/web-ele/src/views/resources/fields.vue','const taskBudget','const memberChoices',{},'setTaskLimitEnabled,taskBudget');
  assert.equal(f.page.taskBudget.value.enabled.maxTotalTokens,false);
  f.page.setTaskLimitEnabled('maxToolCalls',true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.config.value.executionLimits.enabled)),{maxModelCalls:false,maxToolCalls:true,maxTotalTokens:false});
});
test('application switches keep previous values, and disabled daily tokens can be re-enabled without another settings screen',()=>{
  const f=evaluate('../apps/web-ele/src/views/integrations/fields.vue','const limits','const selected',{requestsPerMinute:23,concurrency:4,dailyRequests:231,dailyTokenLimit:12000},'setLimitEnabled,limitEnabled');
  f.page.setLimitEnabled('dailyRequests',false);
  assert.equal(f.config.value.dailyRequests,231);
  assert.equal(f.page.limitEnabled('dailyRequests'),false);
  f.page.setLimitEnabled('dailyRequests',true);
  assert.equal(f.config.value.dailyRequests,231);
  assert.equal(f.page.limitEnabled('concurrency'),true);
});
