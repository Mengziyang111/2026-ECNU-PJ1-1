# API说明

根地址默认 `http://127.0.0.1:3000/api`。请求与响应使用JSON，写请求必须带 `Content-Type: application/json`。登录和注册通过 `Set-Cookie` 建立HttpOnly会话；浏览器自动携带，API工具需保存Cookie。除健康检查、注册和登录外均需登录。

## 接口表

| 方法 | 路径 | 功能与成功状态 |
| --- | --- | --- |
| GET | `/health` | MongoDB连通性，200 |
| POST | `/auth/register` | `{username,password}`，注册并登录，201 |
| POST | `/auth/login` | `{username,password}`，登录，200 |
| POST | `/auth/logout` | `{}`，删除当前会话，200 |
| GET | `/me` | 当前用户id、username、createdAt，200 |
| GET | `/surveys` | 仅当前用户的问卷及responseCount，200 |
| POST | `/surveys` | 创建草稿，返回问卷及_id、revision，201 |
| GET | `/surveys/:id` | 创建者读取完整定义，不返回匿名盐，200 |
| PUT | `/surveys/:id` | 完整草稿定义及expectedRevision，200 |
| POST | `/surveys/:id/publish` | `{}`，发布非空且未截止的草稿，200 |
| POST | `/surveys/:id/close` | `{}`，关闭已发布问卷，200 |
| GET | `/public/surveys/:id` | 登录者读取可填写问卷，200 |
| POST | `/public/surveys/:id/responses` | 作答版本、答案与匿名标记，201 |
| GET | `/surveys/:id/stats` | 创建者查看问卷统计，200 |
| GET | `/surveys/:id/stats/:questionId` | 创建者查看单题统计，200 |

## 创建和保存例子

```json
{
  "title": "年龄与体验调查",
  "description": "一份演示问卷",
  "allowAnonymous": true,
  "allowMultiple": false,
  "deadline": null,
  "questions": [
    {
      "id": "age", "title": "你的年龄", "type": "number", "required": true,
      "options": [], "validation": { "min": 0, "max": 120, "integer": true },
      "rules": [{ "op": "lt", "value": 18, "target": "END" }]
    },
    {
      "id": "feedback", "title": "你的建议", "type": "text", "required": true,
      "options": [], "validation": { "minLength": 2, "maxLength": 200 }, "rules": []
    }
  ]
}
```

新建成功返回 `_id` 和 `revision:1`。PUT保存时使用相同结构，增加 `expectedRevision:1`；成功后revision变为2。调用方应使用服务器返回的新revision，旧revision保存返回409。已发布或关闭不能PUT修改。

选择题 `options` 至少两项，如 `[{"id":"a","label":"苹果"},{"id":"b","label":"香蕉"}]`。多选校验键为 `minChoices,maxChoices,exactChoices`，文本为 `minLength,maxLength`，数字为 `min,max,integer`；未设置的限制不生效。`required`和匿名、多次填写设置必须为布尔值。截止时间支持ISO8601字符串或null。问卷最多100题，发布前至少1题。

## 提交例子

上例中17岁会提前结束，不能附带feedback答案：

```json
{ "revision": 2, "anonymous": true, "answers": { "age": 17 } }
```

成年人按顺序回答：

```json
{ "revision": 2, "anonymous": false, "answers": { "age": 20, "feedback": "增加自习座位" } }
```

单选答案为选项ID字符串，多选为无重复的选项ID数组，文本为字符串，数字为JSON数值。空的可选题可省略或传null。成功返回 `{id,submittedAt}`。服务器重新计算作答路径，不信任前端发送的跳转结果。

## 统计响应

整卷统计包含 `surveyId,title,totalResponses,questions[]`；单题统计包含 `totalResponses,questionId,title,type,answeredCount,skippedCount`。选择题增加 `options:[{id,label,count}]`；填空题增加 `values`；数字题增加 `average`，没有有效数值时为null。`skippedCount`包括因跳转未访问与可选题留空。

## 错误约定

统一格式为 `{"error":"中文原因"}`。

| 状态 | 代表情况 |
| --- | --- |
| 400 | 参数、规则、答案校验失败；无效JSON；发布空问卷 |
| 401 | 未登录、会话过期或用户名密码错误 |
| 403 | 匹配不到当前站点的Origin写请求 |
| 404 | 接口或问卷不存在，或没有所有权 |
| 405 | 页面资源使用非GET方法 |
| 409 | 重复账号、重复填写、版本冲突、问卷状态不符 |
| 410 | 问卷已超过截止时间 |
| 413 | 请求体超过256KB |
| 415 | 写请求不是application/json |
| 500 | 未预期内部错误，响应不暴露堆栈 |

注册用户名为3至32个汉字、字母、数字或 `_.-`，忽略首尾空格和大小写；密码为8至128位。实际错误提示以服务器响应为准。登录会话有效期7天，注销立即删除当前会话。
