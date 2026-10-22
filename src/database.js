import { MongoClient } from 'mongodb';

export const schemas = {
  users: { bsonType: 'object', required: ['username', 'passwordHash', 'createdAt'], properties: { username: { bsonType: 'string' }, passwordHash: { bsonType: 'string' }, createdAt: { bsonType: 'date' } } },
  sessions: { bsonType: 'object', required: ['tokenHash', 'userId', 'expiresAt'], properties: { tokenHash: { bsonType: 'string' }, userId: { bsonType: 'objectId' }, expiresAt: { bsonType: 'date' } } },
  surveys: { bsonType: 'object', required: ['ownerId', 'title', 'status', 'questions', 'revision', 'createdAt'], properties: { ownerId: { bsonType: 'objectId' }, title: { bsonType: 'string' }, status: { enum: ['draft', 'published', 'closed'] }, revision: { bsonType: 'int' }, questions: { bsonType: 'array' }, createdAt: { bsonType: 'date' } } },
  responses: { bsonType: 'object', required: ['surveyId', 'respondentId', 'anonymous', 'revision', 'path', 'answers', 'dedupeKey', 'submittedAt'], properties: { surveyId: { bsonType: 'objectId' }, respondentId: { bsonType: ['objectId', 'null'] }, anonymous: { bsonType: 'bool' }, revision: { bsonType: 'int' }, path: { bsonType: 'array' }, answers: { bsonType: 'array' }, dedupeKey: { bsonType: 'string' }, submittedAt: { bsonType: 'date' } } }
};
export async function connectDatabase({ uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27019', name = process.env.MONGODB_DB ?? 'survey_stage1' } = {}) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const db = client.db(name);
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
    for (const [collection, schema] of Object.entries(schemas)) {
      const validator = { $jsonSchema: schema };
      if (!existing.has(collection)) await db.createCollection(collection, { validator, validationLevel: 'strict' });
      else await db.command({ collMod: collection, validator, validationLevel: 'strict' });
    }
    await Promise.all([
      db.collection('users').createIndex({ username: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('surveys').createIndex({ ownerId: 1, createdAt: -1 }),
      db.collection('responses').createIndex({ surveyId: 1, submittedAt: -1 }),
      db.collection('responses').createIndex({ dedupeKey: 1 }, { unique: true })
    ]);
    return { client, db };
  } catch (error) { await client.close(); throw error; }
}
