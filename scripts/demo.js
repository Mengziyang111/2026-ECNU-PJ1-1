export function demoDefinition() {
  return {
    title: '校园学习体验调查', description: '了解学习习惯与校园体验。共5题，预计1分钟；不同答案将进入不同题目。', allowAnonymous: true, allowMultiple: true, deadline: null,
    questions: [
      { id: 'role', title: '你目前是学生吗', type: 'single', required: true, options: [{ id: 'yes', label: '是' }, { id: 'no', label: '否' }], validation: {}, rules: [{ op: 'eq', value: 'no', target: 'comment' }] },
      { id: 'tools', title: '你常用哪些学习工具', type: 'multiple', required: true, options: [{ id: 'book', label: '教材与笔记' }, { id: 'ai', label: 'AI辅助工具' }, { id: 'video', label: '课程视频' }], validation: { minChoices: 1, maxChoices: 2 }, rules: [{ op: 'includes', value: 'ai', target: 'hours' }] },
      { id: 'method', title: '你更喜欢哪种学习方式', type: 'single', required: true, options: [{ id: 'self', label: '独立学习' }, { id: 'group', label: '小组讨论' }], validation: {}, rules: [] },
      { id: 'hours', title: '你每天自主学习多少小时', type: 'number', required: true, options: [], validation: { min: 0, max: 24, integer: true }, rules: [{ op: 'gte', value: 8, target: 'END' }] },
      { id: 'comment', title: '对校园学习环境的建议', type: 'text', required: true, options: [], validation: { minLength: 2, maxLength: 200 }, rules: [] }
    ]
  };
}
