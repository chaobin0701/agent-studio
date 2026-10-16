import { input, password } from '@inquirer/prompts';
import { hash } from 'bcryptjs';
import { Pool } from 'pg';
import { readConfigEnvironment } from '../config/config.schema';

async function main(): Promise<void> {
  const config = readConfigEnvironment();
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const existing = await pool.query('SELECT 1 FROM admins LIMIT 1');
    if (existing.rowCount) {
      console.log('An administrator already exists. Bootstrap is only for the first account.');
      return;
    }

    const email = (await input({ message: 'Initial admin email:' })).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
      throw new Error('A valid email is required');
    }
    const displayName = (await input({ message: 'Display name:' })).trim();
    if (!displayName || displayName.length > 120) throw new Error('Display name must be 1–120 characters');
    const rawPassword = await password({ message: 'Password (12+ characters):', mask: '*' });
    if (rawPassword.length < 12 || Buffer.byteLength(rawPassword, 'utf8') > 72) {
      throw new Error('Password must be at least 12 characters and at most 72 UTF-8 bytes');
    }
    const repeated = await password({ message: 'Repeat password:', mask: '*' });
    if (rawPassword !== repeated) throw new Error('Passwords do not match');
    const passwordHash = await hash(rawPassword, 12);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(837076176)');
      const count = await client.query('SELECT 1 FROM admins LIMIT 1');
      if (count.rowCount) throw new Error('An administrator was created concurrently');
      const created = await client.query<{ id: string }>(
        'INSERT INTO admins (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
        [email, passwordHash, displayName],
      );
      const role = await client.query<{ id: string }>("SELECT id FROM roles WHERE code = 'super_admin'");
      if (!role.rows[0]) throw new Error('Run database migrations first');
      await client.query('INSERT INTO admin_roles (admin_id, role_id) VALUES ($1, $2)', [created.rows[0].id, role.rows[0].id]);
      await client.query('COMMIT');
      console.log(`Initial super administrator created: ${email}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed');
  process.exitCode = 1;
});
