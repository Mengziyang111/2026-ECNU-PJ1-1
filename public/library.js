const TYPES = { single: '单选题', multiple: '多选题', text: '文本填空', number: '数字填空' };
const STATUS = { draft: '草稿', published: '收集中', closed: '已关闭' };
const copy = value => structuredClone(value);

export function createLibraryUI({ api, escape: e, toast }) {
  const $ = selector => document.querySelector(selector);
  const state = { families: [], banks: [], detail: null, draft: null, bank: null, picker: null, selectedStats: '' };
  const idOf = value => typeof value === 'string' ? value : String(value?._id ?? value?.id ?? '');
  const members = bank => (bank?.questionFamilyIds ?? []).map(idOf);
  const titleOf = family => family.latestVersion?.question?.title ?? '暂未生成版本';
  const subtitle = family => family.isOwner ? '我创建的题目' : '共享给我的题目';
  const feedback = '<p id="form-error" class="error" role="alert"></p>';
  const header = (title, text, actions = '') => `<div class="section-head"><div><div class="eyebrow">常用题目与版本</div><h1>${e(title)}</h1><p class="muted no-margin">${e(text)}</p></div><div class="row">${actions}</div></div>`;
  const tabs = selected => `<div class="library-tabs" aria-label="题目与题库"><a href="#library" ${selected === 'questions' ? 'aria-current="page"' : ''}>全部题目</a><a href="#banks" ${selected === 'banks' ? 'aria-current="page"' : ''}>我的题库</a></div>`;
  function typeDescription(question) {
    const v = question.validation ?? {};
    const labels = { minChoices: '最少选择', maxChoices: '最多选择', exactChoices: '固定选择', minLength: '最少字数', maxLength: '最多字数', min: '最小值', max: '最大值' };
    return Object.entries(v).map(([key, value]) => key === 'integer' ? (value ? '仅限整数' : '') : `${labels[key] ?? key} ${value}`).filter(Boolean).join(' · ') || '未设置额外限制';
  }
  function questionPreview(question) {
    return `<div class="question-preview"><span class="badge">${TYPES[question.type] ?? e(question.type)}</span><span class="small muted">${question.required ? '必答' : '可选'}</span><h3>${e(question.title)}</h3>${['single', 'multiple'].includes(question.type) ? `<ol class="preview-options">${(question.options ?? []).map(option => `<li>${e(option.label)} <span class="small muted">${e(option.id)}</span></li>`).join('')}</ol>` : ''}<p class="hint no-margin">${e(typeDescription(question))}</p></div>`;
  }
  async function loadOverview() {
    [state.families, state.banks] = await Promise.all([api('/library/questions'), api('/library/banks')]);
  }
  function familyCard(family) {
    const version = family.latestVersion;
    return `<article class="panel library-card"><div class="row between"><span class="badge ${family.isOwner ? 'published' : ''}">${subtitle(family)}</span><span class="small muted">${family.versionCount ?? 0} 个版本</span></div><h2>${e(titleOf(family))}</h2><p class="muted">${TYPES[version?.question?.type] ?? ''} · 当前 v${version?.versionNo ?? '—'}</p><div class="row"><a class="button secondary" href="#library/${e(family._id)}">版本与统计</a>${family.isOwner ? `<button class="quiet small" data-action="lib-edit-latest" data-id="${e(family._id)}">创建新版本</button>` : ''}</div></article>`;
  }
  async function overview() {
    await loadOverview();
    $('#app').innerHTML = header('让好问题重复使用', '保存一次题目，在多份问卷中选用具体版本。', '<a class="button" href="#library/new">＋ 创建题目</a>') + tabs('questions') + feedback + `<div class="library-notice"><p>已有问卷保留选用时的内容。更新题目会生成新版本，问卷需要显式选用；共享题只开放使用权限。</p></div><div class="grid library-grid">${state.families.length ? state.families.map(familyCard).join('') : '<div class="panel empty library-empty"><h2>先保存一道常用题</h2><p>例如年龄、年级或满意度，之后可以直接从题库选用。</p><a class="button secondary" href="#library/new">创建题目</a></div>'}</div>`;
  }
  function blankQuestion() {
    return { title: '', type: 'single', required: true, options: [{ id: 'option1', label: '' }, { id: 'option2', label: '' }], validation: {}, rules: [] };
  }
  function constraintFields(q) {
    const constraints = q.type === 'multiple' ? [['minChoices', '最少选择'], ['maxChoices', '最多选择'], ['exactChoices', '固定选择数量']] : q.type === 'text' ? [['minLength', '最少字数'], ['maxLength', '最多字数']] : q.type === 'number' ? [['min', '最小数值'], ['max', '最大数值']] : [];
    return constraints.map(([key, label]) => `<div class="field"><label for="library-${key}">${label}</label><input id="library-${key}" data-library-validation="${key}" type="number" ${q.type === 'number' ? 'step="any"' : 'min="0" step="1"'} value="${e(q.validation?.[key] ?? '')}" placeholder="不限"></div>`).join('');
  }
  function renderQuestionForm() {
    const { question: q, familyId, parentVersion, independent } = state.draft;
    const creatingVersion = familyId && !independent;
    const title = creatingVersion ? `基于 v${parentVersion.versionNo} 创建新版本` : independent ? '另存为独立题目' : '创建常用题目';
    $('#app').innerHTML = `<button class="back quiet" data-action="lib-cancel-question">← 返回题目</button>` + header(title, creatingVersion ? '保存后生成新版本，原版本和已发布问卷保持原内容。' : '题目保存后可以加入题库，并在多份问卷中复用。') + `<section class="panel library-form-panel"><form id="library-question-form"><div class="form-grid"><div class="field"><label for="library-title">题目标题</label><input id="library-title" maxlength="300" value="${e(q.title)}" required></div><div class="field"><label for="library-type">题目类型</label><select id="library-type" data-action="lib-question-type">${Object.entries(TYPES).map(([key, label]) => `<option value="${key}" ${q.type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div></div><label class="check"><input id="library-required" type="checkbox" ${q.required ? 'checked' : ''}>设为必答题</label>${['single', 'multiple'].includes(q.type) ? `<section class="top-space"><label>选项与稳定标识</label><p class="hint">创建新版本时保留未变选项的标识，新增选项分配新标识。不同版本仍会分别统计。</p>${q.options.map((option, index) => `<div class="option-row" data-library-option="${index}"><input aria-label="选项${index + 1}标识" data-library-option-id maxlength="64" value="${e(option.id)}" required><input aria-label="选项${index + 1}文字" data-library-option-label maxlength="200" value="${e(option.label)}" required><button type="button" class="quiet danger" data-action="lib-remove-option" data-index="${index}" aria-label="删除选项${index + 1}">×</button></div>`).join('')}<button type="button" class="quiet" data-action="lib-add-option">＋ 添加选项</button></section>` : ''}<div class="form-grid top-space">${constraintFields(q)}</div>${q.type === 'number' ? `<label class="check"><input id="library-integer" type="checkbox" ${q.validation?.integer ? 'checked' : ''}>只允许整数</label>` : ''}<p class="hint top-space">跳转目标由每份问卷单独配置，常用题不保存原问卷的跳转规则。</p>${feedback}<div class="row"><button type="submit">${creatingVersion ? '保存为新版本' : '保存题目'}</button><button type="button" class="secondary" data-action="lib-cancel-question">取消</button></div></form></section>`;
  }
  function collectQuestionForm() {
    const q = state.draft.question;
    q.title = $('#library-title').value;
    q.type = $('#library-type').value;
    q.required = $('#library-required').checked;
    q.options = ['single', 'multiple'].includes(q.type) ? [...document.querySelectorAll('[data-library-option]')].map(row => ({ id: row.querySelector('[data-library-option-id]').value, label: row.querySelector('[data-library-option-label]').value })) : [];
    q.validation = {};
    document.querySelectorAll('[data-library-validation]').forEach(input => { if (input.value !== '') q.validation[input.dataset.libraryValidation] = Number(input.value); });
    if ($('#library-integer')) q.validation.integer = $('#library-integer').checked;
    q.rules = [];
  }
  async function openVersionForm(familyId, versionId, independent = false) {
    const detail = await api('/library/questions/' + familyId);
    const parentVersion = detail.versions.find(version => version._id === versionId) ?? detail.versions.at(-1);
    if (!parentVersion) throw new Error('题目还没有可用版本，请刷新后重试');
    if (!independent && !detail.family.isOwner) throw new Error('共享题仅允许选用。你可以另存为自己的独立题目。');
    state.draft = { question: copy(parentVersion.question), familyId, parentVersion, independent };
    renderQuestionForm();
  }
  function versionRelation(version, versions) {
    const number = id => versions.find(item => item._id === id)?.versionNo;
    const parent = version.parentVersionId ? `来源 v${number(version.parentVersionId) ?? '?'}` : '初始版本';
    return version.restoredFromVersionId ? `${parent} · 恢复自 v${number(version.restoredFromVersionId) ?? '?'}` : parent;
  }
  function statsHTML(stats) {
    const selected = state.selectedStats ? stats.versions.filter(version => version.versionId === state.selectedStats) : stats.versions;
    return `<section class="panel top-space" id="cross-statistics"><div class="row between"><h2>跨问卷统计</h2><button class="quiet" data-action="lib-refresh-detail">刷新统计</button></div><p class="hint">仅统计你有权管理的问卷。同一版本跨问卷合并，不同版本分别展示；共享不会开放他人的答卷。</p><div class="field"><label for="statistics-version">查看版本</label><select id="statistics-version" data-action="lib-stats-version"><option value="">全部版本并排查看</option>${stats.versions.map(version => `<option value="${e(version.versionId)}" ${state.selectedStats === version.versionId ? 'selected' : ''}>v${version.versionNo} ${e(version.title)}</option>`).join('')}</select></div>${selected.length ? selected.map(version => `<article class="version-stat"><div class="row between"><h3>v${version.versionNo} ${e(version.title)}</h3><span class="badge">${TYPES[version.type] ?? e(version.type)}</span></div><p class="hint">${version.surveyCount} 份问卷 · ${version.totalResponses} 份提交 · ${version.answeredCount} 次回答 · ${version.skippedCount} 次跳过或留空</p>${version.options ? version.options.map(option => `<div class="bar-row"><span>${e(option.label)}</span><progress max="${Math.max(version.answeredCount, 1)}" value="${option.count}" aria-label="${e(option.label)} ${option.count}次"></progress><b>${option.count}</b></div>`).join('') : version.type === 'number' ? `<p><b class="answer-count">${version.average == null ? '—' : Number(version.average.toFixed(2))}</b> <span class="muted">平均值</span></p><h4>数值分布</h4>${version.distribution?.length ? `<div class="table-scroll"><table class="library-table"><thead><tr><th>数值</th><th>次数</th></tr></thead><tbody>${version.distribution.map(item => `<tr><td>${e(item.value)}</td><td>${item.count}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">暂无有效数字回答。</p>'}` : version.values?.length ? `<ul class="answers-list">${version.values.map(value => `<li>${e(value)}</li>`).join('')}</ul>` : '<p class="muted">暂无文本回答。</p>'}</article>`).join('') : '<p class="muted">暂无可统计的版本。</p>'}</section>`;
  }
  async function detail(familyId) {
    const [result, usage, stats] = await Promise.all([api('/library/questions/' + familyId), api(`/library/questions/${familyId}/usage`), api(`/library/questions/${familyId}/stats`)]);
    state.detail = { ...result, usage, stats };
    const { family, versions } = result, latest = versions.at(-1);
    const owner = family.isOwner;
    $('#app').innerHTML = '<a class="back" href="#library">← 全部题目</a>' + header(latest?.question.title ?? '题目版本', `${owner ? '由你管理' : '共享给你使用'} · ${versions.length} 个不可变版本`, latest ? `<button class="secondary" data-action="lib-independent" data-id="${e(familyId)}" data-version="${e(latest._id)}">另存为独立题</button>${owner ? `<button data-action="lib-new-version" data-id="${e(familyId)}" data-version="${e(latest._id)}">＋ 创建新版本</button>` : ''}` : '') + feedback + `<div class="library-detail-layout"><div><section class="panel"><h2>版本历史与来源</h2><p class="hint">每个版本都可以独立选用。恢复旧内容也会生成新版本。</p><ol class="version-history">${[...versions].reverse().map(version => `<li><div class="row between"><div><strong>v${version.versionNo}</strong> <span class="small muted">${e(versionRelation(version, versions))}</span>${version._id === latest?._id ? ' <span class="badge published">当前最新</span>' : ''}</div><div class="row">${owner ? `<button class="quiet small" data-action="lib-new-version" data-id="${e(familyId)}" data-version="${e(version._id)}">基于此版修改</button><button class="quiet small" data-action="lib-restore" data-id="${e(familyId)}" data-version="${e(version._id)}">恢复此版内容</button>` : ''}<button class="quiet small" data-action="lib-independent" data-id="${e(familyId)}" data-version="${e(version._id)}">另存独立题</button></div></div>${questionPreview(version.question)}</li>`).join('')}</ol></section>${statsHTML(stats)}</div><aside><section class="panel"><h2>共享使用</h2>${owner ? `<form id="library-sharing-form"><label for="library-share-users">接收者用户名</label><textarea id="library-share-users" rows="3" placeholder="多个用户名用逗号或换行分隔">${e((family.sharedUsernames ?? []).join(', '))}</textarea><p class="hint">仅支持已注册用户。清空并保存可撤销共享，既有问卷的内容仍保留。</p><button type="submit" class="secondary">保存共享设置</button></form>` : '<p class="muted">你可以在自己的问卷中选用这些版本，也可以另存独立题。版本修改与共享设置由创建者管理。</p>'}</section><section class="panel top-space"><h2>使用情况</h2><p class="hint">展示你能管理的问卷；其他用户的私人问卷仅显示使用数量。</p>${usage.surveys.length ? `<ul class="usage-list">${usage.surveys.map(survey => `<li><a href="#edit/${e(survey.surveyId)}">${e(survey.title)}</a><span class="small muted">v${survey.versionNo} · ${STATUS[survey.status] ?? e(survey.status)}</span></li>`).join('')}</ul>` : '<p class="muted">你的问卷尚未使用此题。</p>'}<p class="hint">其他用户的问卷使用：${usage.hiddenUsageCount ?? 0} 处</p></section><a class="button secondary top-space" href="#banks">整理到题库</a></aside></div>`;
  }
  async function banksView() {
    await loadOverview();
    $('#app').innerHTML = header('把题目整理成题库', '按主题归类，做问卷时从题库直接选题。', '<a class="button" href="#banks/new">＋ 创建题库</a>') + tabs('banks') + feedback + `<div class="grid library-grid">${state.banks.length ? state.banks.map(bank => `<article class="panel library-card"><span class="badge">${members(bank).length} 道题目</span><h2>${e(bank.title)}</h2><p class="muted">${e(bank.description || '暂无说明')}</p><div class="library-bank-titles">${members(bank).slice(0, 3).map(id => `<span>${e(state.families.find(family => family._id === id) ? titleOf(state.families.find(family => family._id === id)) : '共享访问已失效')}</span>`).join('')}</div><a class="button secondary" href="#banks/${e(bank._id)}">管理题库与版本</a></article>`).join('') : '<div class="panel empty library-empty"><h2>建立你的第一个题库</h2><p>题库保存题目关系，更新版本不会自动改动既有问卷。</p><a class="button secondary" href="#banks/new">创建题库</a></div>'}</div>`;
  }
  async function bankForm(bankId) {
    await loadOverview();
    const bank = bankId === 'new' ? { title: '', description: '', questionFamilyIds: [], revision: 0 } : state.banks.find(item => item._id === bankId);
    if (!bank) throw new Error('题库不存在或无权管理');
    state.bank = bank;
    renderBankForm();
  }
  function renderBankForm() {
    const bank = state.bank, selected = members(bank), unavailable = selected.filter(id => !state.families.some(family => family._id === id)).length;
    $('#app').innerHTML = '<a class="back" href="#banks">← 我的题库</a>' + header(bank._id ? '管理题库' : '创建题库', '题库引用同一道题，选用时可以选择最新版本或历史版本。') + `<section class="panel library-form-panel"><form id="library-bank-form"><div class="field"><label for="bank-title">题库名称</label><input id="bank-title" maxlength="120" value="${e(bank.title)}" required></div><div class="field"><label for="bank-description">题库说明</label><textarea id="bank-description" maxlength="3000">${e(bank.description)}</textarea></div><h2>选择题目</h2>${unavailable ? `<p class="library-warning">${unavailable} 道共享题已不可访问，保存时将从此题库中移除。既有问卷快照继续保留。</p>` : ''}${state.families.length ? `<div class="bank-members">${state.families.map(family => `<label class="bank-member"><input type="checkbox" name="bank-family" value="${e(family._id)}" ${selected.includes(family._id) ? 'checked' : ''}><span><strong>${e(titleOf(family))}</strong><span class="small muted">${subtitle(family)} · 最新 v${family.latestVersion?.versionNo ?? '—'}</span></span><a href="#library/${e(family._id)}" aria-label="查看${e(titleOf(family))}的版本">查看版本</a></label>`).join('')}</div>` : '<p class="muted">暂无可用题目。可以先保存空题库，再去创建题目。</p>'}${feedback}<div class="row top-space"><button type="submit">${bank._id ? '保存题库' : '创建题库'}</button><a href="#banks" class="button secondary">返回</a>${bank._id ? '<button type="button" class="quiet danger" data-action="lib-delete-bank-confirm">删除题库</button>' : ''}</div><div id="bank-delete-confirm" class="library-delete" hidden><p>删除题库只会移除此目录，题目、问卷和回答都会保留。</p><button type="button" class="danger" data-action="lib-delete-bank">确认删除题库</button><button type="button" class="quiet" data-action="lib-cancel-delete-bank">取消</button></div></form></section>`;
  }
  async function picker(surveyId) {
    await loadOverview();
    const survey = await api('/surveys/' + surveyId);
    if (survey.status !== 'draft') throw new Error('只有草稿可以从题库选题');
    state.picker = { survey, bankId: '', familyId: '', versionId: '', versions: [] };
    await setPickerFamily(state.families[0]?._id ?? '');
  }
  async function setPickerFamily(familyId, bankId = state.picker.bankId) {
    const picker = state.picker;
    document.querySelectorAll('#picker-bank, #picker-family, #picker-version, [data-action="lib-import"]').forEach(control => { control.disabled = true; });
    $('#app').setAttribute('aria-busy', 'true');
    try {
      const versions = familyId ? (await api('/library/questions/' + familyId)).versions : [];
      Object.assign(picker, { bankId, familyId, versions, versionId: versions.at(-1)?._id ?? '' });
      renderPicker();
    } catch (error) {
      renderPicker();
      throw error;
    } finally { $('#app').removeAttribute('aria-busy'); }
  }
  function renderPicker() {
    const picker = state.picker;
    const bank = state.banks.find(item => item._id === picker.bankId);
    const families = state.families.filter(family => !bank || members(bank).includes(family._id));
    const version = picker.versions.find(item => item._id === picker.versionId);
    const duplicate = picker.survey.questions.some(question => question.sourceVersionId === picker.versionId);
    $('#app').innerHTML = `<a class="back" href="#edit/${e(picker.survey._id)}">← 返回问卷</a>` + header('从题库选用题目', `为“${picker.survey.title}”选择一个具体版本。草稿修改已先保存。`) + `<section class="panel library-form-panel"><div class="field"><label for="picker-bank">题库范围</label><select id="picker-bank" data-action="lib-picker-bank"><option value="">全部可用题目</option>${state.banks.map(item => `<option value="${e(item._id)}" ${picker.bankId === item._id ? 'selected' : ''}>${e(item.title)}</option>`).join('')}</select></div><div class="field"><label for="picker-family">题目</label><select id="picker-family" data-action="lib-picker-family">${families.length ? families.map(family => `<option value="${e(family._id)}" ${family._id === picker.familyId ? 'selected' : ''}>${e(titleOf(family))}（${subtitle(family)}）</option>`).join('') : '<option value="">此范围暂无可用题目</option>'}</select></div><div class="field"><label for="picker-version">版本</label><select id="picker-version" data-action="lib-picker-version">${[...picker.versions].reverse().map(item => `<option value="${e(item._id)}" ${item._id === picker.versionId ? 'selected' : ''}>v${item.versionNo} · ${e(item.question.title)} · ${e(versionRelation(item, picker.versions))}</option>`).join('')}</select></div>${version ? questionPreview(version.question) : '<p class="muted">请先创建常用题，或请同事将题目共享给你。</p>'}<p class="hint">导入后固定使用所选版本。问卷中的跳转规则需要单独配置。</p>${duplicate ? '<p class="library-warning">此问卷已引用这个版本，请选择其他题目或版本。</p>' : ''}${feedback}<div class="row"><button data-action="lib-import" ${!version || duplicate ? 'disabled' : ''}>将此版本加入问卷</button><a class="button secondary" href="#edit/${e(picker.survey._id)}">返回问卷</a></div></section>`;
  }
  async function submit(form) {
    if (!['library-question-form', 'library-sharing-form', 'library-bank-form'].includes(form.id)) return false;
    if (!form.reportValidity()) return true;
    if (form.id === 'library-question-form') {
      collectQuestionForm();
      const draft = state.draft;
      let familyId = draft.familyId;
      if (familyId && !draft.independent) {
        await api(`/library/questions/${familyId}/versions`, 'POST', { parentVersionId: draft.parentVersion._id, question: draft.question });
        toast('新版本已保存，旧版本和已发布问卷保留原内容');
      } else {
        const result = await api('/library/questions', 'POST', { question: draft.question });
        familyId = result.family._id;
        toast('常用题已保存');
      }
      const destination = '#library/' + familyId;
      if (location.hash === destination) await detail(familyId);
      else location.hash = destination;
    } else if (form.id === 'library-sharing-form') {
      const usernames = [...new Set($('#library-share-users').value.split(/[\s,，;；]+/).map(name => name.trim()).filter(Boolean))];
      await api(`/library/questions/${state.detail.family._id}/sharing`, 'PUT', { usernames });
      toast(usernames.length ? '共享设置已保存' : '已撤销全部共享，既有问卷快照继续保留');
      await detail(state.detail.family._id);
    } else {
      const bank = state.bank;
      const input = { title: $('#bank-title').value, description: $('#bank-description').value, questionFamilyIds: [...document.querySelectorAll('input[name="bank-family"]:checked')].map(input => input.value) };
      if (bank._id) await api('/library/banks/' + bank._id, 'PUT', { ...input, expectedRevision: bank.revision });
      else {
        const created = await api('/library/banks', 'POST', { title: input.title, description: input.description });
        if (input.questionFamilyIds.length) await api('/library/banks/' + created._id, 'PUT', { ...input, expectedRevision: created.revision });
      }
      toast('题库已保存'); location.hash = 'banks';
    }
    return true;
  }
  async function action(name, target) {
    if (!name.startsWith('lib-')) return false;
    if (name === 'lib-cancel-question') {
      const destination = state.draft.familyId ? '#library/' + state.draft.familyId : '#library';
      if (location.hash === destination) await detail(state.draft.familyId);
      else location.hash = destination;
    }
    if (name === 'lib-edit-latest') await openVersionForm(target.dataset.id, null);
    if (name === 'lib-new-version' || name === 'lib-independent') await openVersionForm(target.dataset.id, target.dataset.version, name === 'lib-independent');
    if (name === 'lib-question-type') {
      const previous = state.draft.question.type;
      collectQuestionForm(); state.draft.question.type = target.value; state.draft.question.validation = {};
      if (['single', 'multiple'].includes(target.value) && !['single', 'multiple'].includes(previous)) state.draft.question.options = blankQuestion().options;
      renderQuestionForm();
    }
    if (name === 'lib-add-option' || name === 'lib-remove-option') {
      collectQuestionForm(); const options = state.draft.question.options;
      if (name === 'lib-add-option') { const suffix = crypto.randomUUID().slice(0, 8); options.push({ id: 'option_' + suffix, label: '' }); }
      else { if (options.length <= 2) throw new Error('选择题至少保留两个选项'); options.splice(Number(target.dataset.index), 1); }
      renderQuestionForm();
    }
    if (name === 'lib-restore') { await api(`/library/questions/${target.dataset.id}/restore`, 'POST', { versionId: target.dataset.version }); toast('旧内容已恢复为新版本，完整历史继续保留'); await detail(target.dataset.id); }
    if (name === 'lib-refresh-detail') await detail(state.detail.family._id);
    if (name === 'lib-stats-version') { state.selectedStats = target.value; $('#cross-statistics').outerHTML = statsHTML(state.detail.stats); }
    if (name === 'lib-delete-bank-confirm') $('#bank-delete-confirm').hidden = false;
    if (name === 'lib-cancel-delete-bank') $('#bank-delete-confirm').hidden = true;
    if (name === 'lib-delete-bank') { await api('/library/banks/' + state.bank._id, 'DELETE', {}); toast('题库目录已删除，题目和问卷保留'); location.hash = 'banks'; }
    if (name === 'lib-picker-bank') { const bankId = target.value; const bank = state.banks.find(item => item._id === bankId); const families = state.families.filter(family => !bank || members(bank).includes(family._id)); await setPickerFamily(families[0]?._id ?? '', bankId); }
    if (name === 'lib-picker-family') await setPickerFamily(target.value);
    if (name === 'lib-picker-version') { state.picker.versionId = target.value; renderPicker(); }
    if (name === 'lib-import') {
      const picker = state.picker;
      await api(`/surveys/${picker.survey._id}/questions/from-library`, 'POST', { versionId: picker.versionId, expectedRevision: picker.survey.revision });
      toast('题目版本已加入问卷，可以继续配置跳转'); location.hash = 'edit/' + picker.survey._id;
    }
    return true;
  }
  async function route(view, id) {
    if (view === 'library') {
      state.selectedStats = '';
      if (id === 'new') { state.draft = { question: blankQuestion() }; renderQuestionForm(); }
      else if (id) await detail(id);
      else await overview();
      return true;
    }
    if (view === 'banks') { if (id) await bankForm(id); else await banksView(); return true; }
    if (view === 'pick' && id) { await picker(id); return true; }
    return false;
  }
  async function saveSurveyQuestion(question) {
    const result = await api('/library/questions', 'POST', { question: copy(question) });
    toast('已保存为独立常用题；原问卷跳转规则不带入题库');
    return result;
  }
  return { route, action, submit, saveSurveyQuestion };
}
