import assert from 'node:assert/strict';
import { connectDatabase } from '../src/database.js';
import { createApplication } from '../src/app.js';

let sequence = 0;
export const password = 'Stage2Test2026!';
export async function openHarness(kind) {
  assert.ok(['stage2', 'migration'].includes(kind));
  const name = `survey_${kind}_test_${Date.now()}_${process.pid}_${++sequence}`;
  const connection = await connectDatabase({ name });
  const server = createApplication(connection.db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(path, { method = 'GET', as, data } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(as?.cookie ? { Cookie: as.cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const text = await response.text();
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }
  async function register(username) {
    const result = await api('/api/auth/register', { method: 'POST', data: { username, password } });
    expect(result, 201);
    return { ...result.body, cookie: result.cookie };
  }
  async function close() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.match(connection.db.databaseName, /^survey_(stage2|migration)_test_\d+_\d+_\d+$/);
    await connection.db.dropDatabase();
    await connection.client.close();
  }
  return { ...connection, server, base, api, register, close };
}
export function expect(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}
export const numberQuestion = (overrides = {}) => ({ id: 'age', title: '你的年龄', type: 'number', required: true, options: [], validation: { min: 0, max: 120, integer: true }, rules: [], ...overrides });
export const textQuestion = (overrides = {}) => ({ id: 'comment', title: '意见', type: 'text', required: true, options: [], validation: { minLength: 1, maxLength: 200 }, rules: [], ...overrides });
export const choiceQuestion = (type = 'single', overrides = {}) => ({ id: 'choice', title: '选择偏好', type, required: true, options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }], validation: {}, rules: [], ...overrides });
