import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { connectDatabase } from '../src/database.js';
import { backupDatabase, migrateLegacyData } from '../src/migration.js';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--dry-run')) {
  console.error('用法：npm run migrate -- [--dry-run]');
  process.exit(1);
}
const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019';
const name = process.env.MONGODB_DB ?? 'survey_stage1';
const inspector = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
let initialized;
try {
  await inspector.connect();
  const db = inspector.db(name);
  const dryRun = args.includes('--dry-run');
  console.log(dryRun ? '迁移预览：只读取，不修改集合或文档。' : '迁移前请确保应用及其他写入客户端已停止。将先备份完整数据库，再补充来源引用。');
  if (dryRun) console.log(JSON.stringify(await migrateLegacyData(db, { dryRun: true }), null, 2));
  else {
    const backup = await backupDatabase(db, fileURLToPath(new URL('../data/backups/', import.meta.url)));
    console.log(`备份完成：${backup.path}（${backup.collections}个集合、${backup.documents}份文档）`);
    initialized = await connectDatabase({ uri, name });
    console.log(JSON.stringify(await migrateLegacyData(initialized.db), null, 2));
  }
} catch (error) {
  console.error('迁移未完成：', error.message);
  console.error('原题和原回答值不会被删除；保留备份，排除原因后可重跑。');
  process.exitCode = 1;
} finally {
  await initialized?.client.close();
  await inspector.close();
}
