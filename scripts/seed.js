import { ObjectId } from 'mongodb';
import { connectDatabase } from '../src/database.js';
import { hashPassword } from '../src/auth.js';
import { randomBytes } from 'node:crypto';
import { validateDefinition, evaluateAnswers } from '../src/logic.js';
import { demoDefinition } from './demo.js';
const { client, db } = await connectDatabase();
try {
  let owner = await db.collection('users').findOne({ username: 'demo' });
  if (!owner) { owner = { _id: new ObjectId(), username: 'demo', passwordHash: await hashPassword('Demo2026!'), createdAt: new Date() }; await db.collection('users').insertOne(owner); }
  const id = new ObjectId('000000000000000000000001');
  if (!await db.collection('surveys').findOne({ _id: id })) {
    const survey = { _id: id, ownerId: owner._id, ...validateDefinition(demoDefinition()), status: 'published', revision: 1, anonymousSalt: randomBytes(32).toString('hex'), createdAt: new Date(), updatedAt: new Date() };
    await db.collection('surveys').insertOne(survey);
    const examples = [ { role: 'yes', tools: ['ai', 'book'], hours: 4, comment: '增加自习室座位' }, { role: 'no', comment: '希望开放图书馆' }, { role: 'yes', tools: ['video'], method: 'self', hours: 9 } ];
    for (let i = 0; i < examples.length; i++) await db.collection('responses').insertOne({ surveyId: id, respondentId: null, anonymous: true, revision: 1, ...evaluateAnswers(survey, examples[i]), dedupeKey: `seed-${id}-${i}`, submittedAt: new Date() });
  }
  console.log('演示数据已准备。账号 demo / Demo2026!（仅本地演示）；3份回答为明确标注的模拟数据。');
  console.log('填写链接：http://127.0.0.1:3000/survey/' + id);
} finally { await client.close(); }
