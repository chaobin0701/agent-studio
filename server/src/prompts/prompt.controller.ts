import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { PromptService } from "./prompt.service";
@Controller("admin/prompts")
@UseGuards(AdminAuthGuard, PermissionGuard)
export class PromptController {
  constructor(private readonly prompts: PromptService) {}
  @Get() @RequirePermission("prompts.read", "prompts.manage") list() {
    return this.prompts.list();
  }
  @Get("versions/:left/diff/:right")
  @RequirePermission("prompts.read", "prompts.manage")
  diff(
    @Param("left", ParseIntPipe) left: number,
    @Param("right", ParseIntPipe) right: number,
  ) {
    return this.prompts.diff(left, right);
  }
  @Get(":id") @RequirePermission("prompts.read", "prompts.manage") get(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.prompts.get(id);
  }
  @Get(":id/usage") @RequirePermission("prompts.read", "prompts.manage") usage(
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.prompts.usage(id);
  }
  @Post(":id/preview")
  @RequirePermission("prompts.read", "prompts.manage")
  preview(@Param("id", ParseIntPipe) id: number, @Body() b: unknown) {
    return this.prompts.preview(id, b);
  }
  @Post() @RequirePermission("prompts.manage") create(
    @Req() r: AdminRequest,
    @Body() b: unknown,
  ) {
    return this.prompts.create(r.admin!.id, b);
  }
  @Post(":id/versions") @RequirePermission("prompts.manage") version(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.prompts.createVersion(r.admin!.id, id, b);
  }
  @Post("versions/:id/clone") @RequirePermission("prompts.manage") clone(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.prompts.clone(r.admin!.id, id);
  }
  @Post("versions/:id/draft") @RequirePermission("prompts.manage") draft(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.prompts.prepareDraft(r.admin!.id, id);
  }
  @Post("versions/:id/review") @RequirePermission("prompts.manage") review(
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.prompts.review(id, b);
  }
  @Patch("versions/:id") @RequirePermission("prompts.manage") update(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: unknown,
  ) {
    return this.prompts.updateDraft(r.admin!.id, id, b);
  }
  @Post("versions/:id/render")
  @RequirePermission("prompts.read", "prompts.manage")
  render(
    @Param("id", ParseIntPipe) id: number,
    @Body() b: { resourceId?: number; variables?: Record<string, unknown> },
  ) {
    return this.prompts.render(Number(b.resourceId), id, b.variables ?? {});
  }
  @Post("versions/:id/publish") @RequirePermission("prompts.manage") publish(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() b?: Record<string, unknown>,
  ) {
    return this.prompts.publish(
      r.admin!.id,
      id,
      b && Object.keys(b).length ? b : undefined,
    );
  }
  @Post("versions/:id/rollout") @RequirePermission("prompts.manage") rollout(
    @Req() r: AdminRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() b: { environment?: string },
  ) {
    return this.prompts.rollout(r.admin!.id, id, b.environment ?? "dev");
  }
}
