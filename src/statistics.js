export async function surveyStatistics(db, survey) {
  const id = survey._id;
  const totalResponses = await db.collection('responses').countDocuments({ surveyId: id });
  const grouped = await db.collection('responses').aggregate([
    { $match: { surveyId: id } }, { $unwind: '$answers' },
    { $match: { 'answers.value': { $ne: null } } },
    { $group: { _id: '$answers.questionId', answeredCount: { $sum: 1 }, values: { $push: '$answers.value' }, average: { $avg: { $cond: [{ $eq: ['$answers.type', 'number'] }, '$answers.value', null] } } } }
  ]).toArray();
  const byId = new Map(grouped.map(row => [row._id, row]));
  return { surveyId: id, title: survey.title, totalResponses, questions: survey.questions.map(q => {
    const row = byId.get(q.id) ?? { answeredCount: 0, values: [], average: null };
    const result = { questionId: q.id, title: q.title, type: q.type, answeredCount: row.answeredCount, skippedCount: totalResponses - row.answeredCount };
    if (q.type === 'single' || q.type === 'multiple') result.options = q.options.map(o => ({ ...o, count: row.values.filter(v => q.type === 'single' ? v === o.id : v.includes(o.id)).length }));
    else result.values = row.values;
    if (q.type === 'number') result.average = row.average;
    return result;
  }) };
}
