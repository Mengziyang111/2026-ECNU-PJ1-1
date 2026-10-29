import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { openHarness, expect, numberQuestion, textQuestion, choiceQuestion } from './stage2-support.js';

let h, owner, peer, outsider;
before(async () => { h = await openHarness('stage2'); owner = await h.register('stage2_owner'); peer = await h.register('stage2_peer'); outsider = await h.register('stage2_outsider'); });
after(async () => { await h?.close(); });
const familyPath = family => `/api/library/questions/${family._id}`;
async function createQuestion(question = numberQuestion(), as = owner) {
  return expect(await h.api('/api/library/questions', { method: 'POST', as, data: { question } }), 201);
}
async function share(family, usernames = [peer.username], as = owner) {
  return expect(await h.api(familyPath(family) + '/sharing', { method: 'PUT', as, data: { usernames } }));
}
async function version(family, parentVersionId, question, as = owner) {
  return expect(await h.api(familyPath(family) + '/versions', { method: 'POST', as, data: { parentVersionId, question } }), 201);
}
async function survey(as = owner, questions = [], overrides = {}) {
  return expect(await h.api('/api/surveys', { method: 'POST', as, data: { title: '阶段二测试问卷', description: '', allowAnonymous: true, allowMultiple: true, deadline: null, questions, ...overrides } }), 201);
}
async function attach(s, v, as = owner, questionId = 'age') {
  return expect(await h.api(`/api/surveys/${s._id}/questions/from-library`, { method: 'POST', as, data: { versionId: v._id, expectedRevision: s.revision, questionId } }), 201);
}
async function publish(s, as = owner) {
  expect(await h.api(`/api/surveys/${s._id}/publish`, { method: 'POST', as, data: {} }));
  return s;
}
async function submit(s, answers, as = peer, extra = {}) {
  return expect(await h.api(`/api/public/surveys/${s._id}/responses`, { method: 'POST', as, data: { revision: s.revision, answers, ...extra } }), 201);
}
function referenced(v, questionId = 'age', rules = []) {
  return { ...v.question, id: questionId, rules, sourceFamilyId: v.familyId, sourceVersionId: v._id };
}
async function stats(family, as = owner, versionId) {
  return expect(await h.api(familyPath(family) + '/stats' + (versionId ? `?versionId=${versionId}` : ''), { as }));
}
const byVersion = (result, v) => { const item = result.versions.find(x => x.versionId === v._id); assert.ok(item, 'Expected referenced version in statistics'); return item; };

test('S01 题目、题库及导入接口未登录均拒绝', async () => {
  const { family, version: v } = await createQuestion();
  const s = await survey();
  for (const path of ['/api/library/questions', '/api/library/banks', familyPath(family), familyPath(family) + '/usage', familyPath(family) + '/stats']) expect(await h.api(path), 401);
  expect(await h.api('/api/library/questions', { method: 'POST', data: { question: numberQuestion() } }), 401);
  expect(await h.api(`/api/surveys/${s._id}/questions/from-library`, { method: 'POST', data: { versionId: v._id, expectedRevision: s.revision } }), 401);
  expect(await h.api('/library.js'), 200);
});

test('S02 独立保存常用题并规范模板ID与上下文规则', async () => {
  const { family, version: v } = await createQuestion();
  assert.match(family._id, /^[a-f0-9]{24}$/);
  assert.equal(v.familyId, family._id);
  assert.equal(v.versionNo, 1);
  assert.equal(v.parentVersionId, null);
  assert.equal(v.restoredFromVersionId, null);
  assert.equal(v.question.id, 'template');
  assert.deepEqual(v.question.rules, []);
  assert.deepEqual(v.question.validation, { min: 0, max: 120, integer: true });
  const detail = expect(await h.api(familyPath(family), { as: owner }));
  assert.equal(detail.family.isOwner, true);
  assert.deepEqual(detail.versions.map(x => x._id), [v._id]);
});

test('S03 无效题型、标题和校验范围拒绝且不产生残留题族', async () => {
  const beforeCount = await h.db.collection('question_families').countDocuments();
  for (const question of [numberQuestion({ title: '' }), numberQuestion({ type: 'unknown' }), numberQuestion({ validation: { min: 10, max: 1 } }), choiceQuestion('multiple', { validation: { exactChoices: 3 } })]) {
    expect(await h.api('/api/library/questions', { method: 'POST', as: owner, data: { question } }), 400);
  }
  assert.equal(await h.db.collection('question_families').countDocuments(), beforeCount);
});

test('S04 私有题目详情和历史不允许其他用户读取', async () => {
  const { family } = await createQuestion();
  expect(await h.api(familyPath(family), { as: outsider }), 404);
  const listed = expect(await h.api('/api/library/questions', { as: outsider }));
  assert.ok(!listed.some(x => x._id === family._id));
});

test('S05 分享后双方使用同一题族，接收者不能改历史或转授', async () => {
  const { family, version: v } = await createQuestion();
  const sharing = await share(family);
  assert.deepEqual(sharing.sharedUsernames, [peer.username]);
  const mine = expect(await h.api('/api/library/questions', { as: owner })).find(x => x._id === family._id);
  const received = expect(await h.api('/api/library/questions', { as: peer })).find(x => x._id === family._id);
  assert.equal(mine.isOwner, true); assert.equal(received.isOwner, false);
  assert.equal(received.latestVersion._id, v._id);
  assert.equal(received.ownerId, owner.id);
  const peerSurvey = await attach(await survey(peer), v, peer);
  assert.equal(peerSurvey.questions[0].sourceFamilyId, family._id);
  expect(await h.api(familyPath(family) + '/versions', { method: 'POST', as: peer, data: { parentVersionId: v._id, question: numberQuestion() } }), 404);
  expect(await h.api(familyPath(family) + '/sharing', { method: 'PUT', as: peer, data: { usernames: [outsider.username] } }), 404);
  expect(await h.api(familyPath(family) + '/restore', { method: 'POST', as: peer, data: { versionId: v._id } }), 404);
});

test('S06 未知共享用户名拒绝且不破坏已有授权', async () => {
  const { family } = await createQuestion(); await share(family);
  expect(await h.api(familyPath(family) + '/sharing', { method: 'PUT', as: owner, data: { usernames: ['not_registered_stage2_user'] } }), 400);
  expect(await h.api(familyPath(family), { as: peer }));
  expect(await h.api(familyPath(family) + '/sharing', { method: 'PUT', as: owner, data: { usernames: [owner.username] } }), 400);
});

test('S07 从同一旧版本建立分支，历史按序展示且旧内容不变', async () => {
  const { family, version: v1 } = await createQuestion();
  const v2 = await version(family, v1._id, numberQuestion({ title: '年龄新版甲' }));
  const v3 = await version(family, v1._id, numberQuestion({ title: '年龄新版乙' }));
  assert.equal(v2.parentVersionId, v1._id); assert.equal(v3.parentVersionId, v1._id);
  const detail = expect(await h.api(familyPath(family), { as: owner }));
  assert.deepEqual(detail.versions.map(v => v.versionNo), [1, 2, 3]);
  assert.deepEqual(detail.versions[0].question, v1.question);
  assert.equal(detail.versions[1].question.title, '年龄新版甲');
  assert.equal(detail.versions[2].question.title, '年龄新版乙');
});

test('S08 同父并发创建六个版本，唯一序号且不互相覆盖', async () => {
  const { family, version: v1 } = await createQuestion();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => h.api(familyPath(family) + '/versions', { method: 'POST', as: owner, data: { parentVersionId: v1._id, question: numberQuestion({ title: `并发分支${i}` }) } })));
  const versions = responses.map(r => expect(r, 201));
  assert.equal(new Set(versions.map(v => v.versionNo)).size, 6);
  assert.equal(new Set(versions.map(v => v._id)).size, 6);
  assert.ok(versions.every(v => v.parentVersionId === v1._id));
  const detail = expect(await h.api(familyPath(family), { as: owner }));
  assert.equal(detail.versions.length, 7);
  assert.deepEqual(detail.versions[0].question, v1.question);
  const summary = expect(await h.api('/api/library/questions', { as: owner })).find(x => x._id === family._id);
  assert.equal(summary.versionCount, 7);
  assert.equal(summary.latestVersion.versionNo, Math.max(...versions.map(v => v.versionNo)));
});

test('S09 恢复旧版本生成新版本并保留父版本和恢复来源', async () => {
  const { family, version: v1 } = await createQuestion();
  const v2 = await version(family, v1._id, numberQuestion({ validation: { min: 18, max: 80, integer: true } }));
  const restored = expect(await h.api(familyPath(family) + '/restore', { method: 'POST', as: owner, data: { versionId: v1._id } }), 201);
  assert.notEqual(restored._id, v1._id);
  assert.equal(restored.versionNo, 3);
  assert.equal(restored.parentVersionId, v2._id);
  assert.equal(restored.restoredFromVersionId, v1._id);
  assert.deepEqual(restored.question, v1.question);
  const detail = expect(await h.api(familyPath(family), { as: owner }));
  assert.deepEqual(detail.versions[0].question, v1.question);
  assert.deepEqual(detail.versions[1].question, v2.question);
});

test('S10 版本来源必须属于所选题族', async () => {
  const a = await createQuestion(), b = await createQuestion();
  for (const [suffix, data] of [['/versions', { parentVersionId: b.version._id, question: numberQuestion() }], ['/restore', { versionId: b.version._id }]]) {
    const result = await h.api(familyPath(a.family) + suffix, { method: 'POST', as: owner, data });
    assert.ok([400, 404].includes(result.status), JSON.stringify(result.body));
  }
  assert.equal(expect(await h.api(familyPath(a.family), { as: owner })).versions.length, 1);
});

test('S11 同一保存版本可导入多个问卷并保留独立局部ID', async () => {
  const { family, version: v } = await createQuestion();
  const first = await attach(await survey(), v, owner, 'age_one');
  const second = await attach(await survey(), v, owner, 'age_two');
  assert.equal(first.questions[0].id, 'age_one'); assert.equal(second.questions[0].id, 'age_two');
  for (const s of [first, second]) {
    assert.equal(s.questions[0].sourceVersionId, v._id);
    assert.equal(s.questions[0].sourceFamilyId, family._id);
    assert.deepEqual(s.questions[0].rules, []);
    assert.equal(s.revision, 2);
  }
});

test('S12 导入遵守草稿状态、问卷所有权和乐观锁', async () => {
  const { version: v } = await createQuestion(); const s = await survey();
  expect(await h.api(`/api/surveys/${s._id}/questions/from-library`, { method: 'POST', as: owner, data: { versionId: v._id, expectedRevision: s.revision + 1 } }), 409);
  expect(await h.api(`/api/surveys/${s._id}/questions/from-library`, { method: 'POST', as: peer, data: { versionId: v._id, expectedRevision: s.revision } }), 404);
  const imported = await attach(s, v); await publish(imported);
  expect(await h.api(`/api/surveys/${s._id}/questions/from-library`, { method: 'POST', as: owner, data: { versionId: v._id, expectedRevision: imported.revision } }), 409);
});

test('S13 POST及PUT不能伪造私有来源或修改内容仍保留旧版本身份', async () => {
  const { family, version: v } = await createQuestion();
  const fakePrivate = await h.api('/api/surveys', { method: 'POST', as: outsider, data: { title: '伪造引用', questions: [referenced(v)] } });
  expect(fakePrivate, 404);
  const tampered = referenced(v); tampered.title = '擅改旧版本标题';
  expect(await h.api('/api/surveys', { method: 'POST', as: owner, data: { title: '内容伪造', questions: [tampered] } }), 400);
  const clean = await survey(owner, [referenced(v)]);
  const edited = structuredClone(clean); edited.questions[0].validation.max = 999;
  expect(await h.api(`/api/surveys/${clean._id}`, { method: 'PUT', as: owner, data: { ...edited, expectedRevision: clean.revision } }), 400);
  const mismatch = referenced(v); mismatch.sourceFamilyId = new ObjectId().toHexString();
  expect(await h.api('/api/surveys', { method: 'POST', as: owner, data: { title: '题族不匹配', questions: [mismatch] } }), 400);
  const retained = expect(await h.api(`/api/surveys/${clean._id}`, { as: owner }));
  assert.equal(retained.questions[0].sourceFamilyId, family._id);
  assert.deepEqual(retained.questions, clean.questions);
});

test('S14 不能用残缺来源或同卷重复版本制造错误统计关联', async () => {
  const { version: v } = await createQuestion();
  for (const missing of ['sourceFamilyId', 'sourceVersionId']) {
    const q = referenced(v); delete q[missing];
    expect(await h.api('/api/surveys', { method: 'POST', as: owner, data: { title: '缺来源', questions: [q] } }), 400);
  }
  expect(await h.api('/api/surveys', { method: 'POST', as: owner, data: { title: '同版重复', questions: [referenced(v, 'first'), referenced(v, 'second')] } }), 400);
});

test('S15 作答来源由服务端快照决定并落库，问卷内统计兼容', async () => {
  const { family, version: v } = await createQuestion(); const s = await publish(await attach(await survey(), v));
  const submitted = await submit(s, { age: 21 }, peer, { sourceVersionId: new ObjectId().toHexString(), sourceFamilyId: new ObjectId().toHexString(), anonymous: true });
  const stored = await h.db.collection('responses').findOne({ _id: new ObjectId(submitted.id) });
  assert.equal(stored.respondentId, null);
  assert.equal(String(stored.answers[0].sourceVersionId), v._id);
  assert.equal(String(stored.answers[0].sourceFamilyId), family._id);
  assert.deepEqual(stored.path, ['age']);
  const local = expect(await h.api(`/api/surveys/${s._id}/stats/age`, { as: owner }));
  assert.equal(local.average, 21); assert.deepEqual(local.values, [21]);
});

test('S16 创建新版本不改变已发布快照和已提交回答', async () => {
  const { family, version: v1 } = await createQuestion(); const s = await publish(await attach(await survey(), v1));
  const submitted = await submit(s, { age: 12 });
  const before = expect(await h.api(`/api/public/surveys/${s._id}`, { as: peer }));
  const answerBefore = await h.db.collection('responses').findOne({ _id: new ObjectId(submitted.id) });
  await version(family, v1._id, textQuestion({ title: '年龄文字描述' }));
  assert.deepEqual(expect(await h.api(`/api/public/surveys/${s._id}`, { as: peer })), before);
  assert.deepEqual(await h.db.collection('responses').findOne({ _id: new ObjectId(submitted.id) }), answerBefore);
  await submit(s, { age: 13 });
});

test('S17 撤销共享后旧发布卷继续可填，新引用与复制被拒', async () => {
  const { family, version: v } = await createQuestion(); await share(family);
  const sharedSurvey = await publish(await attach(await survey(peer), v, peer), peer);
  await share(family, []);
  expect(await h.api(familyPath(family), { as: peer }), 404);
  await submit(sharedSurvey, { age: 25 }, outsider);
  const newDraft = await survey(peer);
  expect(await h.api(`/api/surveys/${newDraft._id}/questions/from-library`, { method: 'POST', as: peer, data: { versionId: v._id, expectedRevision: newDraft.revision } }), 404);
  expect(await h.api('/api/surveys', { method: 'POST', as: peer, data: { title: '撤销后复制', questions: [referenced(v)] } }), 404);
});

test('S18 撤销共享后原草稿仅可保留同一快照，不能换局部ID复制', async () => {
  const { family, version: v } = await createQuestion(); await share(family);
  const oldDraft = await attach(await survey(peer), v, peer);
  await share(family, []);
  const saved = expect(await h.api(`/api/surveys/${oldDraft._id}`, { method: 'PUT', as: peer, data: { ...oldDraft, title: '保留原引用仅改卷标题', expectedRevision: oldDraft.revision } }));
  assert.equal(saved.questions[0].sourceVersionId, v._id);
  const alias = structuredClone(saved); alias.questions[0].id = 'copied_age';
  expect(await h.api(`/api/surveys/${saved._id}`, { method: 'PUT', as: peer, data: { ...alias, expectedRevision: saved.revision } }), 404);
  await publish(saved, peer);
  await submit(saved, { age: 40 }, outsider);
});

test('S19 使用反查仅显示本人问卷，其他问卷只计隐藏数量', async () => {
  const { family, version: v } = await createQuestion(); await share(family);
  const mine = await attach(await survey(owner, [], { title: '本人可见问卷' }), v);
  const secret = await attach(await survey(peer, [], { title: '同事私人问卷不可泄露' }), v, peer);
  const usage = expect(await h.api(familyPath(family) + '/usage', { as: owner }));
  assert.equal(usage.surveys.length, 1); assert.equal(usage.hiddenUsageCount, 1);
  assert.equal(usage.surveys[0].surveyId, mine._id);
  assert.equal(usage.surveys[0].versionId, v._id);
  assert.ok(!JSON.stringify(usage).includes(secret._id));
  assert.ok(!JSON.stringify(usage).includes(secret.title));
  const received = expect(await h.api(familyPath(family) + '/usage', { as: peer }));
  assert.equal(received.surveys[0].surveyId, secret._id); assert.equal(received.hiddenUsageCount, 1);
  expect(await h.api(familyPath(family) + '/usage', { as: outsider }), 404);
});

test('S20 跨卷数字统计汇总本人两卷并隔离他人私有答案', async () => {
  const { family, version: v } = await createQuestion(); await share(family);
  const first = await publish(await attach(await survey(), v));
  const second = await publish(await attach(await survey(), v, owner, 'same_question_other_alias'));
  const secret = await publish(await attach(await survey(peer), v, peer), peer);
  await submit(first, { age: 20 }); await submit(second, { same_question_other_alias: 30 }); await submit(secret, { age: 99 }, outsider);
  const aggregate = await stats(family); assert.equal(aggregate.scope, 'owned-surveys');
  const result = byVersion(aggregate, v);
  assert.equal(result.surveyCount, 2); assert.equal(result.totalResponses, 2); assert.equal(result.answeredCount, 2); assert.equal(result.skippedCount, 0);
  assert.equal(result.average, 25); assert.deepEqual([...result.values].sort((a, b) => a - b), [20, 30]);
  assert.deepEqual(result.distribution, [{ value: 20, count: 1 }, { value: 30, count: 1 }]);
  const peerResult = byVersion(await stats(family, peer), v);
  assert.deepEqual(peerResult.values, [99]); assert.equal(peerResult.average, 99);
});

test('S21 同族异型版本分别统计，可显式按版本筛选', async () => {
  const { family, version: v1 } = await createQuestion();
  const v2 = await version(family, v1._id, textQuestion({ title: '年龄备注' }));
  const numeric = await publish(await attach(await survey(), v1));
  const textual = await publish(await attach(await survey(), v2));
  await submit(numeric, { age: 18 }); await submit(textual, { age: '成年人' });
  const result = await stats(family);
  assert.equal(result.versions.length, 2);
  assert.equal(byVersion(result, v1).average, 18);
  assert.deepEqual(byVersion(result, v2).values, ['成年人']);
  assert.equal(byVersion(result, v1).type, 'number'); assert.equal(byVersion(result, v2).type, 'text');
  const filtered = await stats(family, owner, v1._id);
  assert.equal(filtered.versions.length, 1); assert.equal(filtered.versions[0].versionId, v1._id);
});

test('S22 跨卷四题型的计数、原值、平均与数字频数正确', async () => {
  const questions = await Promise.all([createQuestion(choiceQuestion()), createQuestion(choiceQuestion('multiple')), createQuestion(textQuestion()), createQuestion(numberQuestion())]);
  const build = async () => {
    let s = await survey();
    for (let i = 0; i < questions.length; i++) s = await attach(s, questions[i].version, owner, `q${i}`);
    return publish(s);
  };
  const a = await build(), b = await build();
  await submit(a, { q0: 'a', q1: ['a', 'b'], q2: '第一份建议', q3: 1 });
  await submit(b, { q0: 'b', q1: ['a'], q2: '第二份建议', q3: 3 });
  const results = await Promise.all(questions.map(async q => byVersion(await stats(q.family), q.version)));
  assert.deepEqual(results[0].options.map(o => o.count), [1, 1]);
  assert.deepEqual(results[1].options.map(o => o.count), [2, 1]);
  assert.deepEqual([...results[2].values].sort(), ['第一份建议', '第二份建议'].sort());
  assert.equal(results[3].average, 2);
  assert.deepEqual(results[3].distribution, [{ value: 1, count: 1 }, { value: 3, count: 1 }]);
  assert.ok(results.every(r => r.surveyCount === 2 && r.totalResponses === 2 && r.answeredCount === 2));
});

test('S23 可选空题和跳过题不当作数值零参与跨卷平均', async () => {
  const { family, version: v } = await createQuestion(numberQuestion({ required: false }));
  const optional = await publish(await attach(await survey(), v));
  await submit(optional, {}); await submit(optional, { age: 0 });
  const gate = choiceQuestion('single', { id: 'gate', rules: [{ op: 'eq', value: 'a', target: 'END' }] });
  const skipped = await publish(await survey(owner, [gate, referenced(v)]));
  await submit(skipped, { gate: 'a' });
  const result = byVersion(await stats(family), v);
  assert.equal(result.totalResponses, 3); assert.equal(result.answeredCount, 1); assert.equal(result.skippedCount, 2);
  assert.equal(result.average, 0); assert.deepEqual(result.values, [0]); assert.deepEqual(result.distribution, [{ value: 0, count: 1 }]);
});

test('S24 同标题同局部ID的不同题族不会被错误合并', async () => {
  const a = await createQuestion(), b = await createQuestion();
  const first = await publish(await attach(await survey(), a.version));
  const second = await publish(await attach(await survey(), b.version));
  await submit(first, { age: 10 }); await submit(second, { age: 100 });
  assert.deepEqual(byVersion(await stats(a.family), a.version).values, [10]);
  assert.deepEqual(byVersion(await stats(b.family), b.version).values, [100]);
});

test('S25 题库创建成员管理和乐观锁，目录保持账号隔离', async () => {
  const { family } = await createQuestion();
  const bank = expect(await h.api('/api/library/banks', { method: 'POST', as: owner, data: { title: '常用题库', description: '用于重复组卷' } }), 201);
  assert.ok(Number.isInteger(bank.revision));
  const updated = expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: bank.title, description: bank.description, questionFamilyIds: [family._id], expectedRevision: bank.revision } }));
  assert.equal(updated.revision, bank.revision + 1); assert.deepEqual(updated.questionFamilyIds, [family._id]);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: '旧窗口', description: '', questionFamilyIds: [], expectedRevision: bank.revision } }), 409);
  assert.ok(!expect(await h.api('/api/library/banks', { as: peer })).some(x => x._id === bank._id));
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: peer, data: { title: '越权', questionFamilyIds: [], expectedRevision: updated.revision } }), 404);
});

test('S26 题库成员须可访问且不能重复，禁止越权删除', async () => {
  const hidden = await createQuestion(numberQuestion(), peer);
  const own = await createQuestion();
  const bank = expect(await h.api('/api/library/banks', { method: 'POST', as: owner, data: { title: '成员权限题库' } }), 201);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: bank.title, description: '', questionFamilyIds: [hidden.family._id], expectedRevision: bank.revision } }), 404);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: bank.title, description: '', questionFamilyIds: [own.family._id, own.family._id], expectedRevision: bank.revision } }), 400);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'DELETE', as: peer, data: {} }), 404);
});

test('S27 题库选题后新版显式选用，不自动升级既有问卷', async () => {
  const { family, version: v1 } = await createQuestion();
  const bank = expect(await h.api('/api/library/banks', { method: 'POST', as: owner, data: { title: '版本选择题库' } }), 201);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: bank.title, description: '', questionFamilyIds: [family._id], expectedRevision: bank.revision } }));
  const old = await attach(await survey(), v1);
  const v2 = await version(family, v1._id, numberQuestion({ title: '题库的新年龄题' }));
  const directory = expect(await h.api('/api/library/banks', { as: owner })).find(x => x._id === bank._id);
  assert.deepEqual(directory.questionFamilyIds, [family._id]);
  const summary = expect(await h.api('/api/library/questions', { as: owner })).find(x => x._id === family._id);
  assert.equal(summary.latestVersion._id, v2._id);
  assert.equal(expect(await h.api(`/api/surveys/${old._id}`, { as: owner })).questions[0].sourceVersionId, v1._id);
  const modern = await attach(await survey(), v2);
  assert.equal(modern.questions[0].sourceVersionId, v2._id);
  assert.equal(modern.questions[0].title, v2.question.title);
});

test('S28 删除题库不删除题目、问卷、回答及其统计', async () => {
  const { family, version: v } = await createQuestion();
  const s = await publish(await attach(await survey(), v)); await submit(s, { age: 28 });
  const bank = expect(await h.api('/api/library/banks', { method: 'POST', as: owner, data: { title: '可删除目录' } }), 201);
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'PUT', as: owner, data: { title: bank.title, description: '', questionFamilyIds: [family._id], expectedRevision: bank.revision } }));
  expect(await h.api(`/api/library/banks/${bank._id}`, { method: 'DELETE', as: owner, data: {} }));
  assert.ok(!expect(await h.api('/api/library/banks', { as: owner })).some(x => x._id === bank._id));
  expect(await h.api(familyPath(family), { as: owner }));
  expect(await h.api(`/api/surveys/${s._id}`, { as: owner }));
  assert.equal(byVersion(await stats(family), v).answeredCount, 1);
});

test('S29 新增集合验证器与族版本唯一索引真实生效', async () => {
  const { family, version: v } = await createQuestion();
  for (const collection of ['question_families', 'question_versions', 'banks']) {
    await assert.rejects(h.db.collection(collection).insertOne({ bad: true }), error => error.code === 121);
  }
  const indexes = await h.db.collection('question_versions').indexes();
  assert.ok(indexes.some(i => i.unique && i.key.familyId === 1 && i.key.versionNo === 1));
  const stored = await h.db.collection('question_versions').findOne({ _id: new ObjectId(v._id) });
  assert.equal(String(stored.familyId), family._id);
  await assert.rejects(h.db.collection('question_versions').insertOne({ ...stored, _id: new ObjectId() }), error => error.code === 11000);
});
