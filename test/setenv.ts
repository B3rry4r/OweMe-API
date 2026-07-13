// Runs (via jest `setupFiles`) before each test file in every worker, so PrismaClient
// picks up the shared temp test DB. Must match the path in test/global-setup.js.
import * as os from 'os';
import * as path from 'path';

// Must match test/global-setup.js — honor OWEME_TEST_DB so parallel runs isolate their DB.
const TEST_DB_FILE = process.env.OWEME_TEST_DB || path.join(os.tmpdir(), 'oweme-e2e.db');
process.env.DATABASE_URL = `file:${TEST_DB_FILE}`;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'test-refresh-secret';
