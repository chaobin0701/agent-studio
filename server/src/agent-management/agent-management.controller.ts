import { Body, Query, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { resourceState } from './resource-lifecycle';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { PermissionGuard } from '../admin/permission.guard';
import { RequirePermission } from '../admin/permission.decorator';
import type { AdminRequest } from '../admin/admin.types';
import { parseSkillDocument, exportSkillDocument, skillDocumentDiagnostics, exportSkillBundle } from './skill-document';
import { skillBundleSchema } from './skill-resources';
import { z } from 'zod';
import { keySchema, skillSchema } from './resource.types';
import { AgentManagementService } from './agent-management.service';
@Controller('admin/agent-resources')
@UseGuards(AdminAuthGuard,PermissionGuard)
export class AgentManagementController {
 constructor(private readonly management:AgentManagementService){}
 @Post('skill-bundle') @RequirePermission('agent_config.manage') async parseSkillBundle(@Body() b:unknown) {
  const parsed=skillBundleSchema.safeParse(b);
  if(!parsed.success)throw new BadRequestException(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'));
  try { return await this.management.parseSkillDocument(parsed.data.document,{},parsed.data.resources); }
  catch(e) { throw new BadRequestException(e instanceof z.ZodError?e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'):e instanceof Error?e.message:'Skill 包格式错误'); }
 }
 @Get() @RequirePermission('agent_config.read','agent_config.manage') list(@Query('state') state?:string){return this.management.list(resourceState(state));}
 @Get('options') @RequirePermission('agent_config.read','agent_config.manage') options(){return this.management.options();}
 @Post('skill-document') @RequirePermission('agent_config.manage') async parseSkill(@Body() b:{document?:unknown;resourceKey?:unknown;toolMapping?:unknown;knowledgeBaseMapping?:unknown}){
  if(typeof b?.document!=='string')throw new BadRequestException('需要 Skill 文档');
  try{return await this.management.parseSkillDocument(b.document,{...(b.resourceKey!==undefined?{resourceKey:b.resourceKey}:{}),...(b.toolMapping!==undefined?{toolMapping:b.toolMapping}:{}),...(b.knowledgeBaseMapping!==undefined?{knowledgeBaseMapping:b.knowledgeBaseMapping}:{})});}
  catch(e){throw new BadRequestException(e instanceof z.ZodError?e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'):e instanceof Error?e.message:'Skill 文档格式错误');}
 }
 @Post('skill-document/export') @RequirePermission('agent_config.manage') exportSkill(@Body() b:unknown){
  const parsed=z.object({key:keySchema,name:z.string().min(1).max(160),config:skillSchema,format:z.enum(['platform','portable']).default('platform')}).strict().safeParse(b);
  if(!parsed.success)throw new BadRequestException(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'));
  const {key,name,config,format}=parsed.data;
  try{const bundle=exportSkillBundle(key,name,config,format);return {document:bundle.document,resources:bundle.resources,bundle,diagnostics:skillDocumentDiagnostics(config)};}catch(e){throw new BadRequestException(e instanceof Error?e.message:'导出失败');}
 }
 @Post('skills/:id/draft') @RequirePermission('agent_config.manage') skillDraft(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.skillDraft(r.admin!.id,id,b);}
 @Post('tools/:id/draft') @RequirePermission('agent_config.manage') toolDraft(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.toolDraft(r.admin!.id,id,b);}
 @Post('agents/:id/draft') @RequirePermission('agent_config.manage') agentDraft(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.agentDraft(r.admin!.id,id,b);}
 @Get('skills/:id/usage') @RequirePermission('agent_config.read','agent_config.manage') skillUsage(@Param('id',ParseIntPipe) id:number){return this.management.skillUsage(id);}
 @Get('versions/:id/skill-document') @RequirePermission('agent_config.read','agent_config.manage') skillDocument(@Param('id',ParseIntPipe) id:number,@Query('format') format?:string){if(format&& !['platform','portable'].includes(format))throw new BadRequestException('未知导出格式');return this.management.skillDocument(id,format as 'platform'|'portable'|undefined);}
 @Get(':id') @RequirePermission('agent_config.read','agent_config.manage') get(@Param('id',ParseIntPipe) id:number){return this.management.get(id);}
 @Get(':id/references') @RequirePermission('agent_config.read','agent_config.manage') references(@Param('id',ParseIntPipe) id:number){return this.management.references(id);}
 @Post(':id/archive') @RequirePermission('agent_config.manage') archive(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.management.lifecycle(r.admin!.id,id,'archive');}
 @Delete(':id') @RequirePermission('agent_config.manage') remove(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.management.lifecycle(r.admin!.id,id,'delete');}
 @Post(':id/restore') @RequirePermission('agent_config.manage') restore(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.management.lifecycle(r.admin!.id,id,'restore');}
 @Post() @RequirePermission('agent_config.manage') create(@Req() r:AdminRequest,@Body() b:unknown){return this.management.create(r.admin!.id,b);}
 @Patch('versions/:id') @RequirePermission('agent_config.manage') update(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.update(r.admin!.id,id,b);}
 @Post('versions/:id/clone') @RequirePermission('agent_config.manage') clone(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b?:{key?:string;name?:string}){return this.management.clone(r.admin!.id,id,b?.key&&b?.name?{key:b.key,name:b.name}:undefined);}
 @Post('versions/:id/test') @RequirePermission('agent_config.manage') test(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.test(r.admin!.id,id,b);}
 @Post('versions/:id/publish') @RequirePermission('agent_config.manage') publish(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number){return this.management.publish(r.admin!.id,id);}
 @Patch(':id/status') @RequirePermission('agent_config.manage') status(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:{enabled?:boolean}){if(typeof b.enabled!=='boolean')throw new BadRequestException('需要 enabled');return this.management.enable(r.admin!.id,id,b.enabled);}
 @Post('application') @RequirePermission('agent_config.manage') bind(@Req() r:AdminRequest,@Body() b:unknown){return this.management.bind(r.admin!.id,b);}
 @Post(':id/activate') @RequirePermission('agent_config.manage') activate(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.activate(r.admin!.id,id,b);}
 @Post(':id/environments') @RequirePermission('agent_config.manage') bindAgent(@Req() r:AdminRequest,@Param('id',ParseIntPipe) id:number,@Body() b:unknown){return this.management.bind(r.admin!.id,b,id);}
}
