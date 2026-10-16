import { ref } from 'vue';
import { defineStore } from 'pinia';
import { requestClient } from '#/api/request';
export interface Workspace { id:number; name:string; description:string; enabled:boolean; role:string }
export const useWorkspaceStore = defineStore('workspace', () => {
 const items=ref<Workspace[]>([]); const id=ref<number>(); const generation=ref(0); const switching=ref(false);
 async function refresh(){ items.value=await requestClient.get<Workspace[]>('/workspaces'); }
 async function initialize(){
  if(id.value) return;
  await refresh(); const saved=Number(localStorage.getItem('agent-studio-workspace'));
  id.value=items.value.find(w=>w.enabled&&w.id===saved)?.id ?? items.value.find(w=>w.enabled)?.id;
 }
 function select(value:number){ id.value=value; generation.value++; localStorage.setItem('agent-studio-workspace',String(value)); }
 function $reset(){items.value=[];id.value=undefined;generation.value++;switching.value=false;localStorage.removeItem('agent-studio-workspace');}
 return {items,id,generation,switching,refresh,initialize,select,$reset};
});
