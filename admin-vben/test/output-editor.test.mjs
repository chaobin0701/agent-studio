import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {normalizeSchema}=createRequire(new URL('../apps/web-ele/package.json',import.meta.url))('@agent-studio/output-contract');
import {schemaFields,fieldsSchema,EMPTY_OUTPUT_SCHEMA,addField,addSuggestedFollowUpsField,copyField,changeFieldType} from '../apps/web-ele/src/views/resources/output-editor.ts';
const simple={type:'object',title:'Root retained',description:'Description retained',properties:{count:{type:'integer',description:'Confirmed count',enum:[1,2]}},required:['count'],additionalProperties:false};
test('fields round-trip every represented keyword without dropping root annotations',()=>{
 const rows=schemaFields(simple);assert.equal(rows.length,1);assert.deepEqual(fieldsSchema(simple,rows),{additionalProperties:false,description:'Description retained',properties:{count:{description:'Confirmed count',enum:[1,2],type:'integer'}},required:['count'],title:'Root retained',type:'object'});
 assert.throws(()=>fieldsSchema(simple,[{...rows[0],name:''}]));assert.throws(()=>fieldsSchema(simple,[{...rows[0],enumText:'["wrong type"]'}]));
});
const nested={type:'object',title:'Root',properties:{
 profile:{type:['object','null'],title:'Keep title',description:'简介',properties:{name:{type:'string',minLength:2,maxLength:20}},required:['name'],additionalProperties:true},
 records:{type:'array',minItems:0,maxItems:3,items:{type:'object',properties:{score:{type:'number',minimum:0,exclusiveMaximum:10}},required:['score']}},
 tags:{type:'array',items:{type:['string','null'],enum:['a',null]}}
},required:['records']};
test('nested objects, object arrays, string arrays, nullable fields and source-only rules round-trip losslessly',()=>{
 const rows=schemaFields(nested);
 assert.deepEqual(fieldsSchema(nested,rows),normalizeSchema(nested));
 rows[0].children[0].description='姓名';rows[1].children[0].children[0].schema.maximum=8;
 const result=fieldsSchema(nested,rows);
 assert.equal(result.properties.profile.additionalProperties,true);
 assert.equal(result.properties.profile.title,'Keep title');
 assert.equal(result.properties.profile.properties.name.minLength,2);
 assert.equal(result.properties.records.items.properties.score.exclusiveMaximum,10);
 assert.equal(result.properties.records.items.properties.score.maximum,8);
});
test('rename, delete, copy and nullability preserve each parent required list',()=>{
 const rows=schemaFields(nested),profile=rows.find(r=>r.name==='profile');
 profile.children[0].name='displayName';
 profile.required=false;profile.nullable=true;
 let result=fieldsSchema(nested,rows);
 assert.deepEqual(result.properties.profile.required,['displayName']);
 assert.deepEqual(result.properties.profile.type,['object','null']);
 assert.equal(result.required.includes('profile'),false);
 const copy=copyField(profile.children,profile.children[0]);assert.notEqual(copy.id,profile.children[0].id);
 profile.children.shift();
 result=fieldsSchema(nested,rows);
 assert.deepEqual(result.properties.profile.required,['displayName_copy']);
 assert.equal(result.properties.profile.properties.displayName,undefined);
});
test('new fields and explicit type changes use only the supported subset',()=>{
 const rows=schemaFields(EMPTY_OUTPUT_SCHEMA),created=addField(rows);
 created.type='array';changeFieldType(created);
 created.children[0].type='object';changeFieldType(created.children[0]);
 addField(created.children[0].children).name='title';
 assert.equal(fieldsSchema(EMPTY_OUTPUT_SCHEMA,rows).properties.field_1.items.properties.title.type,'string');
 created.children[0].type='boolean';changeFieldType(created.children[0]);
 assert.deepEqual(fieldsSchema(EMPTY_OUTPUT_SCHEMA,rows).properties.field_1.items,{type:'boolean'});
 assert.equal(schemaFields({type:'object',properties:{x:{type:'string',pattern:'a'}}}),undefined);
});
test('suggested follow-ups are an optional bounded string array in the existing custom schema',()=>{
 const base={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
 const rows=schemaFields(base);addSuggestedFollowUpsField(rows);
 const schema=fieldsSchema(base,rows);
 assert.deepEqual(schema.required,['answer']);
 assert.equal(schema.properties.suggestedFollowUps.type,'array');
 assert.equal(schema.properties.suggestedFollowUps.maxItems,3);
 assert.equal(schema.properties.suggestedFollowUps.items.type,'string');
 assert.equal(schema.properties.suggestedFollowUps.items.maxLength,120);
 assert.equal(schema.additionalProperties,false);
 assert.deepEqual(fieldsSchema(schema,schemaFields(schema)),schema);
});

test('delayed parent v-model echoes preserve source formatting and field buffers; invalid source never commits',async()=>{
 const {readFileSync}=await import('node:fs'),{createRequire}=await import('node:module'),{runInNewContext}=await import('node:vm');
 const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url)),ts=require('typescript'),{ref,computed,watch,nextTick}=require('vue'),contract=require('@agent-studio/output-contract');
 const model=ref({mode:'json',schema:simple}),emits=[];let pending;
 const raw=readFileSync(new URL('../apps/web-ele/src/views/resources/OutputContractEditor.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\n/gm,'');
 const compiled=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const context={api:{},ref,computed,watch,defineProps:()=>({disabled:false}),defineModel:()=>computed({get:()=>model.value,set:v=>{pending=v}}),defineEmits:()=>(...args)=>emits.push(args),...contract,schemaFields,fieldsSchema,EMPTY_OUTPUT_SCHEMA,addSuggestedFollowUpsField,copyField,changeFieldType};
 runInNewContext(compiled+';api={source,rows,setView,updateRows,addFollowUpsField,valid};',context);
 const page=context.api,original=' { "properties": { "count": {"type": "integer"} }, "required": ["count"], "type": "object" } ';
 page.source.value=original;await nextTick();assert.ok(pending);model.value=pending;await nextTick();assert.equal(page.source.value,original);
 page.setView('fields');const rows=page.rows.value;rows[0].description='A field being typed';page.updateRows();await nextTick();model.value=pending;await nextTick();assert.equal(page.rows.value,rows);assert.equal(page.rows.value[0].description,'A field being typed');
 const saved=model.value;pending=undefined;page.source.value='{broken';await nextTick();assert.equal(page.valid.value,false);assert.equal(pending,undefined);assert.equal(model.value,saved);assert.equal(emits.at(-1)[1],false);
 page.source.value=JSON.stringify(saved.schema);await nextTick();page.addFollowUpsField();await nextTick();
 assert.equal(pending.schema.properties.suggestedFollowUps.items.maxLength,120);
 assert.equal(pending.schema.properties.suggestedFollowUps.maxItems,3);
 assert.equal(pending.schema.required.includes('suggestedFollowUps'),false);
});
