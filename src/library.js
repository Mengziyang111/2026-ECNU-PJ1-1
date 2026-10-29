import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { check, HttpError } from './errors.js';
import { validateDefinition } from './logic.js';

export const sameId = (a, b) => String(a) === String(b);
export function objectId(value) {
  check(typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value), 'ID无效');
  return new ObjectId(value);
}
export const familyAccess = userId => ({ $or: [{ ownerId: userId }, { sharedWith: userId }] });
export async function accessibleFamily(db, id, user, ownerOnly = false) {
  const family = await db.collection('question_families').findOne({ _id: objectId(String(id)), ...(ownerOnly ? { ownerId: user._id } : familyAccess(user._id)) });
  check(family, '题目不存在或无权访问', 404);
  return family;
}
export function templateQuestion(question) {
  check(question && typeof question === 'object' && !Array.isArray(question), '题目必须为对象');
  return validateDefinition({ title: '独立题目', questions: [{ ...question, id: 'template', rules: [], sourceFamilyId: undefined, sourceVersionId: undefined }] }).questions[0];
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
export const contentKey = question => JSON.stringify(ordered(templateQuestion(question)));

// A library reference is provenance, not client-supplied decoration. Only the
// immutable version's content may carry its identity; rules remain survey-local.
export async function validateSourceReferences(db, user, definition, previous = null) {
  const referenced = definition.questions.filter(q => q.sourceVersionId);
  check(new Set(referenced.map(q => q.sourceVersionId)).size === referenced.length, '同一问卷不能重复引用同一个题目版本');
  if (!referenced.length) return definition;
  const versions = await db.collection('question_versions').find({ _id: { $in: referenced.map(q => objectId(q.sourceVersionId)) } }).toArray();
  const byVersion = new Map(versions.map(v => [String(v._id), v]));
  const permitted = new Map();
  for (const q of referenced) {
    const version = byVersion.get(q.sourceVersionId);
    check(version && sameId(version.familyId, q.sourceFamilyId), '题目来源版本或所属题目无效');
    check(contentKey(q) === contentKey(version.question), '引用题目的内容必须与所选版本一致，请在题库中创建新版本');
    const old = previous?.questions.find(item => item.id === q.id);
    const unchanged = old && old.sourceFamilyId === q.sourceFamilyId && old.sourceVersionId === q.sourceVersionId && contentKey(old) === contentKey(q);
    if (unchanged) continue;
    if (!permitted.has(q.sourceFamilyId)) {
      permitted.set(q.sourceFamilyId, !!await db.collection('question_families').findOne({ _id: version.familyId, ...familyAccess(user._id) }, { projection: { _id: 1 } }));
    }
    check(permitted.get(q.sourceFamilyId), '题目不存在或尚未共享给你', 404);
  }
  return definition;
}

async function familySummary(db, family, user) {
  const versions = db.collection('question_versions');
  const [versionCount, latestVersion] = await Promise.all([
    versions.countDocuments({ familyId: family._id }),
    versions.findOne({ familyId: family._id }, { sort: { versionNo: -1 } })
  ]);
  const isOwner = sameId(family.ownerId, user._id);
  const shared = isOwner && family.sharedWith.length ? await db.collection('users').find({ _id: { $in: family.sharedWith } }, { projection: { username: 1 } }).toArray() : [];
  return { ...family, sharedWith: isOwner ? family.sharedWith : [], isOwner, sharedUsernames: shared.map(u => u.username), versionCount, latestVersion };
}
async function versionInFamily(db, familyId, versionId) {
  const version = await db.collection('question_versions').findOne({ _id: objectId(versionId), familyId });
  check(version, '该题目的版本不存在', 404);
  return version;
}
async function appendVersion(db, family, user, { parentVersionId, question, restoredFromVersionId = null }) {
  const canonical = templateQuestion(question);
  await versionInFamily(db, family._id, parentVersionId);
  const allocation = await db.collection('question_families').findOneAndUpdate(
    { _id: family._id, ownerId: user._id },
    { $inc: { nextVersionNo: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'before' }
  );
  check(allocation, '只有题目创建者可以创建版本', 404);
  const version = { _id: new ObjectId(), familyId: family._id, versionNo: allocation.nextVersionNo, parentVersionId: objectId(parentVersionId), restoredFromVersionId: restoredFromVersionId ? objectId(restoredFromVersionId) : null, question: canonical, createdAt: new Date() };
  await db.collection('question_versions').insertOne(version);
  return version;
}
async function usage(db, family, user) {
  const surveys = await db.collection('surveys').find({ 'questions.sourceFamilyId': String(family._id) }, { projection: { ownerId: 1, title: 1, status: 1, questions: 1 } }).toArray();
  const versions = await db.collection('question_versions').find({ familyId: family._id }, { projection: { versionNo: 1 } }).toArray();
  const numbers = new Map(versions.map(v => [String(v._id), v.versionNo]));
  const visible = [];
  let hiddenUsageCount = 0;
  for (const survey of surveys) {
    const questions = survey.questions.filter(q => q.sourceFamilyId === String(family._id));
    if (!sameId(survey.ownerId, user._id)) { hiddenUsageCount += questions.length; continue; }
    for (const q of questions) visible.push({ surveyId: survey._id, title: survey.title, status: survey.status, versionId: q.sourceVersionId, versionNo: numbers.get(q.sourceVersionId), questionId: q.id });
  }
  return { surveys: visible, hiddenUsageCount };
}

export async function questionStatistics(db, family, user, selectedVersionId = null) {
  const query = { familyId: family._id };
  if (selectedVersionId) query._id = objectId(selectedVersionId);
  const versions = await db.collection('question_versions').find(query).sort({ versionNo: 1 }).toArray();
  check(!selectedVersionId || versions.length === 1, '该题目的版本不存在', 404);
  const surveys = await db.collection('surveys').find({ ownerId: user._id, 'questions.sourceFamilyId': String(family._id) }, { projection: { questions: 1 } }).toArray();
  const versionResults = [];
  for (const version of versions) {
    const versionId = String(version._id);
    const matching = surveys.filter(s => s.questions.some(q => q.sourceVersionId === versionId));
    const ids = matching.map(s => s._id);
    const totalResponses = ids.length ? await db.collection('responses').countDocuments({ surveyId: { $in: ids } }) : 0;
    const grouped = ids.length ? await db.collection('responses').aggregate([
      { $match: { surveyId: { $in: ids } } },
      { $unwind: '$answers' },
      { $match: { 'answers.sourceVersionId': versionId, 'answers.sourceFamilyId': String(family._id), 'answers.value': { $ne: null } } },
      { $group: { _id: null, answeredCount: { $sum: 1 }, values: { $push: '$answers.value' }, average: { $avg: { $cond: [{ $eq: ['$answers.type', 'number'] }, '$answers.value', null] } } } }
    ]).toArray() : [];
    const row = grouped[0] ?? { answeredCount: 0, values: [], average: null };
    const q = version.question;
    const result = { versionId, versionNo: version.versionNo, title: q.title, type: q.type, surveyCount: matching.length, totalResponses, answeredCount: row.answeredCount, skippedCount: totalResponses - row.answeredCount };
    if (q.type === 'single' || q.type === 'multiple') result.options = q.options.map(o => ({ ...o, count: row.values.filter(v => q.type === 'single' ? v === o.id : Array.isArray(v) && v.includes(o.id)).length }));
    else result.values = row.values;
    if (q.type === 'number') {
      result.average = row.average;
      const distribution = new Map();
      for (const value of row.values) distribution.set(value, (distribution.get(value) ?? 0) + 1);
      result.distribution = [...distribution].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
    }
    versionResults.push(result);
  }
  return { familyId: family._id, scope: 'owned-surveys', versions: versionResults };
}

function bankInput(input) {
  check(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 120, '题库名称不能为空且不超过120字');
  check(input.description === undefined || typeof input.description === 'string' && input.description.length <= 3000, '题库说明不超过3000字');
  return { title: input.title.trim(), description: input.description ?? '' };
}

// Returns false for original stage-one routes, leaving their behavior intact.
export async function handleLibraryRoute({ db, user, req, res, url, send, readBody }) {
  const path = url.pathname, method = req.method;
  const reply = (status, data) => send(res, status, data);
  const importRoute = path.match(/^\/api\/surveys\/([a-f0-9]{24})\/questions\/from-library$/i);
  if (importRoute) {
    check(method === 'POST', '接口不存在', 404);
    const survey = await db.collection('surveys').findOne({ _id: objectId(importRoute[1]), ownerId: user._id });
    check(survey, '问卷不存在或无权访问', 404);
    check(survey.status === 'draft', '已发布或关闭的问卷不能修改', 409);
    const input = await readBody(req);
    check(input.expectedRevision === survey.revision, '草稿被其他窗口修改，请刷新', 409);
    const version = await db.collection('question_versions').findOne({ _id: objectId(input.versionId) });
    check(version, '题目版本不存在', 404);
    await accessibleFamily(db, version.familyId, user);
    const questionId = input.questionId ?? `q_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const question = { ...version.question, id: questionId, rules: [], sourceFamilyId: String(version.familyId), sourceVersionId: String(version._id) };
    const definition = validateDefinition({ ...survey, questions: [...survey.questions, question] });
    await validateSourceReferences(db, user, definition, survey);
    const updated = await db.collection('surveys').findOneAndUpdate({ _id: survey._id, ownerId: user._id, status: 'draft', revision: input.expectedRevision }, { $set: { questions: definition.questions, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
    check(updated, '草稿版本或状态已改变，请刷新', 409);
    const { anonymousSalt, ...safe } = updated;
    reply(201, safe); return true;
  }
  if (!path.startsWith('/api/library/')) return false;
  if (path === '/api/library/questions' && method === 'GET') {
    const families = await db.collection('question_families').find(familyAccess(user._id)).sort({ createdAt: -1 }).toArray();
    reply(200, await Promise.all(families.map(f => familySummary(db, f, user)))); return true;
  }
  if (path === '/api/library/questions' && method === 'POST') {
    const input = await readBody(req), question = templateQuestion(input.question);
    const now = new Date();
    const family = { _id: new ObjectId(), ownerId: user._id, sharedWith: [], nextVersionNo: 2, createdAt: now, updatedAt: now };
    const version = { _id: new ObjectId(), familyId: family._id, versionNo: 1, parentVersionId: null, restoredFromVersionId: null, question, createdAt: now };
    await db.collection('question_families').insertOne(family);
    try { await db.collection('question_versions').insertOne(version); }
    catch (error) { await db.collection('question_families').deleteOne({ _id: family._id, nextVersionNo: 2 }); throw error; }
    reply(201, { family: await familySummary(db, family, user), version }); return true;
  }
  const questionRoute = path.match(/^\/api\/library\/questions\/([a-f0-9]{24})(?:\/(versions|restore|sharing|usage|stats))?$/i);
  if (questionRoute) {
    const action = questionRoute[2];
    const write = (method === 'POST' && ['versions', 'restore'].includes(action)) || (method === 'PUT' && action === 'sharing');
    const family = await accessibleFamily(db, questionRoute[1], user, write);
    if (!action && method === 'GET') {
      reply(200, { family: await familySummary(db, family, user), versions: await db.collection('question_versions').find({ familyId: family._id }).sort({ versionNo: 1 }).toArray() }); return true;
    }
    if (action === 'versions' && method === 'POST') {
      const input = await readBody(req);
      reply(201, await appendVersion(db, family, user, input)); return true;
    }
    if (action === 'restore' && method === 'POST') {
      const input = await readBody(req), restored = await versionInFamily(db, family._id, input.versionId);
      const latest = await db.collection('question_versions').findOne({ familyId: family._id }, { sort: { versionNo: -1 } });
      reply(201, await appendVersion(db, family, user, { parentVersionId: String(latest._id), restoredFromVersionId: String(restored._id), question: restored.question })); return true;
    }
    if (action === 'sharing' && method === 'PUT') {
      const input = await readBody(req);
      check(Array.isArray(input.usernames) && input.usernames.length <= 100 && input.usernames.every(n => typeof n === 'string' && n.trim().length > 0), '共享用户名必须为数组且最多100项');
      const names = [...new Set(input.usernames.map(n => n.trim().toLowerCase()))];
      check(!names.includes(user.username), '不需要向自己共享');
      const recipients = await db.collection('users').find({ username: { $in: names } }, { projection: { username: 1 } }).toArray();
      check(recipients.length === names.length, '共享列表中有尚未注册的用户名');
      await db.collection('question_families').updateOne({ _id: family._id, ownerId: user._id }, { $set: { sharedWith: recipients.map(u => u._id), updatedAt: new Date() } });
      const updated = await db.collection('question_families').findOne({ _id: family._id });
      reply(200, { family: await familySummary(db, updated, user), sharedUsernames: names }); return true;
    }
    if (action === 'usage' && method === 'GET') { reply(200, await usage(db, family, user)); return true; }
    if (action === 'stats' && method === 'GET') { reply(200, await questionStatistics(db, family, user, url.searchParams.get('versionId'))); return true; }
    throw new HttpError(404, '接口不存在');
  }
  if (path === '/api/library/banks' && method === 'GET') {
    reply(200, await db.collection('banks').find({ ownerId: user._id }).sort({ createdAt: -1 }).toArray()); return true;
  }
  if (path === '/api/library/banks' && method === 'POST') {
    const input = await readBody(req), definition = bankInput(input), now = new Date();
    const bank = { _id: new ObjectId(), ...definition, ownerId: user._id, questionFamilyIds: [], revision: 1, createdAt: now, updatedAt: now };
    await db.collection('banks').insertOne(bank); reply(201, bank); return true;
  }
  const bankRoute = path.match(/^\/api\/library\/banks\/([a-f0-9]{24})$/i);
  if (bankRoute) {
    const bank = await db.collection('banks').findOne({ _id: objectId(bankRoute[1]), ownerId: user._id });
    check(bank, '题库不存在或无权访问', 404);
    if (method === 'PUT') {
      const input = await readBody(req), definition = bankInput(input);
      check(input.expectedRevision === bank.revision, '题库已被修改，请刷新', 409);
      check(Array.isArray(input.questionFamilyIds) && input.questionFamilyIds.length <= 500, '题库最多500道题目');
      const ids = input.questionFamilyIds.map(objectId);
      check(new Set(ids.map(String)).size === ids.length, '题库成员不能重复');
      const count = ids.length ? await db.collection('question_families').countDocuments({ _id: { $in: ids }, ...familyAccess(user._id) }) : 0;
      check(count === ids.length, '题库包含无权访问的题目', 404);
      const updated = await db.collection('banks').findOneAndUpdate({ _id: bank._id, ownerId: user._id, revision: input.expectedRevision }, { $set: { ...definition, questionFamilyIds: ids, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
      check(updated, '题库已被其他窗口修改，请刷新', 409);
      reply(200, updated); return true;
    }
    if (method === 'DELETE') {
      await readBody(req);
      const removed = await db.collection('banks').deleteOne({ _id: bank._id, ownerId: user._id, revision: bank.revision });
      check(removed.deletedCount === 1, '题库已被其他窗口修改，请刷新', 409);
      reply(200, { ok: true }); return true;
    }
  }
  throw new HttpError(404, '接口不存在');
}
