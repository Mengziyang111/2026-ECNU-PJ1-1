import { check } from './errors.js';

const TYPES = ['single', 'multiple', 'text', 'number'];
const OPS = { single: ['eq'], multiple: ['includes', 'includesAny', 'includesAll'], text: [], number: ['eq', 'gt', 'gte', 'lt', 'lte'] };
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bounded = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export function validateDefinition(input) {
  check(plain(input), '问卷内容必须为对象');
  check(bounded(input.title, 120), '标题不能为空且不超过120字');
  check(typeof (input.description ?? '') === 'string' && (input.description ?? '').length <= 3000, '说明不超过3000字');
  for (const key of ['allowAnonymous', 'allowMultiple']) check(input[key] === undefined || typeof input[key] === 'boolean', `${key}必须为布尔值`);
  const deadline = input.deadline ? new Date(input.deadline) : null;
  check(!deadline || Number.isFinite(deadline.getTime()), '截止时间无效');
  check(Array.isArray(input.questions) && input.questions.length <= 100, '题目必须为数组且不超过100题');
  const ids = input.questions.map(q => q?.id);
  check(ids.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) && !['END', '__proto__', 'constructor', 'prototype'].includes(id)), '题目ID格式无效');
  check(new Set(ids).size === ids.length, '题目ID不能重复');
  const questions = input.questions.map((q, index) => {
    check(bounded(q.title, 300) && TYPES.includes(q.type), `第${index + 1}题的标题或类型无效`);
    check(q.required === undefined || typeof q.required === 'boolean', '必答设置必须为布尔值');
    let options = [];
    if (['single', 'multiple'].includes(q.type)) {
      check(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 50, '选择题需要2至50个选项');
      options = q.options.map(o => {
        check(plain(o) && bounded(o.id, 64) && bounded(o.label, 200), '选项ID或文字无效');
        return { id: o.id, label: o.label.trim() };
      });
      check(new Set(options.map(o => o.id)).size === options.length, '选项ID重复');
    }
    const v = q.validation ?? {};
    check(plain(v), '校验配置必须为对象');
    const allowed = q.type === 'multiple' ? ['minChoices', 'maxChoices', 'exactChoices'] : q.type === 'text' ? ['minLength', 'maxLength'] : q.type === 'number' ? ['min', 'max', 'integer'] : [];
    check(Object.keys(v).every(key => allowed.includes(key)), '校验配置包含不支持的字段');
    for (const [key, val] of Object.entries(v)) {
      if (key === 'integer') check(typeof val === 'boolean', '整数约束必须为布尔值');
      else {
        check(typeof val === 'number' && Number.isFinite(val), '校验边界必须为有限数字');
        if (q.type !== 'number') check(Number.isInteger(val) && val >= 0 && val <= (q.type === 'text' ? 10000 : options.length), '数量或长度边界不合理');
      }
    }
    for (const [min, max] of [['minChoices', 'maxChoices'], ['minLength', 'maxLength'], ['min', 'max']]) {
      check(v[min] === undefined || v[max] === undefined || v[min] <= v[max], '最小限制不能大于最大限制');
    }
    if (v.exactChoices !== undefined) check((v.minChoices === undefined || v.exactChoices >= v.minChoices) && (v.maxChoices === undefined || v.exactChoices <= v.maxChoices), '固定选项数量与范围冲突');
    const rules = q.rules ?? [];
    check(Array.isArray(rules) && rules.length <= 30, '每题跳转规则最多30条');
    const cleanRules = rules.map(r => {
      check(plain(r) && OPS[q.type].includes(r.op), '该题型不支持此跳转运算符');
      check(r.target === 'END' || ids.indexOf(r.target) > index, '跳转只能指向后续题目或END，避免循环');
      if (q.type === 'number') check(typeof r.value === 'number' && Number.isFinite(r.value), '数字跳转条件必须为数字');
      if (q.type === 'single' || r.op === 'includes') check(options.some(o => o.id === r.value), '跳转选项不存在');
      if (['includesAny', 'includesAll'].includes(r.op)) check(Array.isArray(r.value) && r.value.length > 0 && new Set(r.value).size === r.value.length && r.value.every(id => options.some(o => o.id === id)), '多选跳转条件无效');
      return { op: r.op, value: r.value, target: r.target };
    });
    const source = {};
    if (q.sourceFamilyId !== undefined || q.sourceVersionId !== undefined) {
      check(typeof q.sourceFamilyId === 'string' && /^[a-f0-9]{24}$/i.test(q.sourceFamilyId) && typeof q.sourceVersionId === 'string' && /^[a-f0-9]{24}$/i.test(q.sourceVersionId), '题目来源必须同时包含有效的题目族和版本ID');
      source.sourceFamilyId = q.sourceFamilyId.toLowerCase();
      source.sourceVersionId = q.sourceVersionId.toLowerCase();
    }
    return { id: q.id, title: q.title.trim(), type: q.type, required: q.required === true, options, validation: v, rules: cleanRules, ...source };
  });
  return { title: input.title.trim(), description: input.description ?? '', allowAnonymous: input.allowAnonymous === true, allowMultiple: input.allowMultiple === true, deadline, questions };
}

export function validateAnswer(q, value) {
  const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) { check(!q.required, `${q.title}：此题必答`); return null; }
  const v = q.validation;
  if (q.type === 'single') check(typeof value === 'string' && q.options.some(o => o.id === value), `${q.title}：请选择有效选项`);
  if (q.type === 'multiple') {
    check(Array.isArray(value) && new Set(value).size === value.length && value.every(id => typeof id === 'string' && q.options.some(o => o.id === id)), `${q.title}：多选答案含无效或重复选项`);
    check(v.minChoices === undefined || value.length >= v.minChoices, `${q.title}：至少选择${v.minChoices}项`);
    check(v.maxChoices === undefined || value.length <= v.maxChoices, `${q.title}：最多选择${v.maxChoices}项`);
    check(v.exactChoices === undefined || value.length === v.exactChoices, `${q.title}：必须选择${v.exactChoices}项`);
  }
  if (q.type === 'text') {
    check(typeof value === 'string', `${q.title}：请输入文本`);
    const len = [...value].length;
    check(len <= 10000 && (v.minLength === undefined || len >= v.minLength) && (v.maxLength === undefined || len <= v.maxLength), `${q.title}：文本长度不符合限制`);
    check(!q.required || value.trim().length > 0, `${q.title}：不能只填写空格`);
  }
  if (q.type === 'number') {
    check(typeof value === 'number' && Number.isFinite(value), `${q.title}：请输入有效数字`);
    check(!v.integer || Number.isSafeInteger(value), `${q.title}：必须为安全范围内的整数`);
    check((v.min === undefined || value >= v.min) && (v.max === undefined || value <= v.max), `${q.title}：数字超出范围`);
  }
  return value;
}

export function matches(rule, value) {
  if (value === null || value === undefined) return false;
  switch (rule.op) {
    case 'eq': return value === rule.value;
    case 'includes': return value.includes(rule.value);
    case 'includesAny': return rule.value.some(v => value.includes(v));
    case 'includesAll': return rule.value.every(v => value.includes(v));
    case 'gt': return value > rule.value;
    case 'gte': return value >= rule.value;
    case 'lt': return value < rule.value;
    case 'lte': return value <= rule.value;
    default: return false;
  }
}
export function nextQuestion(questions, index, value) {
  const rule = questions[index].rules.find(r => matches(r, value));
  return rule ? (rule.target === 'END' ? questions.length : questions.findIndex(q => q.id === rule.target)) : index + 1;
}

// 已访问前缀必须保留。未作答或暂不合法的后续题保留全部可能分支，
// 等答案确定后再清理，避免提前删掉仍可能经过的公共后续题答案。
export function pruneUnreachableAnswers(questions, answers, startIndex, visitedIds = []) {
  const reachable = new Set(visitedIds), pending = [startIndex];
  const indexById = new Map(questions.map((q, index) => [q.id, index]));
  while (pending.length) {
    const index = pending.pop();
    if (index < 0 || index >= questions.length) continue;
    const q = questions[index];
    if (reachable.has(q.id)) continue;
    reachable.add(q.id);
    let known = Object.hasOwn(answers, q.id), value;
    if (known) {
      try { value = validateAnswer(q, answers[q.id]); }
      catch { known = false; }
    }
    if (known) pending.push(nextQuestion(questions, index, value));
    else {
      pending.push(index + 1);
      for (const rule of q.rules) pending.push(rule.target === 'END' ? questions.length : (indexById.get(rule.target) ?? -1));
    }
  }
  const retained = Object.create(null);
  for (const [id, value] of Object.entries(answers)) if (reachable.has(id)) retained[id] = value;
  return retained;
}

export function evaluateAnswers(survey, answers) {
  check(plain(answers), 'answers必须为对象');
  const ids = new Set(survey.questions.map(q => q.id));
  check(Object.keys(answers).every(id => ids.has(id)), '包含不存在的题目');
  const path = [], normalized = [];
  for (let index = 0; index < survey.questions.length;) {
    const q = survey.questions[index];
    path.push(q.id);
    const value = validateAnswer(q, Object.hasOwn(answers, q.id) ? answers[q.id] : undefined);
    normalized.push({ questionId: q.id, type: q.type, value, ...(q.sourceVersionId && q.sourceFamilyId ? { sourceFamilyId: q.sourceFamilyId, sourceVersionId: q.sourceVersionId } : {}) });
    index = nextQuestion(survey.questions, index, value);
  }
  check(Object.keys(answers).every(id => path.includes(id)), '包含被跳过题目的答案，请刷新填写路径');
  return { path, answers: normalized };
}
