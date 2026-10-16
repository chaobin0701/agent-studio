import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { compare, hash } from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { validate } from 'class-validator';
import { DatabaseService } from '../dist/database.service.js';
import { AdminManagementService } from '../dist/admin/admin-management.service.js';
import { AdminAuthService } from '../dist/admin/admin-auth.service.js';
import { AdminAuthGuard } from '../dist/admin/admin-auth.guard.js';
import { AdminManagementController } from '../dist/admin/admin-management.controller.js';
import { SetAdminPasswordDto } from '../dist/admin/management.dto.js';
import { sessionVersionMatches } from '../dist/admin/session-version.js';
import { PERMISSION_KEY } from '../dist/admin/permission.decorator.js';
import { WorkspaceService } from '../dist/workspaces/workspace.service.js';

test('password DTO and service reject weak/oversized input before writes', async () => {
  for (const password of ['valid-password-123', 'a'.repeat(72)]) {
    assert.deepEqual(await validate(Object.assign(new SetAdminPasswordDto(), { password })), []);
  }
  for (const password of ['short', 'a'.repeat(73), null]) {
    assert.ok((await validate(Object.assign(new SetAdminPasswordDto(), { password }))).length);
  }
  const service = new AdminManagementService({ platformTransaction() { assert.fail('Invalid password must not reach DB'); } });
  for (const password of ['short', 'a'.repeat(73), '密'.repeat(25), null]) {
    await assert.rejects(service.setPassword(1, 2, password), error => error.getStatus() === 400);
  }
});

test('session revocation preserves old tokens only at initial version and rejects malformed claims', () => {
  assert.equal(sessionVersionMatches(undefined, 0), true);
  assert.equal(sessionVersionMatches(undefined, 1), false);
  assert.equal(sessionVersionMatches(0, 1), false);
  assert.equal(sessionVersionMatches(1, 1), true);
  for (const value of [null, '1', -1, 1.5, {}, NaN]) assert.equal(sessionVersionMatches(value, 1), false);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminManagementController.prototype.setPassword), ['admins.manage']);
  assert.deepEqual(Reflect.getMetadata(PERMISSION_KEY, AdminManagementController.prototype.userWorkspaces), ['admins.manage']);
});

test('non-super administrators cannot reset passwords even with account management permission', async () => {
  let writes = 0;
  const service = new AdminManagementService({ platformTransaction: async fn => fn({ query: async sql => {
    if (sql.includes('pg_advisory')) return { rows: [], rowCount: 1 };
    if (sql.includes('rp.permission_code = $2')) return { rows: [{}], rowCount: 1 };
    if (sql.includes("r.code = 'super_admin'")) return { rows: [], rowCount: 0 };
    writes++; throw Error('Unexpected write');
  } }) });
  await assert.rejects(service.setPassword(1, 2, 'valid-password-123'), error => error.getStatus() === 403);
  assert.equal(writes, 0);
});

test('PostgreSQL password reset, login revocation and owner-scoped workspace authorization', { skip: process.env.KB_INTEGRATION !== '1' }, async () => {
  const root = new Client({ connectionString: process.env.DATABASE_URL });
  await root.connect();
  const schema = `admin_password_test_${randomUUID().replaceAll('-', '')}`;
  let db;
  try {
    await root.query('BEGIN');
    await root.query(`CREATE SCHEMA ${schema}`);
    await root.query(`SET LOCAL search_path TO ${schema},public`);
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter(name => name.endsWith('.sql')).sort()) {
      await root.query((await readFile(new URL(file, dir), 'utf8')).split('-- Down Migration')[0]);
    }
    await root.query('COMMIT');
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = new DatabaseService({ databaseUrl: url.toString() });
    const makeUser = async name => Number((await db.platformQuery('INSERT INTO admins(username,display_name,password_hash) VALUES($1,$1,$2) RETURNING id', [name, await hash('initial-password-123', 4)])).rows[0].id);
    const actor = await makeUser('super-user'), target = await makeUser('target-user'), limited = await makeUser('limited-user'), other = await makeUser('other-owner');
    await db.platformQuery("INSERT INTO admin_roles(admin_id,role_id) SELECT $1,id FROM roles WHERE code='super_admin'", [actor]);
    const roleId = Number((await db.platformQuery("INSERT INTO roles(code,name) VALUES('limited_accounts','Limited') RETURNING id")).rows[0].id);
    await db.platformQuery("INSERT INTO role_permissions(role_id,permission_code) VALUES($1,'admins.manage')", [roleId]);
    await db.platformQuery('INSERT INTO admin_roles(admin_id,role_id) VALUES($1,$2)', [limited, roleId]);
    const management = new AdminManagementService(db), workspaces = new WorkspaceService(db);
    const runtime = { jwt: { secret: 'isolated-test-secret', issuer: 'test', audience: 'test', expiresInSeconds: 600 } };
    const jwt = new JwtService({ secret: runtime.jwt.secret, signOptions: { issuer: 'test', audience: 'test', expiresIn: 600 } });
    const auth = new AdminAuthService(db, jwt, runtime), guard = new AdminAuthGuard(jwt, db, runtime);
    const login = () => auth.login({ email: 'target-user', password: 'updated-password-123' });
    const old = await auth.login({ email: 'target-user', password: 'initial-password-123' });
    const context = token => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${token}` }, path: '/api/admin/admins' }) }) });
    const legacy = await jwt.signAsync({ sub: String(target) });
    assert.equal(await guard.canActivate(context(old.accessToken)), true);
    await assert.rejects(management.setPassword(limited, target, 'updated-password-123'), error => error.getStatus() === 403);
    await assert.rejects(management.setPassword(actor, 9999999, 'updated-password-123'), error => error.getStatus() === 404);
    await management.setPassword(actor, target, 'updated-password-123');
    const stored = (await db.platformQuery('SELECT password_hash,session_version FROM admins WHERE id=$1', [target])).rows[0];
    assert.equal(stored.session_version, 1);
    assert.equal(await compare('updated-password-123', stored.password_hash), true);
    await assert.rejects(auth.login({ email: 'target-user', password: 'initial-password-123' }), error => error.getStatus() === 401);
    for (const token of [old.accessToken, legacy]) await assert.rejects(guard.canActivate(context(token)), error => error.getStatus() === 401);
    const fresh = await login();
    assert.equal(await guard.canActivate(context(fresh.accessToken)), true);
    const audit = (await db.platformQuery("SELECT details FROM audit_logs WHERE action='admin.password_updated' AND target_id=$1", [String(target)])).rows[0].details;
    assert.deepEqual(audit, { sessionsRevoked: true });
    assert.equal(JSON.stringify(audit).includes('password'), false);

    const owned = await workspaces.create(actor, { name: 'Owned' }), privateWorkspace = await workspaces.create(other, { name: 'Private' });
    await workspaces.setMember(other, privateWorkspace.id, { adminId: target, role: 'reader' });
    let result = await management.userWorkspaces(actor, target);
    assert.ok(result.workspaces.some(row => row.id === owned.id && row.role === null));
    assert.equal(result.workspaces.some(row => row.id === privateWorkspace.id), false);
    assert.equal(result.permissions.some(p => /^(admins|roles|workspaces)\./.test(p.code)), false);
    await workspaces.setMember(actor, owned.id, { adminId: target, role: 'custom', permissionCodes: ['documents.read'] });
    result = await management.userWorkspaces(actor, target);
    assert.deepEqual(result.workspaces.find(row => row.id === owned.id).permissionCodes, ['documents.read']);
    const options = await workspaces.memberOptions(actor, owned.id);
    assert.ok(options.accounts.some(row => row.id === target));
    assert.equal(JSON.stringify(options).includes('password_hash'), false);
    await assert.rejects(workspaces.memberOptions(target, owned.id), error => error.getStatus() === 403);
    await assert.rejects(workspaces.setMember(actor, owned.id, { adminId: target, role: 'custom', permissionCodes: ['admins.manage'] }), error => error.getStatus() === 400);
    await assert.rejects(workspaces.setMember(actor, owned.id, { adminId: actor, role: 'reader' }), error => error.getStatus() === 409);
    await workspaces.removeMember(actor, owned.id, target);
    assert.equal((await management.userWorkspaces(actor, target)).workspaces.find(row => row.id === owned.id).role, null);
  } finally {
    if (db) await db.onModuleDestroy();
    await root.query('ROLLBACK');
    await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await root.end();
  }
});
