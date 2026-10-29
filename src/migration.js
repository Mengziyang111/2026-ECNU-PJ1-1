import { ObjectId, BSON } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { check } from './errors.js';
import { templateQuestion, contentKey, sameId } from './library.js';

function migrationId(kind, surveyId, questionId) {
  return new ObjectId(createHash('sha256').update(`ecnu-survey-stage2:${kind}:${surveyId}:${questionId}`).digest('hex').slice(0, 24));
}

// Backup must precede schema initialization/migration. Stop application writers
// while running this CLI: a standalone server cannot take a multi-collection
// transactionally consistent backup while other clients continue to write.
export async function backupDatabase(db, directory) {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(name => !name.startsWith('system.')).sort();
  const collections = {};
  let documents = 0;
  for (const name of names) {
    collections[name] = await db.collection(name).find({}).toArray();
    documents += collections[name].length;
  }
  const backup = { format: 'survey-stage2-ejson-v1', database: db.databaseName, createdAt: new Date(), collections };
  const targetDirectory = resolve(directory);
  await mkdir(targetDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(targetDirectory, `${db.databaseName.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(path, BSON.EJSON.stringify(backup, null, 2, { relaxed: false }), { encoding: 'utf8', flag: 'wx' });
  return { path, collections: names.length, documents };
}

export async function migrateLegacyData(db, { dryRun = false } = {}) {
  check(typeof dryRun === 'boolean', 'dryRun必须为布尔值');
  const result = { dryRun, surveysScanned: 0, questionsMigrated: 0, responsesUpdated: 0, familiesCreated: 0, versionsCreated: 0 };
  const surveys = db.collection('surveys').find({});
  const plannedFamilies = new Set(), plannedVersions = new Set();
  for await (const survey of surveys) {
    result.surveysScanned++;
    const originalQuestions = survey.questions;
    const questions = [];
    let changedQuestions = 0;
    for (const question of originalQuestions) {
      if (question.sourceFamilyId && question.sourceVersionId) { questions.push(question); continue; }
      check(!question.sourceFamilyId && !question.sourceVersionId, '旧题来源字段不完整，请先核对数据');
      const familyId = migrationId('family', survey._id, question.id);
      const versionId = migrationId('version', survey._id, question.id);
      const now = new Date();
      const canonical = templateQuestion(question);
      const [existingFamily, existingVersion] = await Promise.all([
        db.collection('question_families').findOne({ _id: familyId }),
        db.collection('question_versions').findOne({ _id: versionId })
      ]);
      check(!existingFamily || sameId(existingFamily.ownerId, survey.ownerId), '迁移题目族与原问卷所有者不一致，请核对备份');
      check(!existingVersion || sameId(existingVersion.familyId, familyId) && contentKey(existingVersion.question) === contentKey(canonical), '迁移期间旧题内容发生变化，请停止写入并核对备份后重试', 409);
      const family = { ownerId: survey.ownerId, sharedWith: [], nextVersionNo: 2, createdAt: now, updatedAt: now, migrationSource: { surveyId: survey._id, questionId: question.id } };
      const version = { familyId, versionNo: 1, parentVersionId: null, restoredFromVersionId: null, question: canonical, createdAt: now };
      if (dryRun) {
        if (!existingFamily && !plannedFamilies.has(String(familyId))) result.familiesCreated++;
        if (!existingVersion && !plannedVersions.has(String(versionId))) result.versionsCreated++;
      } else {
        const familyWrite = await db.collection('question_families').updateOne({ _id: familyId }, { $setOnInsert: family }, { upsert: true });
        const versionWrite = await db.collection('question_versions').updateOne({ _id: versionId }, { $setOnInsert: version }, { upsert: true });
        result.familiesCreated += familyWrite.upsertedCount;
        result.versionsCreated += versionWrite.upsertedCount;
      }
      plannedFamilies.add(String(familyId)); plannedVersions.add(String(versionId));
      questions.push({ ...question, sourceFamilyId: String(familyId), sourceVersionId: String(versionId) });
      changedQuestions++;
    }
    if (changedQuestions && !dryRun) {
      const update = await db.collection('surveys').updateOne({ _id: survey._id, revision: survey.revision, questions: originalQuestions }, { $set: { questions } });
      check(update.modifiedCount === 1, '迁移期间问卷发生变化，请停止写入后重试', 409);
    }
    result.questionsMigrated += changedQuestions;
    const byId = new Map(questions.map(question => [question.id, question]));
    for await (const response of db.collection('responses').find({ surveyId: survey._id })) {
      let changed = false;
      const answers = response.answers.map(answer => {
        const question = byId.get(answer.questionId);
        if (!question?.sourceVersionId || !question.sourceFamilyId) return answer;
        if (answer.sourceFamilyId === question.sourceFamilyId && answer.sourceVersionId === question.sourceVersionId) return answer;
        changed = true;
        return { ...answer, sourceFamilyId: question.sourceFamilyId, sourceVersionId: question.sourceVersionId };
      });
      if (!changed) continue;
      if (!dryRun) {
        const update = await db.collection('responses').updateOne({ _id: response._id, answers: response.answers }, { $set: { answers } });
        check(update.modifiedCount === 1, '迁移期间回答发生变化，请停止写入后重试', 409);
      }
      result.responsesUpdated++;
    }
  }
  return result;
}
