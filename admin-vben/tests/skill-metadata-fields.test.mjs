import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {readSkillMetadata,updateSkillMetadata} from '../apps/web-ele/src/views/resources/skill/metadata-fields.ts';
const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const {parse}=require('yaml'),{computed,ref}=require('vue'),ts=require('typescript');
const source='# existing guidance\nname: example-skill\ndescription: old purpose # preserve inline comment\nlicense: MIT\nmetadata:\n  owner: operations\ncustom-field:\n  - keep-me\nallowed-tools: read_only_lookup\n';
test('daily Skill fields edit only name/description, preserving comments and all technical metadata',()=>{
 assert.deepEqual(readSkillMetadata(source),{name:'example-skill',description:'old purpose'});
 const updated=updateSkillMetadata(source,'description','New: purpose # literal');
 assert.deepEqual(parse(updated),{...parse(source),description:'New: purpose # literal'});
 assert.match(updated,/# existing guidance/);assert.match(updated,/# preserve inline comment/);
 assert.deepEqual(parse(updateSkillMetadata(updated,'name','new-skill')),{...parse(source),description:'New: purpose # literal',name:'new-skill'});
});
test('malformed, duplicate, non-map and aliased YAML cannot be silently rewritten by the simple form',()=>{
 for(const invalid of ['name: [','name: first\nname: second','- not-a-map','name: &name example\ndescription: *name']){
  assert.equal(readSkillMetadata(invalid),undefined);assert.throws(()=>updateSkillMetadata(invalid,'name','replacement'));
 }
 assert.deepEqual(readSkillMetadata('name: ""\ndescription: ""'),{name:'',description:''},'required fields remain editable while semantic validation prevents publication');
});
test('the actual Skill form setters preserve source and never mutate readonly/history content',()=>{
 const component=readFileSync(new URL('../apps/web-ele/src/views/resources/skill/fields.vue',import.meta.url),'utf8');
 const script=component.slice(component.indexOf('const metadata ='),component.indexOf('let adopting ='));
 const compiled=ts.transpileModule(script,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context={computed,readSkillMetadata,updateSkillMetadata,frontmatter:ref(source),props:{disabled:false}};
 runInNewContext(`${compiled}\nglobalThis.fields={portableName,description};`,context);
 context.fields.description.value='New purpose';assert.equal(parse(context.frontmatter.value).description,'New purpose');assert.equal(parse(context.frontmatter.value)['allowed-tools'],'read_only_lookup');
 const saved=context.frontmatter.value;context.props.disabled=true;context.fields.portableName.value='cannot-change';assert.equal(context.frontmatter.value,saved);
});
