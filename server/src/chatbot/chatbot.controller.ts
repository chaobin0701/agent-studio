import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { AdminAuthGuard } from "../admin/admin-auth.guard";
import { PermissionGuard } from "../admin/permission.guard";
import { RequirePermission } from "../admin/permission.decorator";
import type { AdminRequest } from "../admin/admin.types";
import { LegacyWebsiteGuard } from "../integrations/integration.guards";
import type { IntegrationRequest } from "../integrations/integration.types";
import { NoStoreInterceptor } from "../integrations/no-store.interceptor";
import { ConversationService } from "../chat/conversation.service";
import { sendArtifact } from "../artifacts/artifact.controller";
import { ChatbotService } from "./chatbot.service";
import { streamChatbot } from "./chatbot-stream";
import type { ChatbotPrincipal } from "./chatbot.types";

function attachmentResponse(
  response: Response,
  file: Awaited<ReturnType<ChatbotService["downloadAttachment"]>>,
) {
  response.setHeader(
    "Content-Type",
    file.kind === "image" ? "image/jpeg" : "application/octet-stream",
  );
  response.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  response.setHeader("Cache-Control", "private, no-store");
  return response.send(file.content);
}

@Controller("admin/chatbot")
@UseGuards(AdminAuthGuard, PermissionGuard)
@RequirePermission("agent_chat.use")
@UseInterceptors(NoStoreInterceptor)
export class AdminChatbotController {
  constructor(private readonly chat: ChatbotService) {}
  private principal(r: AdminRequest): ChatbotPrincipal {
    return { adminId: r.admin!.id };
  }
  @Post("sessions/:id/attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 0 },
    }),
  )
  upload(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.chat.upload(this.principal(r), id, file);
  }
  @Get("sessions/:id/attachments/:fileId")
  async attachment(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("fileId", ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ) {
    return attachmentResponse(
      response,
      await this.chat.downloadAttachment(this.principal(r), id, fileId),
    );
  }
  @Get("options") options(@Req() r: AdminRequest) {
    return this.chat.options(this.principal(r));
  }
  @Get("sessions") list(@Req() r: AdminRequest, @Query("q") q?: string) {
    return this.chat.list(this.principal(r), q);
  }
  @Post("sessions") create(@Req() r: AdminRequest, @Body() body: unknown) {
    return this.chat.create(this.principal(r), body);
  }
  @Get("sessions/:id") detail(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.chat.detail(this.principal(r), id);
  }
  @Patch("sessions/:id") rename(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.chat.rename(this.principal(r), id, body);
  }
  @Delete("sessions/:id") remove(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.chat.remove(this.principal(r), id);
  }
  @Post("sessions/:id/messages") @HttpCode(200) async send(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const principal = this.principal(r),
      run = await this.chat.start(principal, id, body);
    if (run.stream)
      return streamChatbot(
        this.chat,
        principal,
        id,
        run.runId,
        response,
        run.replayed,
      );
    return response
      .status(202)
      .json(await this.chat.turn(principal, id, run.runId));
  }
  @Get("sessions/:id/runs/:runId") run(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
  ) {
    return this.chat.turn(this.principal(r), id, runId);
  }
  @Get("sessions/:id/runs/:runId/events") events(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Res() response: Response,
  ) {
    return streamChatbot(
      this.chat,
      this.principal(r),
      id,
      runId,
      response,
      true,
    );
  }
  @Post("sessions/:id/runs/:runId/cancel") cancel(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
  ) {
    return this.chat.cancel(this.principal(r), id, runId);
  }
  @Post("sessions/:id/runs/:runId/interactions/:interactionId/respond") respond(
    @Req() r:AdminRequest,
    @Param("id",ParseUUIDPipe) id:string,
    @Param("runId",ParseUUIDPipe) runId:string,
    @Param("interactionId",ParseUUIDPipe) interactionId:string,
    @Body() value:unknown,
  ) { return this.chat.respond(this.principal(r),id,runId,interactionId,value); }
  @Get("sessions/:id/runs/:runId/artifacts/:fileId") async artifact(
    @Req() r: AdminRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Param("fileId", ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ) {
    return sendArtifact(
      response,
      await this.chat.artifact(this.principal(r), id, runId, fileId),
    );
  }
}

// /chat keeps the existing HttpOnly cookie path and application-scoped Origin guard.
@Controller("chat/bot")
@UseGuards(LegacyWebsiteGuard)
@UseInterceptors(NoStoreInterceptor)
export class WebsiteChatbotController {
  constructor(
    private readonly chat: ChatbotService,
    private readonly conversations: ConversationService,
  ) {}
  private async principal(
    r: IntegrationRequest,
    response: Response,
  ): Promise<ChatbotPrincipal> {
    const owner = await this.conversations.session(r, response);
    return { identity: { ...r.integration, ownerId: owner }, owner };
  }
  @Post("sessions/:id/attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 5242880, files: 1, fields: 0 },
    }),
  )
  async upload(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.chat.upload(await this.principal(r, response), id, file);
  }
  @Get("sessions/:id/attachments/:fileId")
  async attachment(
    @Req() r: IntegrationRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("fileId", ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ) {
    return attachmentResponse(
      response,
      await this.chat.downloadAttachment(
        await this.principal(r, response),
        id,
        fileId,
      ),
    );
  }
  @Get("options") async options(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.chat.options(await this.principal(r, response));
  }
  @Get("sessions") async list(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Query("q") q?: string,
  ) {
    return this.chat.list(await this.principal(r, response), q);
  }
  @Post("sessions") async create(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    return this.chat.create(await this.principal(r, response), body);
  }
  @Get("sessions/:id") async detail(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.chat.detail(await this.principal(r, response), id);
  }
  @Patch("sessions/:id") async rename(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.chat.rename(await this.principal(r, response), id, body);
  }
  @Delete("sessions/:id") async remove(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.chat.remove(await this.principal(r, response), id);
  }
  @Post("sessions/:id/messages") @HttpCode(200) async send(
    @Req() r: IntegrationRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const principal = await this.principal(r, response),
      run = await this.chat.start(principal, id, body);
    if (run.stream)
      return streamChatbot(
        this.chat,
        principal,
        id,
        run.runId,
        response,
        run.replayed,
      );
    return response
      .status(202)
      .json(await this.chat.turn(principal, id, run.runId));
  }
  @Get("sessions/:id/runs/:runId") async run(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
  ) {
    return this.chat.turn(await this.principal(r, response), id, runId);
  }
  @Get("sessions/:id/runs/:runId/events") async events(
    @Req() r: IntegrationRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Res() response: Response,
  ) {
    return streamChatbot(
      this.chat,
      await this.principal(r, response),
      id,
      runId,
      response,
      true,
    );
  }
  @Post("sessions/:id/runs/:runId/cancel") async cancel(
    @Req() r: IntegrationRequest,
    @Res({ passthrough: true }) response: Response,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
  ) {
    return this.chat.cancel(await this.principal(r, response), id, runId);
  }
  @Post("sessions/:id/runs/:runId/interactions/:interactionId/respond") async respond(
    @Req() r:IntegrationRequest,
    @Res({passthrough:true}) response:Response,
    @Param("id",ParseUUIDPipe) id:string,
    @Param("runId",ParseUUIDPipe) runId:string,
    @Param("interactionId",ParseUUIDPipe) interactionId:string,
    @Body() value:unknown,
  ) { return this.chat.respond(await this.principal(r,response),id,runId,interactionId,value); }
  @Get("sessions/:id/runs/:runId/artifacts/:fileId") async artifact(
    @Req() r: IntegrationRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Param("fileId", ParseUUIDPipe) fileId: string,
    @Res() response: Response,
  ) {
    return sendArtifact(
      response,
      await this.chat.artifact(
        await this.principal(r, response),
        id,
        runId,
        fileId,
      ),
    );
  }
}
