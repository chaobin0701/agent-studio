import {
  bigserial,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const admins = pgTable('admins', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  email: varchar('email', { length: 320 }),
  username: varchar('username', { length: 64 }),
  passwordHash: text('password_hash').notNull(),
  sessionVersion: integer('session_version').notNull().default(0),
  displayName: varchar('display_name', { length: 120 }).notNull(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('admins_email_lower_unique').on(sql`lower(${table.email})`), uniqueIndex('admins_username_lower_unique').on(sql`lower(${table.username})`)]);

export const roles = pgTable('roles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: varchar('code', { length: 80 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});


export const permissions = pgTable('permissions', {
  code: varchar('code', { length: 120 }).primaryKey(),
  description: text('description').notNull(),
});

export const adminRoles = pgTable('admin_roles', {
  adminId: bigint('admin_id', { mode: 'number' }).notNull().references(() => admins.id, { onDelete: 'cascade' }),
  roleId: bigint('role_id', { mode: 'number' }).notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.adminId, table.roleId] }),
  index('admin_roles_role_id_idx').on(table.roleId),
]);

export const rolePermissions = pgTable('role_permissions', {
  roleId: bigint('role_id', { mode: 'number' }).notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionCode: varchar('permission_code', { length: 120 }).notNull().references(() => permissions.code, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.roleId, table.permissionCode] }),
  index('role_permissions_permission_code_idx').on(table.permissionCode),
]);

export const auditLogs = pgTable('audit_logs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorAdminId: bigint('actor_admin_id', { mode: 'number' }).notNull().references(() => admins.id, { onDelete: 'restrict' }),
  action: varchar('action', { length: 120 }).notNull(),
  targetType: varchar('target_type', { length: 80 }).notNull(),
  targetId: varchar('target_id', { length: 120 }).notNull(),
  details: jsonb('details').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('audit_logs_created_at_idx').on(table.createdAt),
  index('audit_logs_actor_created_at_idx').on(table.actorAdminId, table.createdAt),
]);

export const knowledgeBases = pgTable('knowledge_bases', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description').notNull().default(''),
  isDefault: boolean('is_default').notNull().default(false),
  enabledForChat: boolean('enabled_for_chat').notNull().default(false),
  draftConfig: jsonb('draft_config').notNull().default({}),
  retrievalConfig: jsonb('retrieval_config').notNull().default({}),
  indexEpoch: integer('index_epoch').notNull().default(0),
  autoDirty: boolean('auto_dirty').notNull().default(false),
  indexError: text('index_error'),
  activeIndexVersionId: bigint('active_index_version_id', { mode: 'number' }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex('knowledge_bases_one_default').on(table.isDefault).where(sql`${table.isDefault}`)]);

export const documents = pgTable('documents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  knowledgeBaseId: bigint('knowledge_base_id', { mode: 'number' }).notNull().references(() => knowledgeBases.id, { onDelete: 'restrict' }),
  title: varchar('title', { length: 200 }).notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  storageKey: varchar('storage_key', { length: 100 }).notNull().unique(),
  sha256: varchar('sha256', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  uploadedBy: bigint('uploaded_by', { mode: 'number' }).notNull().references(() => admins.id, { onDelete: 'restrict' }),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  extractedText: text('extracted_text'),
  inlineContent: text('inline_content'),
  deletedAt: timestamp('deleted_at',{withTimezone:true}),
  indexRevision: integer('index_revision').notNull().default(1),
  indexPending: boolean('index_pending').notNull().default(false),
  processingEpoch: integer('processing_epoch').notNull().default(0),
  parserVersion: text('parser_version'),
  parserWarnings: jsonb('parser_warnings').notNull().default([]),
  sourceType: text('source_type').notNull().default('file'),
  errorMessage: varchar('error_message', { length: 300 }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('documents_created_at_idx').on(table.createdAt),
  index('documents_knowledge_base_id_idx').on(table.knowledgeBaseId, table.id),
  index('documents_active_status_idx').on(table.status).where(sql`${table.archivedAt} IS NULL`),
]);

export const documentBlocks = pgTable('document_blocks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: bigint('document_id', { mode: 'number' }).notNull().references(() => documents.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  blockType: text('block_type').notNull(),
  headingPath: text('heading_path').notNull(),
  content: text('content').notNull(),
  sourceLocator: jsonb('source_locator').notNull(),
}, (table) => [uniqueIndex('document_blocks_document_id_ordinal_key').on(table.documentId, table.ordinal)]);

export const documentChunks = pgTable('document_chunks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: bigint('document_id', { mode: 'number' }).notNull().references(() => documents.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  headingPath: text('heading_path').notNull().default(''),
  content: text('content').notNull(),
  sourceStartLine: integer('source_start_line').notNull(),
  sourceEndLine: integer('source_end_line').notNull(),
  embedding: vector('embedding', { dimensions: 2048 }),
  embeddingModel: varchar('embedding_model', { length: 120 }),
}, (table) => [
  uniqueIndex('document_chunks_document_id_ordinal_key').on(table.documentId, table.ordinal),
  index('document_chunks_document_id_idx').on(table.documentId),
]);

export const visitorSessions = pgTable('visitor_sessions', {
  id: uuid('id').primaryKey(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  clientType: varchar('client_type', { length: 40 }).notNull().default('browser'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const modelAccounts = pgTable('model_accounts', {
  deletedAt: timestamp('deleted_at', { withTimezone:true }), archivedAt: timestamp('archived_at', { withTimezone:true }),
  id: bigserial('id', { mode: 'number' }).primaryKey(), kind: text('kind').notNull(), name: text('name').notNull(),
  platformKey: text('platform_key').notNull(), baseUrl: text('base_url').notNull(), apiKeyCiphertext: text('api_key_ciphertext'),
  secretRef: text('secret_ref'), keyRevision: integer('key_revision').notNull().default(1), enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const modelDeployments = pgTable('model_deployments', {
  deletedAt: timestamp('deleted_at', { withTimezone:true }), archivedAt: timestamp('archived_at', { withTimezone:true }),
  testResult: jsonb('test_result'), testedAt: timestamp('tested_at', { withTimezone:true }),
  id: bigserial('id', { mode: 'number' }).primaryKey(), kind: text('kind').notNull(), name: text('name').notNull(),
  accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => modelAccounts.id),
  config: jsonb('config').notNull(), enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const modelPlans = pgTable('model_plans', {
  deletedAt: timestamp('deleted_at', { withTimezone:true }), archivedAt: timestamp('archived_at', { withTimezone:true }),
  currentVersionId: bigint('current_version_id', { mode:'number' }),
  id: bigserial('id', { mode: 'number' }).primaryKey(), kind: text('kind').notNull(), name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const modelPlanVersions = pgTable('model_plan_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(), planId: bigint('plan_id', { mode: 'number' }).notNull().references(() => modelPlans.id),
  version: integer('version').notNull(), status: text('status').notNull().default('draft'), config: jsonb('config').notNull(),
  revision: integer('revision').notNull().default(1), testSignature: text('test_signature'), testResult: jsonb('test_result'),
  testedAt: timestamp('tested_at', { withTimezone: true }), publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('model_plan_version_unique').on(table.planId, table.version)]);
export const modelBindings = pgTable('model_bindings', {
  purpose: text('purpose').primaryKey(), versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => modelPlanVersions.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
export const workspaces = pgTable('workspaces', {
  id:bigserial('id',{mode:'number'}).primaryKey(),name:varchar('name',{length:120}).notNull(),
  description:text('description').notNull().default(''),enabled:boolean('enabled').notNull().default(true),
  createdBy:bigint('created_by',{mode:'number'}).references(()=>admins.id),
  defaultEmbeddingPlanVersionId:bigint('default_embedding_plan_version_id',{mode:'number'}).references(()=>modelPlanVersions.id),
  createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
});

export const embeddingProfiles = pgTable('embedding_profiles', {
  platformKey: text('platform_key').notNull().default('custom'), apiKeyCiphertext: text('api_key_ciphertext'),
  modelAccountId: bigint('model_account_id', { mode: 'number' }).references(() => modelAccounts.id),
  modelPlanVersionId: bigint('model_plan_version_id', { mode: 'number' }).unique().references(() => modelPlanVersions.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(), config: jsonb('config').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const llmProfiles = pgTable('llm_profiles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  platformKey: varchar('platform_key', { length: 40 }).notNull(),
  providerKey: varchar('provider_key', { length: 80 }).notNull(),
  adapterType: varchar('adapter_type', { length: 80 }).notNull(),
  baseUrl: text('base_url').notNull(),
  model: varchar('model', { length: 200 }).notNull(),
  apiKeyCiphertext: text('api_key_ciphertext'),
  timeoutMs: integer('timeout_ms').notNull(),
  contextWindowTokens: integer('context_window_tokens').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  structuredOutput: varchar('structured_output', { length: 20 }).notNull(),
  supportsToolCalls: boolean('supports_tool_calls').notNull(),
  supportsStreaming: boolean('supports_streaming').notNull(),
  enabled: boolean('enabled').notNull(),
  isDefault: boolean('is_default').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeIndexVersions = pgTable('knowledge_index_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  knowledgeBaseId: bigint('knowledge_base_id', { mode: 'number' }).notNull().references(() => knowledgeBases.id),
  status: text('status').notNull(), config: jsonb('config').notNull(), embeddingSnapshot: jsonb('embedding_snapshot'),
  autoActivate: boolean('auto_activate').notNull().default(false),
  expectedEpoch: integer('expected_epoch'),
  baseVersionId: bigint('base_version_id',{mode:'number'}),
  inputSnapshot: jsonb('input_snapshot').notNull(), chunkCount: integer('chunk_count').notNull().default(0),
  errorMessage: text('error_message'), createdBy: bigint('created_by', { mode: 'number' }).notNull().references(() => admins.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [uniqueIndex('knowledge_one_build').on(table.knowledgeBaseId).where(sql`${table.status} = 'building'`)]);

const tsvectorType = customType<{ data: string }>({ dataType: () => 'tsvector' });
const unconstrainedVector = customType<{ data: string }>({ dataType: () => 'vector' });
// IDs share the legacy document_chunks sequence; citation IDs cannot collide.
// Composite active-version and parent FKs are enforced by the SQL migrations.
export const indexChunks = pgTable('index_chunks', {
  id: bigint('id', { mode: 'number' }).primaryKey().default(sql`nextval(pg_get_serial_sequence('document_chunks', 'id'))`),
  versionId: bigint('version_id', { mode: 'number' }).notNull().references(() => knowledgeIndexVersions.id),
  documentId: bigint('document_id', { mode: 'number' }).notNull().references(() => documents.id),
  documentTitle: text('document_title').notNull(), originalFilename: text('original_filename').notNull(),
  ordinal: integer('ordinal').notNull(), kind: text('kind').notNull(),
  parentChunkId: bigint('parent_chunk_id', { mode: 'number' }),
  headingPath: text('heading_path').notNull(), content: text('content').notNull(), searchContent: text('search_content').notNull(),
  searchVector: tsvectorType('search_vector').notNull(), sourceLocator: jsonb('source_locator').notNull(),
}, (table) => [uniqueIndex('index_chunks_version_id_document_id_ordinal_key').on(table.versionId,table.documentId,table.ordinal)]);

export const chunkEmbeddings = pgTable('chunk_embeddings', {
  chunkId: bigint('chunk_id', { mode: 'number' }).primaryKey().references(() => indexChunks.id, { onDelete: 'cascade' }),
  embedding: unconstrainedVector('embedding').notNull(), dimensions: integer('dimensions').notNull(),
});

export const faqEntries = pgTable('faq_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  documentId: bigint('document_id', { mode: 'number' }).notNull().unique().references(() => documents.id),
  question: text('question').notNull(), answer: text('answer').notNull(),
  category: text('category').notNull().default(''), source: text('source').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatDisplaySettings = pgTable('chat_display_settings', {
  id: smallint('id').primaryKey(),
  publicProgressEnabled: boolean('public_progress_enabled').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: bigint('updated_by', { mode: 'number' }).references(() => admins.id, { onDelete: 'set null' }),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey(),
  visitorSessionId: uuid('visitor_session_id').notNull().references(() => visitorSessions.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 120 }).notNull().default('新对话'),
  summary: text('summary').notNull().default(''),
  summaryThroughMessageId: bigint('summary_through_message_id', { mode: 'number' }),
  busyUntil: timestamp('busy_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('conversations_visitor_updated_idx').on(table.visitorSessionId, table.updatedAt)]);

export const conversationMessages = pgTable('conversation_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 12 }).notNull(),
  content: text('content').notNull(),
  requestContext: jsonb('request_context').notNull().default({}),
  refused: boolean('refused'),
  citations: jsonb('citations').notNull().default([]),
  toolSteps: jsonb('tool_steps').notNull().default([]),
  progressEvents: jsonb('progress_events').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('conversation_messages_conversation_id_idx').on(table.conversationId, table.id)]);

export const conversationRuns = pgTable('conversation_runs', {
  id: uuid('id').primaryKey(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  clientRequestId: varchar('client_request_id', { length: 120 }).notNull(),
  question: text('question').notNull(),
  requestContext: jsonb('request_context').notNull().default({}),
  status: varchar('status', { length: 20 }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  errorCode: varchar('error_code', { length: 80 }),
  userMessageId: bigint('user_message_id', { mode: 'number' }).references(() => conversationMessages.id, { onDelete: 'set null' }),
  assistantMessageId: bigint('assistant_message_id', { mode: 'number' }).references(() => conversationMessages.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('conversation_runs_conversation_request_key').on(table.conversationId, table.clientRequestId),
  index('conversation_runs_conversation_created_idx').on(table.conversationId, table.createdAt),
  index('conversation_runs_expiry_idx').on(table.status, table.expiresAt),
]);

export const chatTraces = pgTable('chat_traces', {
  id: uuid('id').primaryKey(),
  kind: varchar('kind', { length: 20 }).notNull().default('answer'),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  userMessageId: bigint('user_message_id', { mode: 'number' }).references(() => conversationMessages.id, { onDelete: 'set null' }),
  question: text('question').notNull(),
  contextSnapshot: jsonb('context_snapshot').notNull().default({}),
  model: varchar('model', { length: 120 }),
  rawModelOutput: text('raw_model_output'),
  finalAnswer: text('final_answer'),
  refused: boolean('refused'),
  status: varchar('status', { length: 20 }).notNull(),
  errorCode: varchar('error_code', { length: 80 }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),
  durationMs: integer('duration_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('chat_traces_created_at_idx').on(table.createdAt),
  index('chat_traces_conversation_id_idx').on(table.conversationId, table.createdAt),
]);

export const toolCredentials = pgTable('tool_credentials', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().default(sql`current_workspace_id()`).references(() => workspaces.id),
  name: varchar('name', { length: 120 }).notNull(), kind: varchar('kind', { length: 20 }).notNull(),
  header: varchar('header', { length: 80 }).notNull(), encryptedSecret: text('encrypted_secret').notNull(),
  enabled: boolean('enabled').notNull().default(true), revision: integer('revision').notNull().default(1),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => admins.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export const mcpServers = pgTable('mcp_servers', {
  archivedAt: timestamp('archived_at', {withTimezone:true}), deletedAt: timestamp('deleted_at', {withTimezone:true}),
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().default(sql`current_workspace_id()`).references(() => workspaces.id),
  serverKey: varchar('server_key', { length: 80 }).notNull(), name: varchar('name', { length: 120 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('mcp_servers_workspace_key').on(table.workspaceId, table.serverKey)]);
export const mcpServerVersions = pgTable('mcp_server_versions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspaceId: bigint('workspace_id', { mode: 'number' }).notNull().default(sql`current_workspace_id()`).references(() => workspaces.id),
  serverId: bigint('server_id', { mode: 'number' }).notNull().references(() => mcpServers.id),
  version: integer('version').notNull(), config: jsonb('config').notNull(), catalog: jsonb('catalog').notNull().default([]),
  createdBy: bigint('created_by', { mode: 'number' }).references(() => admins.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('mcp_server_versions_number').on(table.serverId, table.version)]);
