import { validateAnswer, nextQuestion, evaluateAnswers, pruneUnreachableAnswers } from '/logic.js';
import { demoDefinition } from '/demo.js';
import { createLibraryUI } from '/library.js';

const $ = s => document.querySelector(s);
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const types = { single: '单选题', multiple: '多选题', text: '文本填空', number: '数字填空' };
const statusNames = { draft: '草稿', published: '收集中', closed: '已关闭' };
const state = { user: null, authMode: 'login', editor: null, fill: null, busy: false };
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4200); }
function date(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '不限时'; }
async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, { method, credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 ${response.status}`);
  return result;
}
const library = createLibraryUI({ api, escape: e, toast });
function nav() { $('#nav').innerHTML = state.user ? `<a class="quiet" href="/">我的问卷</a><a class="quiet" href="/#library">题目</a><a class="quiet" href="/#banks">题库</a><span class="small muted">${e(state.user.username)}</span><button class="quiet small" data-action="logout">退出</button>` : '<span class="small muted">在线问卷与结果统计</span>'; }
function errorPage(message) { $('#app').innerHTML = `<div class="panel empty"><h2>暂时无法继续</h2><p>${e(message)}</p><a class="button secondary" href="/">返回我的问卷</a></div>`; }
function authView() {
  nav();
  const register = state.authMode === 'register';
  $('#app').innerHTML = `<div class="auth-layout"><section class="auth-hero"><div class="eyebrow">A QUESTION STARTS A CONVERSATION</div><h1>从一个好问题<br>到每一个真实回答</h1><p class="lead">创建问卷，设置作答路径，<br>让分散的声音成为清晰的洞察。</p><div class="hero-visual" aria-hidden="true"><div class="small muted">一份关于学习的问卷</div><div class="hero-line"></div><div class="hero-line short"></div><div class="hero-answer"><span class="hero-dot checked"></span>每一次选择，都值得倾听</div><div class="hero-answer"><span class="hero-dot"></span>让回答自然发生</div></div></section><section class="panel auth-panel"><div class="eyebrow">欢迎来到问序</div><h2>${register ? '创建你的账号' : '登录，开始收集答案'}</h2><p class="muted">${location.pathname.startsWith('/survey/') ? '登录后即可填写这份问卷，允许匿名时可隐藏身份。' : '管理你的问卷，随时查看结果。'}</p><form id="auth-form"><div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" minlength="3" maxlength="32" placeholder="3至32个字母、数字或汉字" required></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" placeholder="至少8位" required></div><p id="form-error" class="error" role="alert"></p><button type="submit">${register ? '注册并登录' : '登录'}</button></form><p class="small muted top-space">${register ? '已经有账号？' : '第一次使用？'}<button class="quiet" data-action="auth-toggle">${register ? '去登录' : '注册账号'}</button></p></section></div>`;
}
async function dashboard() {
  const surveys = await api('/surveys');
  const totals = surveys.reduce((sum, s) => sum + s.responseCount, 0);
  const active = surveys.filter(s => s.status === 'published' && (!s.deadline || new Date(s.deadline) > new Date())).length;
  $('#app').innerHTML = `<div class="section-head"><div><div class="eyebrow">你的问卷工作台</div><h1>把问题交给世界</h1><p class="muted no-margin">从创建到洞察，在这里完成。</p></div><button data-action="new">＋ 创建问卷</button></div><div class="grid metrics"><div class="metric"><b>${surveys.length}</b><span>全部问卷</span></div><div class="metric"><b>${active}</b><span>正在收集</span></div><div class="metric"><b>${totals}</b><span>收到的回答</span></div></div><div class="section-head"><h2 class="no-margin">我的问卷</h2><button class="quiet small" data-action="demo">用示例问卷开始 →</button></div>${surveys.length ? `<div class="grid">${surveys.map(s => `<article class="panel survey-card"><div class="row between"><span class="badge ${s.status}">${s.status === 'published' && s.deadline && new Date(s.deadline) <= new Date() ? '已截止' : statusNames[s.status]}</span><span class="small muted">${s.responseCount} 份回答</span></div><h3>${e(s.title)}</h3><p>${e(s.description || '暂无说明')}</p><div class="small muted">截止 ${date(s.deadline)}</div><div class="row"><a class="button secondary" href="#edit/${s._id}">${s.status === 'draft' ? '编辑问卷' : '查看问卷'}</a><a class="button secondary" href="#stats/${s._id}">查看统计</a>${s.status === 'published' ? `<button class="quiet" data-action="copy" data-id="${s._id}">复制链接</button>` : ''}</div></article>`).join('')}</div>` : '<div class="panel empty"><h2>你的第一份问卷，从这里开始</h2><p>支持单选、多选、文本与数字填空，按回答自动跳转。</p><button data-action="new">创建第一份问卷</button></div>'}`;
}
function localDate(value) { if (!value) return ''; const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function field(label, input, hint = '') { return `<div class="field"><label>${label}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`; }
function ruleHTML(q, r, ri, qi, locked) {
  const ops = q.type === 'number' ? { eq: '等于', gt: '大于', gte: '大于或等于', lt: '小于', lte: '小于或等于' } : q.type === 'single' ? { eq: '选择' } : { includes: '包含选项', includesAny: '包含任一项', includesAll: '包含全部项' };
  const multi = ['includesAny', 'includesAll'].includes(r.op);
  const condition = q.type === 'number' ? `<input aria-label="条件数值" data-r-value type="number" step="any" value="${e(r.value)}" required>` : `<select aria-label="触发选项" data-r-value ${multi ? 'multiple' : ''}>${q.options.map(o => `<option value="${e(o.id)}" ${(multi ? r.value.includes(o.id) : r.value === o.id) ? 'selected' : ''}>${e(o.label)}</option>`).join('')}</select>`;
  const targets = state.editor.questions.slice(qi + 1).map((t, i) => `<option value="${e(t.id)}" ${r.target === t.id ? 'selected' : ''}>第${qi + i + 2}题 ${e(t.title)}</option>`).join('');
  return `<div class="rule-row" data-rule="${ri}"><select aria-label="跳转条件" data-r-op data-q="${qi}" data-ri="${ri}" data-action="rule-op">${Object.entries(ops).map(([k, label]) => `<option value="${k}" ${k === r.op ? 'selected' : ''}>${label}</option>`).join('')}</select>${condition}<select aria-label="跳转目标" data-r-target>${targets}<option value="END" ${r.target === 'END' ? 'selected' : ''}>结束问卷</option></select>${locked ? '' : `<button class="quiet danger" data-action="remove-rule" data-q="${qi}" data-ri="${ri}" aria-label="删除规则">×</button>`}</div>`;
}
function questionHTML(q, qi, locked) {
  const options = ['single', 'multiple'].includes(q.type);
  const referenced = Boolean(q.sourceVersionId), contentLocked = locked || referenced;
  const constraints = q.type === 'multiple' ? [['minChoices', '最少选择'], ['maxChoices', '最多选择'], ['exactChoices', '固定选择数量']] : q.type === 'text' ? [['minLength', '最少字数'], ['maxLength', '最多字数']] : q.type === 'number' ? [['min', '最小数值'], ['max', '最大数值']] : [];
  return `<section class="panel q-editor" data-question="${qi}" id="question-${qi}"><div class="q-head"><span class="q-number">QUESTION ${String(qi + 1).padStart(2, '0')}</span><div class="row"><button class="quiet small" data-action="save-library-question" data-q="${qi}">另存到常用题</button>${locked ? '' : `<button class="quiet danger" data-action="remove-question" data-q="${qi}">删除题目</button>`}</div></div>${referenced ? `<div class="library-source"><span class="badge published">引用固定题目版本</span><a href="#library/${e(q.sourceFamilyId)}">查看版本与统计</a><p class="hint no-margin">题目内容保持选用时的版本。要更改内容，请在版本页创建新版本，再从题库选用；本问卷仍可独立配置跳转。</p></div>` : ''}<fieldset ${contentLocked ? 'disabled' : ''} class="fieldset"><div class="form-grid">${field('题目标题', `<input data-q-title value="${e(q.title)}" maxlength="300" required>`)}${field('题目类型', `<select data-q-type data-action="question-type" data-q="${qi}">${Object.entries(types).map(([value, label]) => `<option value="${value}" ${q.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`)}</div><label class="check"><input data-q-required type="checkbox" ${q.required ? 'checked' : ''}>设为必答题</label>${options ? `<div class="top-space"><label>选项</label>${q.options.map((o, oi) => `<div class="option-row" data-option="${e(o.id)}"><span class="small muted">${String.fromCharCode(65 + oi)}</span><input aria-label="选项${oi + 1}" data-option-label value="${e(o.label)}" maxlength="200" required>${contentLocked ? '' : `<button class="quiet" data-action="remove-option" data-q="${qi}" data-oi="${oi}" aria-label="删除选项">×</button>`}</div>`).join('')}${contentLocked ? '' : `<button class="quiet small" data-action="add-option" data-q="${qi}">＋ 添加选项</button>`}</div>` : ''}${constraints.length ? `<div class="form-grid top-space">${constraints.map(([key, label]) => field(label, `<input data-v="${key}" type="number" ${q.type !== 'number' ? 'min="0" step="1"' : 'step="any"'} value="${e(q.validation[key] ?? '')}" placeholder="不限">`)).join('')}</div>` : ''}${q.type === 'number' ? `<label class="check"><input data-v-integer type="checkbox" ${q.validation.integer ? 'checked' : ''}>只允许整数</label>` : ''}</fieldset>${q.type !== 'text' ? `<fieldset ${locked ? 'disabled' : ''} class="fieldset rules"><div class="row between"><label class="no-margin">根据回答跳转</label>${locked ? '' : `<button class="quiet small" data-action="add-rule" data-q="${qi}">＋ 添加规则</button>`}</div><p class="hint">从上到下匹配，命中第一条后跳转；未命中则进入下一题。仅允许向后跳转。${q.type === 'multiple' ? '多选条件中的多项选择可按住 Ctrl 点选。' : ''}</p>${q.rules.map((r, ri) => ruleHTML(q, r, ri, qi, locked)).join('')}</fieldset>` : ''}</section>`;
}
function editorView() {
  const s = state.editor, locked = s.status !== 'draft';
  $('#app').innerHTML = `<a class="back" href="#">← 我的问卷</a><div class="section-head"><div><div class="eyebrow">问卷编辑</div><h1>${e(s.title)}</h1><span class="badge ${s.status}">${statusNames[s.status]}</span>${locked ? '<span class="locked">　发布后内容已锁定</span>' : ''}</div><div class="row">${locked ? `<button class="secondary" data-action="copy" data-id="${s._id}">复制填写链接</button>${s.status === 'published' ? '<button class="danger" data-action="close">关闭问卷</button>' : ''}` : '<button class="secondary" data-action="save">保存草稿</button><button data-action="publish">发布问卷</button>'}</div></div><p id="form-error" class="error" role="alert"></p><div class="editor-layout"><aside class="panel editor-sidebar"><h3>问卷目录</h3><a href="#" data-action="scroll-settings">问卷设置</a>${s.questions.map((q, i) => `<a href="#" data-action="scroll-question" data-q="${i}">${i + 1}. ${e(q.title || '未命名题目')}</a>`).join('')}<hr><p class="hint">${s.questions.length} 道题目<br>${locked ? '发布后的问卷保持原始内容。' : '保存草稿后再发布，即可分享填写链接。'}</p>${locked ? `<a class="button secondary" href="#stats/${s._id}">查看统计</a>` : '<div class="library-editor-buttons"><button class="secondary" data-action="add-question">＋ 添加题目</button><button class="secondary" data-action="pick-library">从题库选题</button></div>'}</aside><div class="editor-main"><section class="panel" id="settings"><h2>问卷设置</h2><fieldset ${locked ? 'disabled' : ''} class="fieldset">${field('问卷标题', `<input id="survey-title" value="${e(s.title)}" maxlength="120" required>`)}${field('问卷说明', `<textarea id="survey-description" maxlength="3000">${e(s.description)}</textarea>`)}<div class="form-grid">${field('截止时间', `<input id="survey-deadline" type="datetime-local" value="${localDate(s.deadline)}">`, '留空表示不限时；按本机时区填写。')}<div class="field"><label>填写设置</label><label class="check"><input id="survey-anonymous" type="checkbox" ${s.allowAnonymous ? 'checked' : ''}>允许匿名提交</label><label class="check"><input id="survey-multiple" type="checkbox" ${s.allowMultiple ? 'checked' : ''}>允许同一账号多次填写</label></div></div><p class="hint">所有填写者都需要先登录。匿名提交后，统计结果不显示账号。</p></fieldset></section>${s.questions.map((q, qi) => questionHTML(q, qi, locked)).join('')}${locked ? '' : '<div class="row"><button class="secondary" data-action="add-question">＋ 添加下一道题目</button><button class="secondary" data-action="pick-library">从题库选题</button></div>'}</div></div>`;
}
function collectEditor() {
  const s = state.editor;
  if (!s || s.status !== 'draft') return;
  s.title = $('#survey-title').value; s.description = $('#survey-description').value;
  s.deadline = $('#survey-deadline').value ? new Date($('#survey-deadline').value).toISOString() : null;
  s.allowAnonymous = $('#survey-anonymous').checked; s.allowMultiple = $('#survey-multiple').checked;
  document.querySelectorAll('[data-question]').forEach(card => {
    const q = s.questions[Number(card.dataset.question)];
    if (!q.sourceVersionId) {
      q.title = card.querySelector('[data-q-title]').value; q.required = card.querySelector('[data-q-required]').checked;
      q.options = [...card.querySelectorAll('[data-option]')].map(row => ({ id: row.dataset.option, label: row.querySelector('input').value }));
      q.validation = {};
      card.querySelectorAll('[data-v]').forEach(input => { if (input.value !== '') q.validation[input.dataset.v] = Number(input.value); });
      if (card.querySelector('[data-v-integer]')) q.validation.integer = card.querySelector('[data-v-integer]').checked;
    }
    q.rules = [...card.querySelectorAll('[data-rule]')].map(row => {
      const op = row.querySelector('[data-r-op]').value, input = row.querySelector('[data-r-value]');
      const value = q.type === 'number' ? (input.value === '' ? null : Number(input.value)) : ['includesAny', 'includesAll'].includes(op) ? [...input.selectedOptions].map(o => o.value) : input.value;
      return { op, value, target: row.querySelector('[data-r-target]').value };
    });
  });
}
async function saveEditor() {
  collectEditor();
  state.editor = await api('/surveys/' + state.editor._id, 'PUT', { ...state.editor, expectedRevision: state.editor.revision });
  editorView();
}
async function statistics(id) {
  const s = await api(`/surveys/${id}/stats`);
  $('#app').innerHTML = `<a class="back" href="#">← 我的问卷</a><div class="section-head"><div><div class="eyebrow">回答与洞察</div><h1>${e(s.title)}</h1><p class="muted">根据已提交的回答实时汇总。</p></div><button class="secondary" data-action="refresh">刷新结果</button></div><div class="metric"><b>${s.totalResponses}</b><span>已收到的回答</span></div>${s.questions.map((q, i) => `<section class="panel stats-question"><span class="q-number">QUESTION ${String(i + 1).padStart(2, '0')} · ${types[q.type]}</span><h2>${e(q.title)}</h2><p class="hint">${q.answeredCount} 人回答 · ${q.skippedCount} 人跳过或未填写</p>${q.options ? q.options.map(o => `<div class="bar-row"><span>${e(o.label)}</span><progress max="${Math.max(q.answeredCount, 1)}" value="${o.count}" aria-label="${e(o.label)} ${o.count}次"></progress><b>${o.count}</b></div>`).join('') : `${q.type === 'number' ? `<div><span class="answer-count">${q.average === null ? '—' : Number(q.average.toFixed(2))}</span><span class="muted"> 平均值</span></div>` : ''}${q.values.length ? `<ul class="answers-list">${q.values.map(v => `<li>${e(v)}</li>`).join('')}</ul>` : '<p class="muted">暂时还没有回答。</p>'}`}</section>`).join('')}`;
}

function fillView() {
  $('#toast').hidden = true;
  const f = state.fill, s = f.survey;
  if (f.finished) {
    $('#app').innerHTML = `<div class="fill-wrap"><div class="panel fill-intro"><span class="eyebrow">准备提交</span><h1>${e(s.title)}</h1><p class="muted">已完成本次作答路径。你可以返回修改，或确认提交。</p><p class="small">本次经过 ${f.path.length} 道题目</p></div><div class="panel">${f.path.map(index => { const q = s.questions[index], value = f.answers[q.id]; const text = q.type === 'single' ? q.options.find(o => o.id === value)?.label : q.type === 'multiple' && Array.isArray(value) ? value.map(v => q.options.find(o => o.id === v)?.label).join('、') : value; return `<div class="field"><label>${e(q.title)}</label><div>${e(text ?? '未填写')}</div></div>`; }).join('')}${s.allowAnonymous ? '<label class="check"><input id="submit-anonymous" type="checkbox">匿名提交，不在回答中关联账号</label>' : ''}<p id="form-error" class="error" role="alert"></p><div class="row between fill-actions"><button class="secondary" data-action="fill-back">← 返回修改</button><button data-action="submit-response">确认提交</button></div></div></div>`; return;
  }
  const index = f.path.at(-1), q = s.questions[index], val = f.answers[q.id];
  let control;
  if (q.type === 'single' || q.type === 'multiple') control = q.options.map(o => `<label class="choice"><input type="${q.type === 'single' ? 'radio' : 'checkbox'}" name="answer" value="${e(o.id)}" ${(q.type === 'single' ? val === o.id : Array.isArray(val) && val.includes(o.id)) ? 'checked' : ''}>${e(o.label)}</label>`).join('');
  else if (q.type === 'number') control = '<input id="answer-value" aria-label="数字答案" type="number" step="any" placeholder="请输入数字" value="' + e(val ?? '') + '">';
  else control = `<textarea id="answer-value" aria-label="文本答案" maxlength="10000" rows="4" placeholder="写下你的回答">${e(val ?? '')}</textarea>`;
  const v = q.validation;
  const hints = q.type === 'multiple' ? [v.minChoices !== undefined && `至少${v.minChoices}项`, v.maxChoices !== undefined && `最多${v.maxChoices}项`, v.exactChoices !== undefined && `选择${v.exactChoices}项`] : q.type === 'number' ? [v.min !== undefined && `最小${v.min}`, v.max !== undefined && `最大${v.max}`, v.integer && '仅限整数'] : q.type === 'text' ? [v.minLength !== undefined && `至少${v.minLength}字`, v.maxLength !== undefined && `最多${v.maxLength}字`] : [];
  $('#app').innerHTML = `<div class="fill-wrap"><section class="panel fill-intro"><div class="eyebrow">问序在线调查</div><h1>${e(s.title)}</h1><p class="muted">${e(s.description)}</p><div class="small muted">截止 ${date(s.deadline)} · ${s.allowMultiple ? '允许多次填写' : '每个账号限填一次'}</div><div class="fill-progress"><progress max="${s.questions.length}" value="${index + 1}" aria-label="作答进度"></progress></div><div class="row between small muted"><span>第 ${index + 1} 题 / 共 ${s.questions.length} 题</span><span>按回答自动跳转</span></div></section><section class="panel fill-question"><div class="q-number">${types[q.type]}</div><h2>${e(q.title)} ${q.required ? '<span class="required">*</span>' : ''}</h2><p class="hint">${hints.filter(Boolean).join(' · ') || (q.required ? '此题必答' : '此题可跳过')}</p>${control}<p id="form-error" class="error" role="alert"></p><div class="row between fill-actions">${f.path.length > 1 ? '<button class="secondary" data-action="fill-back">← 上一题</button>' : '<span></span>'}<button data-action="fill-next">下一步 →</button></div></section></div>`;
}
function readCurrentAnswer() {
  const f = state.fill, q = f.survey.questions[f.path.at(-1)];
  if (q.type === 'single') return document.querySelector('input[name=answer]:checked')?.value ?? null;
  if (q.type === 'multiple') return [...document.querySelectorAll('input[name=answer]:checked')].map(i => i.value);
  if (q.type === 'number') return $('#answer-value').value === '' ? null : Number($('#answer-value').value);
  return $('#answer-value').value;
}
async function route() {
  nav();
  if (!state.user) { authView(); return; }
  $('#app').innerHTML = '<p class="muted">正在加载…</p>';
  try {
    const match = location.pathname.match(/^\/survey\/([a-f0-9]{24})$/);
    if (match) { const survey = await api('/public/surveys/' + match[1]); state.fill = { survey, path: [0], answers: Object.create(null), finished: false }; fillView(); return; }
    const [view, id] = location.hash.slice(1).split('/');
    if (view === 'edit' && id) { state.editor = await api('/surveys/' + id); editorView(); }
    else if (view === 'stats' && id) await statistics(id);
    else if (!await library.route(view, id)) await dashboard();
  } catch (error) { errorPage(error.message); }
}
function uid(prefix) { return prefix + '_' + crypto.randomUUID().slice(0, 8); }
document.addEventListener('submit', async event => {
  if (event.target.id !== 'auth-form' && !['library-question-form', 'library-sharing-form', 'library-bank-form'].includes(event.target.id)) return;
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  const button = event.target.querySelector('button[type=submit]'); button.disabled = true;
  try {
    if (event.target.id === 'auth-form') { state.user = await api('/auth/' + state.authMode, 'POST', { username: $('#username').value, password: $('#password').value }); await route(); }
    else await library.submit(event.target);
  }
  catch (error) { if ($('#form-error')) $('#form-error').textContent = error.message; toast(error.message); }
  finally { state.busy = false; button.disabled = false; }
});
async function action(name, target) {
  const qi = Number(target.dataset.q), ri = Number(target.dataset.ri);
  if (await library.action(name, target)) return;
  if (name === 'auth-toggle') { state.authMode = state.authMode === 'login' ? 'register' : 'login'; authView(); return; }
  if (name === 'logout') { await api('/auth/logout', 'POST', {}); state.user = null; await route(); return; }
  if (name === 'refresh') { await route(); return; }
  if (name === 'new' || name === 'demo') {
    const data = name === 'demo' ? demoDefinition() : { title: '未命名问卷', description: '', allowAnonymous: false, allowMultiple: false, questions: [] };
    const s = await api('/surveys', 'POST', data); location.hash = 'edit/' + s._id; return;
  }
  if (name === 'copy') { const link = location.origin + '/survey/' + target.dataset.id; try { await navigator.clipboard.writeText(link); toast('填写链接已复制'); } catch { toast('填写链接：' + link); } return; }
  if (name === 'scroll-settings') { $('#settings').scrollIntoView({ behavior: 'smooth' }); return; }
  if (name === 'scroll-question') { $('#question-' + qi).scrollIntoView({ behavior: 'smooth' }); return; }
  if (name === 'fill-next') {
    const f = state.fill, index = f.path.at(-1), q = f.survey.questions[index];
    f.answers[q.id] = validateAnswer(q, readCurrentAnswer());
    const next = nextQuestion(f.survey.questions, index, f.answers[q.id]);
    f.answers = pruneUnreachableAnswers(f.survey.questions, f.answers, next, f.path.map(i => f.survey.questions[i].id));
    if (next === f.survey.questions.length) f.finished = true; else f.path.push(next);
    fillView(); window.scrollTo(0, 0); return;
  }
  if (name === 'fill-back') {
    const f = state.fill;
    if (f.finished) f.finished = false;
    else if (f.path.length > 1) {
      f.answers[f.survey.questions[f.path.at(-1)].id] = readCurrentAnswer();
      f.path.pop();
    }
    fillView(); return;
  }
  if (name === 'submit-response') {
    const f = state.fill; evaluateAnswers(f.survey, f.answers);
    await api('/public/surveys/' + f.survey._id + '/responses', 'POST', { revision: f.survey.revision, answers: f.answers, anonymous: $('#submit-anonymous')?.checked ?? false });
    $('#app').innerHTML = '<div class="fill-wrap panel success"><div class="success-mark">✓</div><h1>回答已收到</h1><p class="muted">感谢你的认真填写，每一个回答都已保存。</p><a class="button secondary" href="/">返回我的问卷</a></div>'; return;
  }
  if (name === 'save') { await saveEditor(); toast('草稿已保存'); return; }
  if (name === 'pick-library') { await saveEditor(); location.hash = 'pick/' + state.editor._id; return; }
  if (name === 'save-library-question') {
    if (state.editor.status === 'draft') await saveEditor();
    await library.saveSurveyQuestion(state.editor.questions[qi]); return;
  }
  if (name === 'publish') { await saveEditor(); await api(`/surveys/${state.editor._id}/publish`, 'POST', {}); toast('发布成功，可以复制链接邀请填写'); await route(); return; }
  if (name === 'close') { await api(`/surveys/${state.editor._id}/close`, 'POST', {}); toast('问卷已关闭'); await route(); return; }
  collectEditor();
  const s = state.editor, q = s?.questions[qi];
  if (name === 'add-question') s.questions.push({ id: uid('q'), title: `第${s.questions.length + 1}道题目`, type: 'single', required: true, options: [{ id: uid('o'), label: '选项一' }, { id: uid('o'), label: '选项二' }], validation: {}, rules: [] });
  if (name === 'remove-question') { const removed = s.questions.splice(qi, 1)[0]; s.questions.forEach(q => q.rules = q.rules.filter(r => r.target !== removed.id)); }
  if (name === 'question-type') { q.type = target.value; q.validation = {}; q.rules = []; if (['single', 'multiple'].includes(q.type) && q.options.length === 0) q.options = [{ id: uid('o'), label: '选项一' }, { id: uid('o'), label: '选项二' }]; }
  if (name === 'add-option') q.options.push({ id: uid('o'), label: `选项${q.options.length + 1}` });
  if (name === 'remove-option') { if (q.options.length <= 2) throw new Error('选择题至少保留两个选项'); q.options.splice(Number(target.dataset.oi), 1); q.rules = []; }
  if (name === 'add-rule') { q.rules.push({ op: q.type === 'multiple' ? 'includes' : 'eq', value: q.type === 'number' ? 0 : q.options[0]?.id, target: s.questions[qi + 1]?.id ?? 'END' }); }
  if (name === 'remove-rule') q.rules.splice(ri, 1);
  if (name === 'rule-op') { const r = q.rules[ri]; if (['includesAny', 'includesAll'].includes(target.value) && !Array.isArray(r.value)) r.value = [r.value]; else if (!['includesAny', 'includesAll'].includes(target.value) && Array.isArray(r.value)) r.value = r.value[0] ?? q.options[0]?.id; }
  editorView();
  if (name === 'add-question') $('#question-' + (s.questions.length - 1)).scrollIntoView({ behavior: 'smooth' });
}
async function dispatch(event) {
  const target = event.target.closest('[data-action]');
  if (!target || (event.type === 'click' && target.tagName === 'SELECT') || (event.type === 'change' && target.tagName !== 'SELECT')) return;
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  const button = target.tagName === 'BUTTON' ? target : null;
  if (button) button.disabled = true;
  try { await action(target.dataset.action, target); }
  catch (error) { if ($('#form-error')) $('#form-error').textContent = error.message; toast(error.message); }
  finally { state.busy = false; if (button) button.disabled = false; }
}
document.addEventListener('click', dispatch);
document.addEventListener('change', dispatch);
window.addEventListener('hashchange', route);
try { state.user = await api('/me'); } catch { state.user = null; }
await route();
