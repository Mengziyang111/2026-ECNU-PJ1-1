import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDefinition, evaluateAnswers, validateAnswer, matches, pruneUnreachableAnswers } from '../src/logic.js';
import { demoDefinition } from '../scripts/demo.js';
const demo = () => validateDefinition(demoDefinition());
const valid = () => ({ role: 'yes', tools: ['ai'], hours: 4, comment: '增加座位' });
test('L01 单选跳转：被跳过的必答题不校验', () => { assert.deepEqual(evaluateAnswers(demo(), { role: 'no', comment: '增加座位' }).path, ['role', 'comment']); });
test('L02 多选跳转：AI选项跳过学习方式题', () => { assert.deepEqual(evaluateAnswers(demo(), valid()).path, ['role', 'tools', 'hours', 'comment']); });
test('L03 数值跳转：达到8小时提前结束', () => { const a = valid(); a.hours = 8; delete a.comment; assert.deepEqual(evaluateAnswers(demo(), a).path, ['role', 'tools', 'hours']); });
test('L04 未匹配规则时顺序进入下一题', () => { assert.deepEqual(evaluateAnswers(demo(), { role: 'yes', tools: ['book'], method: 'group', hours: 2, comment: '需要桌椅' }).path, ['role', 'tools', 'method', 'hours', 'comment']); });
test('L05 拒绝伪造被跳过题目的答案', () => { assert.throws(() => evaluateAnswers(demo(), { role: 'no', hours: 3, comment: '增加座位' }), /被跳过/); });
test('L06 拒绝遗漏当前路径上的必答题', () => { assert.throws(() => evaluateAnswers(demo(), { role: 'yes' }), /必答/); });
test('L07 拒绝不存在题目的答案', () => { assert.throws(() => evaluateAnswers(demo(), { ...valid(), fake: 2 }), /不存在/); });
test('L08 单选拒绝不存在的选项', () => { assert.throws(() => validateAnswer(demo().questions[0], 'fake'), /有效选项/); });
test('L09 多选数量边界与重复选项', () => { const q = demo().questions[1]; assert.throws(() => validateAnswer(q, []), /必答/); assert.throws(() => validateAnswer(q, ['book', 'ai', 'video']), /最多/); assert.throws(() => validateAnswer(q, ['ai', 'ai']), /重复/); assert.deepEqual(validateAnswer(q, ['book', 'ai']), ['book', 'ai']); q.validation = { minChoices: 2 }; assert.throws(() => validateAnswer(q, ['ai']), /至少选择2/); });
test('L10 多选支持固定选择数量', () => { const q = demo().questions[1]; q.validation = { exactChoices: 2 }; assert.throws(() => validateAnswer(q, ['ai']), /必须选择2/); assert.equal(validateAnswer(q, ['ai', 'book']).length, 2); });
test('L11 数值支持范围、整数、有限数检查', () => { const q = demo().questions[3]; for (const value of [-1, 25, 1.5, NaN, Infinity, '4']) assert.throws(() => validateAnswer(q, value)); assert.equal(validateAnswer(q, 0), 0); assert.equal(validateAnswer(q, 24), 24); });
test('L12 文本长度与全空格必答校验', () => { const q = demo().questions[4]; assert.throws(() => validateAnswer(q, '一'), /长度/); assert.throws(() => validateAnswer(q, ' '.repeat(3)), /空格/); assert.throws(() => validateAnswer(q, '长'.repeat(201)), /长度/); assert.equal(validateAnswer(q, '你好'), '你好'); });
test('L13 非必答空值不触发最小长度限制', () => { const q = demo().questions[4]; q.required = false; assert.equal(validateAnswer(q, ''), null); });
test('L14 拒绝后向或不存在目标，防止循环', () => { const s = demoDefinition(); s.questions[1].rules[0].target = 'role'; assert.throws(() => validateDefinition(s), /后续/); s.questions[1].rules[0].target = 'missing'; assert.throws(() => validateDefinition(s), /后续/); });
test('L15 拒绝冲突的校验范围与重复题目ID', () => { const s = demoDefinition(); s.questions[3].validation = { min: 10, max: 1 }; assert.throws(() => validateDefinition(s), /最小/); const d = demoDefinition(); d.questions[1].id = 'role'; assert.throws(() => validateDefinition(d), /重复/); });
test('L16 多规则重叠时第一条匹配优先', () => { const s = demoDefinition(); s.questions[3].rules = [{ op: 'gte', value: 4, target: 'comment' }, { op: 'gte', value: 4, target: 'END' }]; assert.equal(evaluateAnswers(validateDefinition(s), valid()).path.at(-1), 'comment'); });
test('L17 多选包含任意项与全部项语义', () => { assert.equal(matches({ op: 'includesAny', value: ['a', 'b'] }, ['b']), true); assert.equal(matches({ op: 'includesAll', value: ['a', 'b'] }, ['b']), false); assert.equal(matches({ op: 'includesAll', value: ['a', 'b'] }, ['b', 'a']), true); });
test('L18 数字比较边界严格区分大于与大于等于', () => { for (const [op, expected] of [['eq', true], ['gt', false], ['gte', true], ['lt', false], ['lte', true]]) assert.equal(matches({ op, value: 4 }, 4), expected); });
test('L19 非布尔设置与特殊对象键安全处理', () => { const s = demoDefinition(); s.allowMultiple = 'false'; assert.throws(() => validateDefinition(s), /布尔/); const d = demoDefinition(); d.questions[0].id = '__proto__'; assert.throws(() => validateDefinition(d), /ID/); const inherited = demoDefinition(); inherited.questions[0].id = 'toString'; inherited.questions[0].required = false; const a = valid(); delete a.role; assert.equal(evaluateAnswers(validateDefinition(inherited), a).answers[0].value, null); });
test('L20 表情按Unicode字符计数', () => { const q = demo().questions[4]; q.validation = { minLength: 2, maxLength: 2 }; assert.equal(validateAnswer(q, '😀好'), '😀好'); });
test('L21 改选首题仅清理旧分支，保留公共建议答案', () => {
  const s = demo();
  const prior = { role: 'no', tools: ['book'], method: 'group', hours: 4, comment: '保留已填写的建议' };
  const kept = pruneUnreachableAnswers(s.questions, prior, 4, ['role']);
  assert.deepEqual({ ...kept }, { role: 'no', comment: '保留已填写的建议' });
  assert.deepEqual(evaluateAnswers(s, kept).path, ['role', 'comment']);
});
test('L22 改选后新增中间题仍保留公共数字和文本答案', () => {
  const s = demo(), prior = { role: 'yes', tools: ['book'], hours: 6, comment: '保留后续回答' };
  assert.deepEqual({ ...pruneUnreachableAnswers(s.questions, prior, 2, ['role', 'tools']) }, prior);
});
test('L23 未回答的后续分支保留所有可能经过的答案', () => {
  const s = demo(), prior = { role: 'yes', method: 'group', comment: '稍后仍可能经过' };
  assert.deepEqual({ ...pruneUnreachableAnswers(s.questions, prior, 1, ['role']) }, prior);
});
test('L24 暂时不合法的后续答案不用于提前删去公共题', () => {
  const s = demo(), prior = { role: 'yes', tools: ['book'], hours: 25, comment: '仍须保留' };
  assert.deepEqual({ ...pruneUnreachableAnswers(s.questions, prior, 2, ['role', 'tools']) }, prior);
});
test('L25 提前结束时清理路径外答案并保留已访问前缀', () => {
  const s = demo(), prior = { role: 'yes', tools: ['ai'], method: 'self', hours: 8, comment: '应被清理' };
  const kept = pruneUnreachableAnswers(s.questions, prior, s.questions.length, ['role', 'tools', 'hours']);
  assert.deepEqual({ ...kept }, { role: 'yes', tools: ['ai'], hours: 8 });
  assert.deepEqual(evaluateAnswers(s, kept).path, ['role', 'tools', 'hours']);
});
