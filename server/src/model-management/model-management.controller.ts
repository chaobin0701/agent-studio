import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Delete,
  Header,
  Query,
  Injectable,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import type { AdminRequest } from "../admin/admin.types";
import { DatabaseService } from "../database.service";
import { ModelManagementService } from "./model-management.service";
import { modelKindSchema, type ModelKind } from "./model-management.types";

@Injectable()
export class ModelManagementPermissionGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}
  async canActivate(context: ExecutionContext) {
    const request = context
      .switchToHttp()
      .getRequest<
        AdminRequest & { params: { kind: string }; method: string }
      >();
    const kind = modelKindSchema.safeParse(request.params.kind);
    if (!kind.success) throw new BadRequestException("Invalid model kind");
    const prefix =
      kind.data === "llm" ? "model_profiles" : "embedding_profiles";
    const codes =
      request.method === "GET"
        ? [`${prefix}.read`, `${prefix}.manage`]
        : [`${prefix}.manage`];
    if (!codes.some(code=>request.workspacePermissionCodes?.includes(code))) throw new ForbiddenException("没有此工作空间的模型操作权限");
    return true;
  }
}
@Controller("admin/model-management/:kind")
@UseGuards(AdminAuthGuard, ModelManagementPermissionGuard)
export class ModelManagementController {
  constructor(private readonly service: ModelManagementService) {}
  @Get() list(@Param("kind") kind: ModelKind,@Query('includeRemoved') includeRemoved?:string) {
    return this.service.list(kind,includeRemoved==='true');
  }
  private revealPermission(r:AdminRequest) {
    if(!r.workspacePermissionCodes?.includes('model_credentials.reveal'))throw new ForbiddenException('没有查看模型凭据的权限');
  }
  @Post('accounts/:id/credential/unlock')
  @Header('Cache-Control','no-store')
  unlockCredential(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {
    this.revealPermission(r);return this.service.unlockCredential(r.admin!.id,k,id,body);
  }
  @Post('accounts/:id/credential/reveal')
  @Header('Cache-Control','no-store')
  revealCredential(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {
    this.revealPermission(r);return this.service.revealCredential(r.admin!.id,k,id,body);
  }
  private resourceType(type:string):'accounts'|'deployments'|'plans' {
    if(!['accounts','deployments','plans'].includes(type))throw new BadRequestException('资源类型无效');
    return type as 'accounts'|'deployments'|'plans';
  }
  @Get(':type/:id/references')
  references(@Param('kind') k:ModelKind,@Param('type') type:string,@Param('id',ParseIntPipe) id:number) {
    return this.service.references(k,this.resourceType(type),id);
  }
  @Delete(':type/:id')
  remove(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('type') type:string,@Param('id',ParseIntPipe) id:number) {
    return this.service.remove(r.admin!.id,k,this.resourceType(type),id);
  }
  @Post(':type/:id/restore')
  restore(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('type') type:string,@Param('id',ParseIntPipe) id:number) {
    return this.service.restore(r.admin!.id,k,this.resourceType(type),id);
  }
  @Patch('plans/:id/draft')
  editPlan(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {
    return this.service.savePlanDraft(r.admin!.id,k,id,body);
  }
  @Post('plans/:id/draft')
  workingDraft(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {
    return this.service.workingDraft(r.admin!.id,k,id,body);
  }
  @Post('plans/:id/rollback')
  rollbackPlan(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number,@Body() body:unknown) {
    return this.service.rollbackPlan(r.admin!.id,k,id,body);
  }
  @Post('versions/:id/test-and-publish')
  testAndPublish(@Req() r:AdminRequest,@Param('kind') k:ModelKind,@Param('id',ParseIntPipe) id:number) {
    return this.service.testAndPublish(r.admin!.id,k,id);
  }
  @Post("accounts") account(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Body() b: unknown,
  ) {
    return this.service.createAccount(r.admin!.id, k, b);
  }
  @Get("accounts/:id/models") models(
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.listModels(k, id);
  }
  @Patch("accounts/:id") updateAccount(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.service.updateAccount(r.admin!.id, k, id, b);
  }
  @Post("deployments") deployment(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Body() b: unknown,
  ) {
    return this.service.saveDeployment(r.admin!.id, k, null, b);
  }
  @Patch("deployments/:id") updateDeployment(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.service.saveDeployment(r.admin!.id, k, id, b);
  }
  @Post("deployments/:id/test") testDeployment(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.testDeployment(r.admin!.id, k, id);
  }
  @Post("plans") plan(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Body() b: unknown,
  ) {
    return this.service.createPlan(r.admin!.id, k, b);
  }
  @Patch("versions/:id") draft(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.service.updateDraft(r.admin!.id, k, id, b);
  }
  @Post("versions/:id/clone") clone(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.clone(r.admin!.id, k, id);
  }
  @Post("versions/:id/test") test(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.testVersion(r.admin!.id, k, id);
  }
  @Post("versions/:id/publish") publish(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.publish(r.admin!.id, k, id);
  }
  @Post("versions/:id/activate") activate(
    @Req() r: AdminRequest,
    @Param("kind") k: ModelKind,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.service.activate(r.admin!.id, k, id);
  }
}
