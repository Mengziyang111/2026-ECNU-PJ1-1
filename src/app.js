import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { check, HttpError } from './errors.js';
import { hashPassword, verifyPassword, newToken, sha256 } from './auth.js';
import { validateDefinition, evaluateAnswers } from './logic.js';
import { surveyStatistics } from './statistics.js';
import { handleLibraryRoute, validateSourceReferences } from './library.js';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
function oid(value) { check(/^[a-f0-9]{24}$/i.test(value), 'ID无效'); return new ObjectId(value); }
function publicUser(user) { return { id: user._id, username: user.username, createdAt: user.createdAt }; }
function publicSurvey(survey) { const { anonymousSalt, ...safe } = survey; return safe; }
function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
async function body(req) {
  check(req.headers['content-type']?.split(';')[0].trim() === 'application/json', '请求必须使用application/json', 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; check(size <= 256 * 1024, '请求超过256KB', 413); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); check(data && typeof data === 'object' && !Array.isArray(data), '请求体必须为对象'); return data; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON格式错误'); }
}
async function userFor(req, db) {
  const token = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('sid='))?.slice(4);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await db.collection('sessions').findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
  return session ? db.collection('users').findOne({ _id: session.userId }) : null;
}
export function createApplication(db) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const method = req.method;
      if (!path.startsWith('/api/')) {
        check(method === 'GET', '页面仅支持GET', 405);
        const asset = { '/app.js': ['app.js', 'text/javascript'], '/library.js': ['library.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/logic.js': ['../src/logic.js', 'text/javascript'], '/errors.js': ['../src/errors.js', 'text/javascript'], '/demo.js': ['../scripts/demo.js', 'text/javascript'] }[path];
        check(asset || path === '/' || /^\/survey\/[a-f0-9]{24}$/.test(path), '页面不存在', 404);
        const [name, mime] = asset ?? ['index.html', 'text/html'];
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        res.end(await readFile(publicRoot + name)); return;
      }
      if (!['GET', 'HEAD'].includes(method)) {
        const origin = req.headers.origin;
        check(!origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`, '跨域写入请求被拒绝', 403);
      }
      if (method === 'GET' && path === '/api/health') {
        await db.command({ ping: 1 }); send(res, 200, { status: 'ok', database: 'MongoDB' }); return;
      }
      if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) {
        const data = await body(req);
        check(typeof data.username === 'string' && typeof data.password === 'string', '请输入用户名和密码');
        const username = data.username.trim().toLowerCase();
        check(/^[\p{L}\p{N}_.-]{3,32}$/u.test(username), '用户名为3至32个字母、数字、汉字或_.-');
        check(data.password.length >= 8 && data.password.length <= 128, '密码长度为8至128位');
        let user;
        if (path.endsWith('register')) {
          user = { _id: new ObjectId(), username, passwordHash: await hashPassword(data.password), createdAt: new Date() };
          try { await db.collection('users').insertOne(user); }
          catch (error) { if (error.code === 11000) throw new HttpError(409, '用户名已注册'); throw error; }
        } else {
          user = await db.collection('users').findOne({ username });
          check(user && await verifyPassword(data.password, user.passwordHash), '用户名或密码错误', 401);
        }
        const token = newToken();
        await db.collection('sessions').insertOne({ tokenHash: sha256(token), userId: user._id, expiresAt: new Date(Date.now() + 7 * 86400000) });
        const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
        send(res, path.endsWith('register') ? 201 : 200, publicUser(user), { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}` }); return;
      }
      const user = await userFor(req, db);
      check(user, '请先登录后继续', 401);
      if (method === 'GET' && path === '/api/me') { send(res, 200, publicUser(user)); return; }
      if (method === 'POST' && path === '/api/auth/logout') {
        await body(req);
        const token = (req.headers.cookie ?? '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/)?.[1];
        if (token) await db.collection('sessions').deleteOne({ tokenHash: sha256(token) });
        send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); return;
      }
      if (await handleLibraryRoute({ db, user, req, res, url, send, readBody: body })) return;
      if (path === '/api/surveys' && method === 'GET') {
        const surveys = await db.collection('surveys').find({ ownerId: user._id }, { projection: { anonymousSalt: 0, questions: 0 } }).sort({ createdAt: -1 }).toArray();
        const counts = await db.collection('responses').aggregate([{ $match: { surveyId: { $in: surveys.map(s => s._id) } } }, { $group: { _id: '$surveyId', count: { $sum: 1 } } }]).toArray();
        send(res, 200, surveys.map(s => ({ ...s, responseCount: counts.find(c => c._id.equals(s._id))?.count ?? 0 }))); return;
      }
      if (path === '/api/surveys' && method === 'POST') {
        const definition = validateDefinition(await body(req));
        await validateSourceReferences(db, user, definition);
        const survey = { ...definition, ownerId: user._id, status: 'draft', revision: 1, anonymousSalt: randomBytes(32).toString('hex'), createdAt: new Date(), updatedAt: new Date() };
        const result = await db.collection('surveys').insertOne(survey);
        send(res, 201, publicSurvey({ ...survey, _id: result.insertedId })); return;
      }
      const publicRoute = path.match(/^\/api\/public\/surveys\/([a-f0-9]{24})(\/responses)?$/i);
      if (publicRoute) {
        check((method === 'GET' && !publicRoute[2]) || (method === 'POST' && publicRoute[2]), '接口不存在', 404);
        const survey = await db.collection('surveys').findOne({ _id: oid(publicRoute[1]) });
        check(survey, '问卷不存在', 404);
        check(survey.status === 'published', '问卷尚未发布或已关闭', 409);
        check(!survey.deadline || survey.deadline > new Date(), '问卷已截止', 410);
        if (method === 'GET') {
          const { ownerId, ...view } = publicSurvey(survey);
          send(res, 200, view); return;
        }
        const data = await body(req);
        check(data.revision === survey.revision, '问卷版本已变化，请刷新后重新填写', 409);
        check(data.anonymous === undefined || typeof data.anonymous === 'boolean', '匿名标记必须为布尔值');
        const anonymous = data.anonymous === true;
        check(!anonymous || survey.allowAnonymous, '本问卷不允许匿名提交');
        const evaluated = evaluateAnswers(survey, data.answers);
        // 匿名限制凭证使用问卷私密随机盐；统计及公开接口不暴露该值。
        const dedupeKey = survey.allowMultiple ? randomUUID() : createHmac('sha256', survey.anonymousSalt).update(user._id.toHexString()).digest('hex');
        const response = { surveyId: survey._id, respondentId: anonymous ? null : user._id, anonymous, revision: survey.revision, ...evaluated, dedupeKey, submittedAt: new Date() };
        try { const result = await db.collection('responses').insertOne(response); send(res, 201, { id: result.insertedId, submittedAt: response.submittedAt }); }
        catch (error) { if (error.code === 11000) throw new HttpError(409, '该问卷不允许重复填写，你已提交过'); throw error; }
        return;
      }
      const ownerRoute = path.match(/^\/api\/surveys\/([a-f0-9]{24})(?:\/(publish|close|stats)(?:\/([a-zA-Z0-9_-]+))?)?$/i);
      if (ownerRoute) {
        const survey = await db.collection('surveys').findOne({ _id: oid(ownerRoute[1]), ownerId: user._id });
        check(survey, '问卷不存在或无权访问', 404);
        const action = ownerRoute[2];
        if (method === 'GET' && !action) { send(res, 200, publicSurvey(survey)); return; }
        if (method === 'PUT' && !action) {
          check(survey.status === 'draft', '已发布或关闭的问卷不能修改，请新建问卷', 409);
          const input = await body(req), definition = validateDefinition(input);
          check(input.expectedRevision === survey.revision, '草稿被其他窗口修改，请刷新', 409);
          await validateSourceReferences(db, user, definition, survey);
          const updated = await db.collection('surveys').findOneAndUpdate({ _id: survey._id, status: 'draft', revision: input.expectedRevision }, { $set: { ...definition, updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
          check(updated, '草稿版本或状态已改变，请刷新', 409);
          send(res, 200, publicSurvey(updated)); return;
        }
        if (method === 'POST' && ['publish', 'close'].includes(action) && !ownerRoute[3]) {
          await body(req);
          if (action === 'publish') {
            check(survey.status === 'draft', '只有草稿可以发布', 409);
            validateDefinition(survey);
            check(survey.questions.length > 0, '至少添加一道题目');
            check(!survey.deadline || survey.deadline > new Date(), '截止时间必须晚于当前时间');
          } else check(survey.status === 'published', '只有已发布问卷可以关闭', 409);
          const result = await db.collection('surveys').updateOne({ _id: survey._id, status: survey.status, revision: survey.revision }, { $set: { status: action === 'publish' ? 'published' : 'closed', updatedAt: new Date() } });
          check(result.modifiedCount === 1, '问卷状态或版本已变化，请刷新', 409);
          send(res, 200, { ok: true }); return;
        }
        if (method === 'GET' && action === 'stats') {
          const stats = await surveyStatistics(db, survey);
          if (ownerRoute[3]) { const q = stats.questions.find(q => q.questionId === ownerRoute[3]); check(q, '题目不存在', 404); send(res, 200, { totalResponses: stats.totalResponses, ...q }); }
          else send(res, 200, stats);
          return;
        }
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      if (!res.headersSent) send(res, error.status ?? 500, { error: error.status ? error.message : '服务器内部错误' });
      else res.end();
    }
  });
}
