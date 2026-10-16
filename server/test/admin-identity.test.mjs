import assert from 'node:assert/strict';
import test from 'node:test';
import { validate } from 'class-validator';
import { hash } from 'bcryptjs';
import { AdminLoginDto, CreateAdminDto } from '../dist/admin/auth.dto.js';
import { AdminAuthService } from '../dist/admin/admin-auth.service.js';
import { AdminManagementService } from '../dist/admin/admin-management.service.js';

test('login DTO accepts email and username, rejects blank and oversized identities', async () => {
  for (const email of ['demo-user', 'chaobin', 'admin@example.com']) {
    assert.deepEqual(await validate(Object.assign(new AdminLoginDto(), { email, password: 'demo123456' })), []);
  }
  for (const email of ['', 'a'.repeat(321)]) {
    assert.ok((await validate(Object.assign(new AdminLoginDto(), { email, password: 'demo123456' }))).length);
  }
});

test('create DTO supports username-only and email accounts; rejects malformed usernames', async () => {
  const base = { displayName: '体验账号', password: 'demo123456', roleIds: [1] };
  for (const identity of [{ username: 'demo-user' }, { username: 'chaobin' }, { email: 'admin@example.com' }, { email: 'admin@example.com', username: 'chaobin' }]) {
    assert.deepEqual(await validate(Object.assign(new CreateAdminDto(), base, identity)), []);
  }
  for (const username of ['ab', 'bad user', '@user', 'user@example.com', 'a'.repeat(65)]) {
    assert.ok((await validate(Object.assign(new CreateAdminDto(), base, { username }))).length);
  }
  assert.ok((await validate(Object.assign(new CreateAdminDto(), base, { username: 'demo-user', password: 'short' }))).length);
});

test('creation without either identity is rejected before database writes', async () => {
  const service = new AdminManagementService({ transaction() { assert.fail('No DB write expected'); } });
  await assert.rejects(service.createAdmin(1, { displayName: 'Invalid', password: 'demo123456', roleIds: [1] }), /Email or username is required/);
});

test('username login keeps bcrypt validation and disabled account rejection; never returns hash', async () => {
  const row = { id: 1, email: null, username: 'demo-user', displayName: '体验账号', disabledAt: null, passwordHash: await hash('demo123456', 4) };
  let query;
  const database = { db: { select() { return { from() { return { where(sql) { query = sql; return { limit: async () => [row] }; } }; } }; } } };
  const service = new AdminAuthService(database, { signAsync: async () => 'signed-test-token' }, { jwt: { expiresInSeconds: 600 } });
  const result = await service.login({ email: ' Demo-User ', password: 'demo123456' });
  assert.ok(query);
  assert.equal(result.admin.username, 'demo-user');
  assert.ok(!('passwordHash' in result.admin));
  await assert.rejects(service.login({ email: 'demo-user', password: 'incorrect' }), /Invalid credentials/);
  row.disabledAt = new Date();
  await assert.rejects(service.login({ email: 'demo-user', password: 'demo123456' }), /Invalid credentials/);
});
