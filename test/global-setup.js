// Jest globalSetup (plain JS so no ts-node needed to load it).
// Provisions a FRESH SQLite test DB, applies migrations, and seeds the plan catalog
// before the contract/e2e suite runs. Build agents' contract tests inherit this DB.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// OWEME_TEST_DB lets concurrent test runs (e.g. parallel build agents) isolate their DB.
const TEST_DB_FILE = process.env.OWEME_TEST_DB || path.join(os.tmpdir(), 'oweme-e2e.db');
const TEST_DATABASE_URL = `file:${TEST_DB_FILE}`;

module.exports = async () => {
  for (const f of [TEST_DB_FILE, `${TEST_DB_FILE}-journal`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const env = { ...process.env, DATABASE_URL: TEST_DATABASE_URL };
  const cwd = path.resolve(__dirname, '..');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env, cwd });
  execSync('npx prisma db seed', { stdio: 'inherit', env, cwd });
};
