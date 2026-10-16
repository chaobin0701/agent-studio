import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const require=createRequire(new URL('../apps/web-ele/package.json',import.meta.url));
const vue=require('vue'),ts=require('typescript');
const {parse,compileTemplate}=require('vue/compiler-sfc');
const source=readFileSync(new URL('../apps/web-ele/src/views/resources/agent-detail.vue',import.meta.url),'utf8');
const {descriptor}=parse(source);
const compiled=compileTemplate({source:descriptor.template.content,filename:'agent-detail.vue',id:'workbench'});
assert.deepEqual(compiled.errors,[]);
const output=ts.transpileModule(compiled.code,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};
runInNewContext(output,{require,exports});

test('the actual Agent workbench template preserves both editors when switching narrow views or resizing',async()=>{
 const {h,ref,defineComponent,createRenderer,nextTick,onMounted,onBeforeUnmount}=vue;
 const instances={},counts={fields:0,trial:0},removed=[];
 const probe=kind=>defineComponent({setup(){const buffer=ref(kind==='trial'?'unfinished task and result':'configuration buffer');instances[kind]=buffer;onMounted(()=>counts[kind]++);onBeforeUnmount(()=>removed.push(kind));return ()=>h('div',buffer.value);}});
 const components=Object.fromEntries([...descriptor.template.content.matchAll(/<([A-Z]\w+)/g)].map(([,name])=>[name,defineComponent({setup(_,{slots,attrs}){return ()=>h('div',attrs,slots.default?.());}})]));
 components.RunPanel=probe('trial');components.Fields=probe('fields');
 components.ElDialog=defineComponent({setup(){return ()=>null;}});
 const state={wide:ref(false),mobile:ref('configuration'),section:ref('basic'),detail:{id:1,key:'test',enabled:true,versions:[]},current:null,status:'saved',busy:false,testing:false,editable:true,active:{id:2,status:'draft',revision:1,version:2},selected:2,name:ref('Test'),config:ref({}),canExecute:true,canManage:true,saveState:{conflict:false,error:'',saving:false},result:null,validName:true,hasChanges:true,access:{accessCodes:[]},prepare:async()=>true,resources:[],options:{},history:ref(false),emit(){},router:{push(){}}};
 const renderer=createRenderer({
  createElement:tag=>({tag,children:[],props:{}}),createText:text=>({text}),createComment:text=>({comment:text}),
  setText:(node,text)=>{node.text=text;},setElementText:(node,text)=>{node.text=text;node.children=[];},
  patchProp:(node,key,_old,value)=>{node.props[key]=value;},
  parentNode:node=>node.parent,nextSibling:node=>{const siblings=node.parent?.children??[];return siblings[siblings.indexOf(node)+1]??null;},
  insert(node,parent,anchor=null){if(node.parent){const siblings=node.parent.children;siblings.splice(siblings.indexOf(node),1);}const at=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(at<0?parent.children.length:at,0,node);node.parent=parent;},
  remove(node){if(node.parent){const siblings=node.parent.children;siblings.splice(siblings.indexOf(node),1);node.parent=undefined;}},
 });
 const app=renderer.createApp(defineComponent({components,setup:()=>state,render:exports.render}));
 const root={children:[]};app.mount(root);await nextTick();
 const trial=instances.trial,fields=instances.fields;
 assert.deepEqual(counts,{fields:1,trial:1});
 trial.value='typed task, streamed answer';fields.value='edited configuration';
 for(const [wide,mobile] of [[false,'preview'],[false,'configuration'],[true,'configuration'],[false,'preview']]){
  state.wide.value=wide;state.mobile.value=mobile;await nextTick();
  assert.equal(instances.trial,trial);assert.equal(instances.fields,fields);
  assert.equal(trial.value,'typed task, streamed answer');assert.equal(fields.value,'edited configuration');
  assert.deepEqual(counts,{fields:1,trial:1});assert.deepEqual(removed,[]);
 }
 const walk=node=>[node,...(node.children??[]).flatMap(walk)];
 const panels=walk(root).filter(node=>node.props?.size);
 assert.equal(panels[0].props.size,'0%');assert.equal(panels[0].props.inert,true);
 assert.equal(panels[1].props.size,'100%');assert.equal(panels[1].props.inert,false);
 app.unmount();assert.equal(removed.length,2);
});
