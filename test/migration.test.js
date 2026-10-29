import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, BSON } from 'mongodb';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { migrateLegacyData, backupDatabase } from '../src/migration.js';
import { demoDefinition } from '../scripts/demo.js';
import { evaluateAnswers } from '../src/logic.js';
import { openHarness, expect } from './stage2-support.js';

let h, owner;
beforeEach(async () => { h = await openHarness('migration'); owner = null; });
afterEach(async () => { await h?.close(); });
async function snapshot() {
  const names = (await h.db.listCollections({}, { nameOnly: true }).toArray()).map(x => x.name).filter(x => !x.startsWith('system.')).sort();
  const collections = {};
  for (const name of names) collections[name] = await h.db.collection(name).find({}).sort({ _id: 1 }).toArray();
  return BSON.EJSON.stringify(collections, { relaxed: false });
}
function stripSources(document, field) {
  return { ...document, [field]: document[field].map(({ sourceFamilyId, sourceVersionId, ...item }) => item) };
}
async function seedLegacy(count = 1) {
  owner ??= await h.register('migration_owner');
  const surveys = [], responses = [];
  for (let i = 0; i < count; i++) {
    const survey = {
      _id: new ObjectId(), ...demoDefinition(), ownerId: new ObjectId(owner.id),
      title: '同名旧问卷', status: i % 2 ? 'closed' : 'published', revision: 7,
      anonymousSalt: 'a'.repeat(64),
      createdAt: new Date('2026-10-20T08:00:00Z'), updatedAt: new Date('2026-10-21T08:00:00Z')
    };
    const evaluated = evaluateAnswers(survey, { role: 'no', comment: `旧建议${i}` });
    const response = {
      _id: new ObjectId(), surveyId: survey._id, respondentId: null, anonymous: true,
      revision: survey.revision, ...evaluated,
      dedupeKey: `legacy-${survey._id}`, submittedAt: new Date('2026-10-21T09:00:00Z')
    };
    await h.db.collection('surveys').insertOne(survey);
    await h.db.collection('responses').insertOne(response);
    surveys.push(await h.db.collection('surveys').findOne({ _id: survey._id }));
    responses.push(await h.db.collection('responses').findOne({ _id: response._id }));
  }
  return { surveys, responses };
}
function noNewWrites(result) {
  for (const key of ['questionsMigrated', 'responsesUpdated', 'familiesCreated', 'versionsCreated']) assert.equal(result[key], 0, key);
}

test('M01 空库迁移与空库预览安全且不创建业务数据', async () => {
  const before = await snapshot();
  const dryRun = await migrateLegacyData(h.db, { dryRun: true });
  assert.equal(dryRun.dryRun, true); assert.equal(dryRun.surveysScanned, 0); noNewWrites(dryRun);
  assert.equal(await snapshot(), before);
  const migrated = await migrateLegacyData(h.db);
  assert.equal(migrated.dryRun, false); assert.equal(migrated.surveysScanned, 0); noNewWrites(migrated);
  assert.equal(await snapshot(), before);
});

test('M02 dry-run准确预览迁移量且全部集合与原文档完全不变', async () => {
  const original = await seedLegacy(2); const before = await snapshot();
  const result = await migrateLegacyData(h.db, { dryRun: true });
  assert.equal(result.surveysScanned, 2);
  assert.equal(result.questionsMigrated, 10);
  assert.equal(result.familiesCreated, 10); assert.equal(result.versionsCreated, 10); assert.equal(result.responsesUpdated, 2);
  assert.equal(await snapshot(), before);
  assert.deepEqual(await h.db.collection('surveys').findOne({ _id: original.surveys[0]._id }), original.surveys[0]);
});

test('M03 正式迁移只补来源，保留ID、规则、状态、时间、revision、匿名与答案', async () => {
  const original = await seedLegacy();
  const result = await migrateLegacyData(h.db);
  assert.equal(result.questionsMigrated, 5); assert.equal(result.familiesCreated, 5); assert.equal(result.versionsCreated, 5); assert.equal(result.responsesUpdated, 1);
  const survey = await h.db.collection('surveys').findOne({ _id: original.surveys[0]._id });
  const response = await h.db.collection('responses').findOne({ _id: original.responses[0]._id });
  assert.deepEqual(stripSources(survey, 'questions'), original.surveys[0]);
  assert.deepEqual(stripSources(response, 'answers'), original.responses[0]);
  assert.deepEqual(response.path, ['role', 'comment']);
  for (const q of survey.questions) {
    assert.match(q.sourceFamilyId, /^[a-f0-9]{24}$/); assert.match(q.sourceVersionId, /^[a-f0-9]{24}$/);
    const family = await h.db.collection('question_families').findOne({ _id: new ObjectId(q.sourceFamilyId) });
    const version = await h.db.collection('question_versions').findOne({ _id: new ObjectId(q.sourceVersionId) });
    assert.equal(String(family.ownerId), owner.id);
    assert.equal(String(version.familyId), q.sourceFamilyId); assert.equal(version.versionNo, 1);
    assert.equal(version.question.id, 'template'); assert.deepEqual(version.question.rules, []);
    const answer = response.answers.find(a => a.questionId === q.id);
    if (answer) { assert.equal(answer.sourceFamilyId, q.sourceFamilyId); assert.equal(answer.sourceVersionId, q.sourceVersionId); }
  }
});

test('M04 重复运行幂等，不追加版本、重写时间或再次更新回答', async () => {
  await seedLegacy(); await migrateLegacyData(h.db); const migrated = await snapshot();
  const repeated = await migrateLegacyData(h.db);
  assert.equal(repeated.surveysScanned, 1); noNewWrites(repeated);
  assert.equal(await snapshot(), migrated);
  const dryRun = await migrateLegacyData(h.db, { dryRun: true }); noNewWrites(dryRun);
  assert.equal(await snapshot(), migrated);
});

test('M05 同名问卷和相同局部题ID逐题建独立族，不按标题自动合并', async () => {
  const original = await seedLegacy(2); await migrateLegacyData(h.db);
  const first = await h.db.collection('surveys').findOne({ _id: original.surveys[0]._id });
  const second = await h.db.collection('surveys').findOne({ _id: original.surveys[1]._id });
  assert.equal(first.title, second.title);
  assert.deepEqual(first.questions.map(q => q.id), second.questions.map(q => q.id));
  for (let i = 0; i < first.questions.length; i++) {
    assert.equal(first.questions[i].title, second.questions[i].title);
    assert.notEqual(first.questions[i].sourceFamilyId, second.questions[i].sourceFamilyId);
    assert.notEqual(first.questions[i].sourceVersionId, second.questions[i].sourceVersionId);
  }
  assert.equal(await h.db.collection('question_families').countDocuments(), 10);
  assert.equal(await h.db.collection('question_versions').countDocuments(), 10);
  assert.deepEqual(stripSources(second, 'questions'), original.surveys[1]);
});

test('M06 建族后问卷尚未关联的中断可续跑，已有版本不重复', async () => {
  const original = await seedLegacy(); await migrateLegacyData(h.db);
  const attached = await h.db.collection('surveys').findOne({ _id: original.surveys[0]._id });
  const familyBefore = await h.db.collection('question_families').find({}).sort({ _id: 1 }).toArray();
  const missingVersionId = attached.questions[0].sourceVersionId;
  await h.db.collection('question_versions').deleteOne({ _id: new ObjectId(missingVersionId) });
  await h.db.collection('surveys').updateOne({ _id: original.surveys[0]._id }, { $set: { questions: original.surveys[0].questions } });
  await h.db.collection('responses').updateOne({ _id: original.responses[0]._id }, { $set: { answers: original.responses[0].answers } });
  const resumed = await migrateLegacyData(h.db);
  assert.equal(resumed.familiesCreated, 0); assert.equal(resumed.versionsCreated, 1);
  assert.equal(resumed.questionsMigrated, 5); assert.equal(resumed.responsesUpdated, 1);
  const completed = await h.db.collection('surveys').findOne({ _id: attached._id });
  assert.deepEqual(completed.questions, attached.questions);
  assert.deepEqual(await h.db.collection('question_families').find({}).sort({ _id: 1 }).toArray(), familyBefore);
  assert.equal(await h.db.collection('question_versions').countDocuments(), 5);
  noNewWrites(await migrateLegacyData(h.db));
});

test('M07 问卷已补来源但回答未补来源的中断可续跑', async () => {
  const original = await seedLegacy(); await migrateLegacyData(h.db);
  const migratedSurvey = await h.db.collection('surveys').findOne({ _id: original.surveys[0]._id });
  const migratedResponse = await h.db.collection('responses').findOne({ _id: original.responses[0]._id });
  await h.db.collection('responses').updateOne({ _id: original.responses[0]._id }, { $set: { answers: original.responses[0].answers } });
  const result = await migrateLegacyData(h.db);
  assert.equal(result.questionsMigrated, 0); assert.equal(result.familiesCreated, 0); assert.equal(result.versionsCreated, 0); assert.equal(result.responsesUpdated, 1);
  assert.deepEqual(await h.db.collection('surveys').findOne({ _id: migratedSurvey._id }), migratedSurvey);
  assert.deepEqual(await h.db.collection('responses').findOne({ _id: migratedResponse._id }), migratedResponse);
});

test('M08 未迁移旧数据仍可通过原API填写和统计，启动不自动改写旧卷', async () => {
  const original = await seedLegacy(); const old = original.surveys[0];
  const publicView = expect(await h.api(`/api/public/surveys/${old._id}`, { as: owner }));
  assert.equal(publicView.revision, old.revision);
  assert.equal(publicView.questions[0].sourceVersionId, undefined);
  const created = expect(await h.api(`/api/public/surveys/${old._id}/responses`, { method: 'POST', as: owner, data: { revision: old.revision, anonymous: true, answers: { role: 'no', comment: '迁移前仍正常提交' } } }), 201);
  const stored = await h.db.collection('responses').findOne({ _id: new ObjectId(created.id) });
  assert.deepEqual(stored.path, ['role', 'comment']); assert.equal(stored.respondentId, null);
  const stats = expect(await h.api(`/api/surveys/${old._id}/stats`, { as: owner }));
  assert.equal(stats.totalResponses, 2);
  assert.deepEqual(stats.questions.find(q => q.questionId === 'comment').values.sort(), ['旧建议0', '迁移前仍正常提交'].sort());
  assert.deepEqual(await h.db.collection('surveys').findOne({ _id: old._id }), old);
  assert.equal(await h.db.collection('question_families').countDocuments(), 0);
});

test('M09 ExtendedJSON备份包含全部集合并保留ObjectId与Date，可供恢复', async () => {
  const original = await seedLegacy(); const before = await snapshot();
  const directory = await mkdtemp(join(tmpdir(), 'ecnu-survey-backup-test-'));
  let backup;
  try {
    backup = await backupDatabase(h.db, directory);
    assert.equal(dirname(resolve(backup.path)), resolve(directory));
    const parsed = BSON.EJSON.parse(await readFile(backup.path, 'utf8'), { relaxed: false });
    assert.equal(parsed.format, 'survey-stage2-ejson-v1'); assert.equal(parsed.database, h.db.databaseName);
    assert.ok(parsed.createdAt instanceof Date);
    const originalSurvey = parsed.collections.surveys.find(s => String(s._id) === String(original.surveys[0]._id));
    assert.ok(originalSurvey._id instanceof ObjectId); assert.ok(originalSurvey.createdAt instanceof Date);
    assert.equal(String(originalSurvey.ownerId), owner.id);
    assert.equal(BSON.EJSON.stringify(originalSurvey.questions, { relaxed: false }), BSON.EJSON.stringify(original.surveys[0].questions, { relaxed: false }));
    const originalAnswer = parsed.collections.responses[0];
    assert.deepEqual(originalAnswer.path, original.responses[0].path);
    assert.equal(BSON.EJSON.stringify(originalAnswer.answers, { relaxed: false }), BSON.EJSON.stringify(original.responses[0].answers, { relaxed: false }));
    assert.equal(backup.collections, Object.keys(parsed.collections).length);
    assert.equal(backup.documents, Object.values(parsed.collections).reduce((n, docs) => n + docs.length, 0));
    assert.equal(await snapshot(), before);
  } finally {
    if (backup) { assert.equal(dirname(resolve(backup.path)), resolve(directory)); await unlink(backup.path); }
    await rmdir(directory);
  }
});

test('M10 已存在的新式引用保持原版本，仅迁移同卷其他旧题', async () => {
  const original = await seedLegacy(); const old = original.surveys[0];
  const saved = expect(await h.api('/api/library/questions', { method: 'POST', as: owner, data: { question: old.questions[0] } }), 201);
  const first = { ...old.questions[0], sourceFamilyId: saved.family._id, sourceVersionId: saved.version._id };
  await h.db.collection('surveys').updateOne({ _id: old._id }, { $set: { questions: [first, ...old.questions.slice(1)] } });
  const result = await migrateLegacyData(h.db);
  assert.equal(result.questionsMigrated, 4); assert.equal(result.familiesCreated, 4); assert.equal(result.versionsCreated, 4); assert.equal(result.responsesUpdated, 1);
  const migrated = await h.db.collection('surveys').findOne({ _id: old._id });
  assert.deepEqual(migrated.questions[0], first);
  assert.equal(await h.db.collection('question_families').countDocuments(), 5);
  assert.equal(await h.db.collection('question_versions').countDocuments({ familyId: new ObjectId(saved.family._id) }), 1);
});

test('M11 不完整来源立即拒绝，不把损坏的引用静默覆盖', async () => {
  const original = await seedLegacy();
  await h.db.collection('surveys').updateOne({ _id: original.surveys[0]._id }, { $set: { 'questions.0.sourceFamilyId': new ObjectId().toHexString() } });
  const before = await snapshot();
  await assert.rejects(migrateLegacyData(h.db), error => error.status === 400);
  assert.equal(await snapshot(), before);
});

test('M12 非布尔dryRun参数拒绝，避免误把预览请求执行为迁移', async () => {
  await seedLegacy(); const before = await snapshot();
  await assert.rejects(migrateLegacyData(h.db, { dryRun: 'true' }), error => error.status === 400);
  assert.equal(await snapshot(), before);
});
