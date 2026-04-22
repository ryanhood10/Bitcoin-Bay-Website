#!/usr/bin/env node
/**
 * manage-admins.js — CLI for the bcb_admin_users Mongo collection.
 *
 * Usage:
 *   node scripts/manage-admins.js list
 *   node scripts/manage-admins.js add <username> <password> <role>   # role: full | dashboard
 *   node scripts/manage-admins.js remove <username>
 *   node scripts/manage-admins.js set-password <username> <password>
 *   node scripts/manage-admins.js set-role <username> <role>
 *
 * Requires MONGO_URI in env.
 *
 * The env-var admin (ADMIN_USERNAME/ADMIN_PASSWORD_HASH) is NOT managed here —
 * it's always role=full and lives in Heroku config. This CLI only affects
 * additional admins stored in Mongo.
 */

const bcrypt = require('bcrypt');
const { MongoClient } = require('mongodb');
const { MONGO_DB, ADMINS_COLL, ROLE_FULL, ROLE_DASHBOARD, VALID_ROLES } = require('../adminAuth');

const BCRYPT_ROUNDS = 12;

function usage(msg) {
  if (msg) console.error('Error: ' + msg);
  console.error(`\nUsage:
  node scripts/manage-admins.js list
  node scripts/manage-admins.js add <username> <password> <full|dashboard>
  node scripts/manage-admins.js remove <username>
  node scripts/manage-admins.js set-password <username> <password>
  node scripts/manage-admins.js set-role <username> <full|dashboard>\n`);
  process.exit(1);
}

async function withColl(fn) {
  if (!process.env.MONGO_URI) {
    console.error('Error: MONGO_URI not set.');
    process.exit(2);
  }
  const client = new MongoClient(process.env.MONGO_URI);
  try {
    await client.connect();
    const coll = client.db(MONGO_DB).collection(ADMINS_COLL);
    return await fn(coll);
  } finally {
    await client.close();
  }
}

async function cmdList() {
  await withColl(async coll => {
    const docs = await coll.find({}, { projection: { password_hash: 0 } }).sort({ username: 1 }).toArray();
    if (!docs.length) {
      console.log('(no Mongo-stored admins)');
      console.log('Env admin: ' + (process.env.ADMIN_USERNAME ? `@${process.env.ADMIN_USERNAME.toLowerCase()} (role=full)` : '(not set)'));
      return;
    }
    console.log(`Env admin: ${process.env.ADMIN_USERNAME ? '@' + process.env.ADMIN_USERNAME.toLowerCase() + ' (role=full)' : '(not set)'}`);
    console.log(`\nMongo admins (${docs.length}):`);
    for (const d of docs) {
      const last = d.last_login_at ? new Date(d.last_login_at).toISOString() : 'never';
      console.log(`  @${d.username.padEnd(20)}  role=${(d.role || '?').padEnd(10)}  last_login=${last}`);
    }
  });
}

async function cmdAdd(username, password, role) {
  if (!username || !password || !role) return usage('add requires username, password, role');
  if (!VALID_ROLES.has(role)) return usage(`invalid role — must be one of: ${[...VALID_ROLES].join(', ')}`);
  if (password.length < 8) return usage('password must be at least 8 chars');
  const lowered = username.trim().toLowerCase();
  if (process.env.ADMIN_USERNAME && lowered === process.env.ADMIN_USERNAME.trim().toLowerCase()) {
    return usage(`cannot add "${lowered}" — it collides with env admin ADMIN_USERNAME. Use a different name.`);
  }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await withColl(async coll => {
    await coll.updateOne(
      { username: lowered },
      { $set: { username: lowered, password_hash: hash, role }, $setOnInsert: { created_at: new Date() } },
      { upsert: true },
    );
    console.log(`✓ admin @${lowered} saved (role=${role})`);
  });
}

async function cmdRemove(username) {
  if (!username) return usage('remove requires username');
  const lowered = username.trim().toLowerCase();
  await withColl(async coll => {
    const res = await coll.deleteOne({ username: lowered });
    if (res.deletedCount) console.log(`✓ removed @${lowered}`);
    else console.log(`(no match for @${lowered})`);
  });
}

async function cmdSetPassword(username, password) {
  if (!username || !password) return usage('set-password requires username + password');
  if (password.length < 8) return usage('password must be at least 8 chars');
  const lowered = username.trim().toLowerCase();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await withColl(async coll => {
    const res = await coll.updateOne({ username: lowered }, { $set: { password_hash: hash } });
    if (res.matchedCount) console.log(`✓ password updated for @${lowered}`);
    else console.log(`(no match for @${lowered})`);
  });
}

async function cmdSetRole(username, role) {
  if (!username || !role) return usage('set-role requires username + role');
  if (!VALID_ROLES.has(role)) return usage(`invalid role — must be one of: ${[...VALID_ROLES].join(', ')}`);
  const lowered = username.trim().toLowerCase();
  await withColl(async coll => {
    const res = await coll.updateOne({ username: lowered }, { $set: { role } });
    if (res.matchedCount) console.log(`✓ role updated for @${lowered} → ${role}`);
    else console.log(`(no match for @${lowered})`);
  });
}

const [, , cmd, ...args] = process.argv;
(async () => {
  try {
    if (cmd === 'list') await cmdList();
    else if (cmd === 'add') await cmdAdd(args[0], args[1], args[2]);
    else if (cmd === 'remove') await cmdRemove(args[0]);
    else if (cmd === 'set-password') await cmdSetPassword(args[0], args[1]);
    else if (cmd === 'set-role') await cmdSetRole(args[0], args[1]);
    else usage('unknown command');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
