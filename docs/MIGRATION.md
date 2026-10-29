# 阶段一数据升级与恢复

迁移保留原四集合及旧接口，不删除题目、问卷或回答。默认启动只初始化缺少的集合、验证器和索引，不自动把旧题变成独立题；未迁移数据仍可按原流程填写和统计。

## 操作顺序

1. 停止应用及所有其他写入客户端，核对.env中的连接与库名；保留阶段一代码和已有备份。
2. 执行`npm run migrate -- --dry-run`。它直接用MongoClient只读预览，不创建集合、索引或备份。
3. 核对问卷、题目和回答数量，再执行`npm run migrate`。
4. 命令先备份原库全部非system集合到data/backups，再初始化新增集合、验证器与索引，最后补来源。

备份用BSON.EJSON非relaxed格式，保留ObjectId、Date和BSON数字类型。文件名含数据库、时间及随机串，写入使用wx避免覆盖。备份可能含账号哈希和会话摘要，应保留在本地，不上传GitHub。

## 变更与兼容

旧题按surveyId与questionId生成确定性族ID和版本ID，upsert首版；原题只追加sourceFamilyId/sourceVersionId，回答也只补来源。原问卷ID、局部题ID、revision、内容、规则、截止、状态、path、值、身份/匿名标记、盐和dedupeKey保留。同名题不自动合并。

确定性ID及$setOnInsert保证重复执行不追加记录。问卷更新同时比较原revision和原questions，回答比较原answers；并发写入使条件不匹配时停止。已建族未关联、问卷已关联但答案未补，都可停止写入后续跑。已有新式来源保持原版本；不完整或冲突引用报错，不静默覆盖。

迁移不是多集合原子事务，失败前部分记录可能已完成。standalone备份也不是在线事务快照，因此停止所有写入是前提。保留备份，排除原因后重跑；不要手动清空原库。

## 恢复到全新库

在项目根目录另存以下示例为restore-local.mjs，替换备份文件和全新库名后执行`node restore-local.mjs`：

```js
import { readFile } from 'node:fs/promises';
import { MongoClient, BSON } from 'mongodb';
const backup = BSON.EJSON.parse(
  await readFile('data/backups/实际备份文件.json', 'utf8'), { relaxed: false }
);
if (backup.format !== 'survey-stage2-ejson-v1') throw new Error('备份格式不符');
const targetName = 'survey_recovered';
if (targetName === backup.database) throw new Error('请使用全新库名');
const client = new MongoClient('mongodb://127.0.0.1:27019');
try {
  await client.connect();
  const target = client.db(targetName);
  if ((await target.listCollections().toArray()).length) throw new Error('目标库必须为空');
  for (const [name, documents] of Object.entries(backup.collections)) {
    await target.createCollection(name);
    if (documents.length) await target.collection(name).insertMany(documents);
  }
} finally { await client.close(); }
```

备份不含索引定义，应用指向恢复库后会重建本项目索引和验证器。先核对数据与统计，再决定是否重新迁移。实测的备份恢复路径见migration-cli-results.json。

## 实际验证

84项自动测试中12项覆盖空库、只读预览、原字段保持、重复执行、同名不合并、两类中断续跑、旧API兼容、BSON备份、新旧混合来源及损坏输入。

额外通过原阶段一程序创建1份已发布5题问卷和1份匿名答卷，实际执行CLI预览、备份、迁移、重跑及新库恢复。原值等值保留，重跑迁移量为0，恢复后数字统计仍为4。验证只操作隔离夹具库，未迁移或覆盖用户原业务库。
