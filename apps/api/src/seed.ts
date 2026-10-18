import { addUser } from './app.js';
import { databasePath } from './config.js';
import { openDatabase } from './database.js';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--reset') || args.length > 1)
  throw new Error('Usage: seed [--reset]');
const db = openDatabase(databasePath());
try {
  if (args.includes('--reset')) {
    db.exec('BEGIN IMMEDIATE; DELETE FROM notes; DELETE FROM sessions; DELETE FROM users; COMMIT;');
  }
  const users: [string, string][] = [
    ['alice@example.test', process.env.DEV_ALICE_PASSWORD ?? 'alice-local-demo-only'],
    ['bob@example.test', process.env.DEV_BOB_PASSWORD ?? 'bob-local-demo-only'],
  ];
  for (const [email, password] of users) {
    if (!db.prepare('SELECT id FROM users WHERE email = ?').get(email))
      await addUser(db, email, password);
  }
  console.log(
    'Development users seeded. Existing users are unchanged; --reset replaces all demo data.',
  );
} finally {
  db.close();
}
