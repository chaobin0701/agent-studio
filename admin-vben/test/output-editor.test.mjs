import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaFields,fieldsSchema,OUTPUT_TEMPLATES} from '../apps/web-ele/src/views/resources/output-editor.ts';
const simple={type:'object',title:'Root retained',description:'Description retained',properties:{count:{type:'integer',description:'Confirmed count',enum:[1,2]}},required:['count'],additionalProperties:false};
test('fields round-trip every represented keyword without dropping root annotations',()=>{
 const rows=schemaFields(simple);assert.equal(rows.length,1);assert.deepEqual(fieldsSchema(simple,rows),{additionalProperties:false,description:'Description retained',properties:{count:{description:'Confirmed count',enum:[1,2],type:'integer'}},required:['count'],title:'Root retained',type:'object'});
 assert.throws(()=>fieldsSchema(simple,[{...rows[0],name:''}]));assert.throws(()=>fieldsSchema(simple,[{...rows[0],enumText:'["wrong type"]'}]));
});
test('nested, nullable, constrained or open schemas remain source-only, never silently simplify',()=>{
 for(const field of [{type:'array',items:{type:'string'}},{type:['string','null']},{type:'string',minLength:3},{type:'object',properties:{x:{type:'string'}}}])assert.equal(schemaFields({type:'object',properties:{value:field}}),undefined);
 assert.equal(schemaFields({...simple,additionalProperties:true}),undefined);
});
test('all output templates are valid; simple extraction is field-editable',()=>{
 for(const item of OUTPUT_TEMPLATES)assert.doesNotThrow(()=>fieldsSchema(item.schema,schemaFields(item.schema)??[]));
 assert.ok(schemaFields(OUTPUT_TEMPLATES[0].schema));
});

test('delayed parent v-model echoes preserve source formatting and field buffers; invalid source never commits',async()=>{
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),{runInNewContext}=await import('node:vm');
 const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url)),ts=require('typescript'),{ref,computed,watch,nextTick}=require('vue'),contract=require('@agent-studio/output-contract');
 const model=ref({mode:'json',schema:simple}),emits=[];let pending;
 const raw=readFileSync(new URL('../apps/web-ele/src/views/resources/OutputContractEditor.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,'');
 const compiled=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context={api:{},ref,computed,watch,defineProps:()=>({disabled:false}),defineModel:()=>computed({get:()=>model.value,set:v=>{pending=v}}),defineEmits:()=>(...args)=>emits.push(args),...contract,schemaFields,fieldsSchema,OUTPUT_TEMPLATES};
 runInNewContext(compiled+';api={source,rows,setView,updateRows,valid};',context);
 const page=context.api,original=' { "properties": { "count": {"type": "integer"} }, "required": ["count"], "type": "object" } ';
 page.source.value=original;await nextTick();assert.ok(pending);model.value=pending;await nextTick();assert.equal(page.source.value,original);
 page.setView('fields');const rows=page.rows.value;rows[0].description='A field being typed';page.updateRows();await nextTick();model.value=pending;await nextTick();assert.equal(page.rows.value,rows);assert.equal(page.rows.value[0].description,'A field being typed');
 const saved=model.value;pending=undefined;page.source.value='{broken';await nextTick();assert.equal(page.valid.value,false);assert.equal(pending,undefined);assert.equal(model.value,saved);assert.equal(emits.at(-1)[1],false);
});
