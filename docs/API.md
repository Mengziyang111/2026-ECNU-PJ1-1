# 阶段二 API 说明

根地址/api，JSON请求与响应，同源HttpOnly会话Cookie。除health、注册、登录外须登录。写请求使用application/json，请求体上限256KB；ObjectId序列化为字符串。

## 原有接口继续支持

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | /auth/register、/auth/login、/auth/logout | 账号会话 |
| GET | /me、/health | 当前账号、数据库健康 |
| GET / POST | /surveys | 本人列表、创建草稿 |
| GET / PUT | /surveys/:id | 本人读取/保存；PUT带expectedRevision |
| POST | /surveys/:id/publish、/surveys/:id/close | 发布与关闭 |
| GET | /public/surveys/:id | 登录后读取允许填写的快照 |
| POST | /public/surveys/:id/responses | 独立重新校验路径、保存答卷 |
| GET | /surveys/:id/stats[/questionId] | 本人整卷及单题统计 |

问卷仍使用title/description/allowAnonymous/allowMultiple/deadline/questions。来源题同时带sourceFamilyId/sourceVersionId，后端验证版本、权限与内容；无来源旧题兼容原结构。提交请求仍为{revision,answers,anonymous}，来源由服务端快照生成，不能由填写者伪造。

## 题目与版本

| 方法 | 路径 | 输入与返回 |
| --- | --- | --- |
| GET | /library/questions | 可访问题族列表，含isOwner/versionCount/latestVersion |
| POST | /library/questions | {question}；201 {family,version} |
| GET | /library/questions/:id | {family,versions}，历史升序 |
| POST | /library/questions/:id/versions | {parentVersionId,question}；201 新版本 |
| POST | /library/questions/:id/restore | {versionId}；201 恢复生成的新版本 |
| PUT | /library/questions/:id/sharing | {usernames:[]}，完整替换授权 |
| GET | /library/questions/:id/usage | {surveys,hiddenUsageCount} |
| GET | /library/questions/:id/stats[?versionId=...] | 本人问卷按版本汇总或指定版本 |

POST独立数字题示例：

```json
{"question":{"title":"你的年龄","type":"number","required":true,"options":[],"validation":{"min":0,"max":120,"integer":true}}}
```

版本含_id/familyId/versionNo/parentVersionId/restoredFromVersionId/question/createdAt。首版parent为null，恢复含restoredFrom。模板id为template、rules=[]。没有覆盖或删除历史版本的接口。新增本族版本、恢复、授权仅创建者可用；接收者可引用或另存新族。共享空数组撤销，未知用户400。

## 题库与选题

| 方法 | 路径 | 输入与返回 |
| --- | --- | --- |
| GET | /library/banks | 本人题库数组 |
| POST | /library/banks | {title,description?}；201 空目录revision=1 |
| PUT | /library/banks/:id | {title,description,questionFamilyIds,expectedRevision} |
| DELETE | /library/banks/:id | JSON {}；只删除目录 |
| POST | /surveys/:id/questions/from-library | {versionId,expectedRevision,questionId?}；201 更新后的整份问卷 |

题库最多500个不重复可访问题族。导入仅适用于本人草稿，默认产生唯一局部题ID与空规则，revision加1；同卷同版最多一次。编辑器先保存未保存修改，再进入选题。发布/关闭状态或revision过期返回409。

## 统计示例

```json
{
  "familyId":"题族ID","scope":"owned-surveys",
  "versions":[{
    "versionId":"版本ID","versionNo":1,"title":"年龄","type":"number",
    "surveyCount":2,"totalResponses":3,"answeredCount":3,"skippedCount":0,
    "values":[18,18,24],"average":20,
    "distribution":[{"value":18,"count":2},{"value":24,"count":1}]
  }]
}
```

这是结构示例。单选/多选返回options及count，文本返回values，数字额外返回average及distribution；无有效数字时average=null。不同版本各自独立，不同类型也不混算。使用反查每项有surveyId/title/status/versionId/versionNo/questionId，他人仅计hiddenUsageCount。

## 错误

400格式/内容/来源非法；401未登录；403跨域写入；404不存在或无权访问；409状态/revision/重复冲突；410截止；413过大；415非JSON。响应为{"error":"中文原因"}，内部错误不向客户端暴露堆栈。具体实测输入和结果见[TESTS.md](TESTS.md)。
