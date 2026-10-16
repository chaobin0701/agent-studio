import assert from 'node:assert/strict';
import test from 'node:test';
import {parseDocument} from 'yaml';
import {registerHooks} from 'node:module';
// Vite resolves extensionless TS imports; mirror that one resolution in this Node test.
registerHooks({resolve(specifier,context,nextResolve){
 return nextResolve(specifier === './frontmatter' && context.parentURL?.endsWith('/create-document.ts') ? './frontmatter.ts' : specifier,context);
}});
const {createSkillDocument,skillCreateKey}=await import('../src/views/resources/skill/create-document.ts');
import {frontmatterSection} from '../src/views/resources/skill/frontmatter.ts';

test('three-field creation generates standard YAML and leaves body truly empty',()=>{
 const result=createSkillDocument(' order_support ', ' 核实订单异常，在售后咨询时使用。 ');
 assert.equal(result.key,'order_support');
 const section=frontmatterSection(result.document,'skill');
 assert.deepEqual(parseDocument(section.yaml).toJS(),{name:'order-support',description:'核实订单异常，在售后咨询时使用。'});
 assert.equal(section.body,'');assert.doesNotMatch(result.document,/license|compatibility|metadata|allowed-tools|任务指导/);
 assert.equal(skillCreateKey('order-support').key,'order_support');
});

test('description is safely serialized, including colons, quotes and newlines',()=>{
 const description='处理范围：订单\n说明: "确认后再执行"\nname: not-an-injected-name';
 const result=createSkillDocument('order_support',description),section=frontmatterSection(result.document,'skill');
 const yaml=parseDocument(section.yaml).toJS();assert.equal(yaml.name,'order-support');assert.equal(yaml.description,description);
});

test('invalid identifiers or empty/overlong descriptions cannot create a draft',()=>{
 for(const key of ['', 'Name', '../file', 'name__bad', 'name-', 'a'.repeat(65)]) assert.throws(()=>createSkillDocument(key,'描述'),/Key/);
 assert.throws(()=>createSkillDocument('valid','   '),/描述/);
 assert.throws(()=>createSkillDocument('valid','x'.repeat(1025)),/1024/);
});

test('import confirmation preserves body, optional metadata and comments while applying form values',()=>{
 const imported='---\nname: old-skill\ndescription: old\nlicense: MIT # retain\nmetadata:\n  author: original\n  agent-studio-key: old_key\ncustom-note: hello\n---\n\n# 原始指导\n\n执行原有流程。\n';
 const result=createSkillDocument('new_support','新的使用时机',imported),section=frontmatterSection(result.document,'skill');
 const yaml=parseDocument(section.yaml).toJS();
 assert.equal(yaml.name,'new-support');assert.equal(yaml.description,'新的使用时机');assert.equal(yaml.license,'MIT');
 assert.equal(yaml.metadata.author,'original');assert.equal(yaml.metadata['agent-studio-key'],'new_support');assert.equal(yaml['custom-note'],'hello');
 assert.match(result.document,/# retain/);assert.equal(section.body,'\n# 原始指导\n\n执行原有流程。\n');
});
