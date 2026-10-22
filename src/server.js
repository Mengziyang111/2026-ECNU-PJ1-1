import { connectDatabase } from './database.js';
import { createApplication } from './app.js';
try {
  const { client, db } = await connectDatabase();
  const server = createApplication(db);
  const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => console.log(`问卷系统已启动 http://${host}:${port} · MongoDB ${db.databaseName}`));
  async function shutdown() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await client.close(); process.exit(0); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
} catch (error) { console.error('启动失败，请检查MongoDB是否已启动及.env连接配置：', error.message); process.exit(1); }
