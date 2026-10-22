# 系统与数据库设计

## 系统目标与结构

系统实现阶段一要求的注册登录、问卷管理、单选题、多选题、文字与数字填空、数据驱动的跳转、提交保存和问卷内统计。采用 Node.js 22、Node HTTP模块、MongoDB官方驱动6.21系列和原生HTML/CSS/JavaScript。没有使用关系数据库或现成问卷框架。

浏览器通过同源JSON API访问后端；HTTP处理器负责鉴权、参数检查和业务状态判断；`logic.js`负责题目定义验证、单题校验和路径重算；`statistics.js`负责MongoDB聚合和结果整理；`database.js`负责连接池、集合验证器和索引。前后端复用同一套纯逻辑函数，但安全性以服务端执行结果为准。

运行链路：浏览器 → HTTP API → 权限与规则引擎 → MongoDB。创建者和填写者均为注册用户，系统不设特殊管理员角色。界面只展示当前创建者的问卷，后端查询同时限定 `ownerId`，防止仅靠隐藏按钮造成越权。

## 集合划分与字段

四个集合分别管理不同增长速度和访问方式的数据。ObjectId用于跨集合引用，Date均为BSON日期。应用启动时自动创建或更新集合验证器；完整可执行schema在 `src/database.js` 的 `schemas` 中。

| 集合 | 主要字段 | 设计理由 |
| --- | --- | --- |
| users | `_id, username, passwordHash, createdAt` | 账号独立管理；用户名规范化为小写并设唯一索引；密码使用随机盐scrypt哈希 |
| sessions | `_id, tokenHash, userId, expiresAt` | 会话可单独失效；只保存随机令牌的SHA256摘要；TTL索引清理过期会话 |
| surveys | `_id, ownerId, title, description, status, allowAnonymous, allowMultiple, deadline, questions[], revision, anonymousSalt, createdAt, updatedAt` | 一次读取即获得问卷定义；题目、选项、校验和跳转嵌入同一文档 |
| responses | `_id, surveyId, respondentId, anonymous, revision, path[], answers[], dedupeKey, submittedAt` | 每次完成提交独立保存，避免回答数量增长不断扩大问卷文档 |

`surveys.questions[]` 的结构如下，`validation`随题型变化：

```json
{
  "id": "age", "title": "你的年龄", "type": "number", "required": true,
  "options": [],
  "validation": { "min": 0, "max": 120, "integer": true },
  "rules": [{ "op": "gte", "value": 18, "target": "adult" }]
}
```

题型取值为 `single / multiple / text / number`。选择题选项为 `{id,label}`；题目ID在当前问卷内稳定且唯一，不用数组位置作为答案引用。特殊ID `END` 表示结束，保留的JavaScript对象键也不能作为题目ID。

回答保存为 `{questionId,type,value}` 数组，另存实际访问的 `path`。空的可选题保存 `null`，被跳过的题不产生答案记录。实名填写保存用户ObjectId；匿名填写的 `respondentId` 为 `null`。统计API不输出用户身份或去重凭证。

## MongoDB适配与取舍

不同题型拥有不同校验字段，使用嵌套文档可以贴近问卷结构。题目、选项、规则通常一起读取和保存，所以嵌入问卷文档，单文档修改具备原子性。回答则持续增长，单独集合避免把所有答案堆进问卷，减少文档膨胀和同一文档的并发写争用。账号与会话单独分离，便于唯一性和过期管理。

关系数据库也能实现该系统，但需要额外组织问卷、题目、选项、校验等多组关联结构。本项目按课程要求采用MongoDB，利用文档结构和聚合能力；这不意味着MongoDB对所有应用都更合适。冗余仅保留回答中的题型和问卷revision，便于聚合与审计；不在回答中复制标题和整份问卷。

单份问卷最多100题，每题最多50个选项和30条规则，请求体最多256KB。应用层对完整嵌套业务约束执行验证，数据库JSON Schema提供集合顶层字段和类型保护。二者职责不同，数据库验证器不单独替代规则校验。

## 索引与一致性

| 集合 | 索引 | 用途 |
| --- | --- | --- |
| users | `username:1` 唯一 | 防止并发重复注册 |
| sessions | `tokenHash:1` 唯一 | 会话查询 |
| sessions | `expiresAt:1` TTL 0秒 | 自动回收；鉴权仍主动比较expiresAt，不能依赖TTL立即删除 |
| surveys | `ownerId:1,createdAt:-1` | 当前用户列表和创建时间排序 |
| responses | `surveyId:1,submittedAt:-1` | 问卷答案范围查询与时间排序 |
| responses | `dedupeKey:1` 唯一 | 并发限制同一用户一次提交 |

不允许重复填写时，去重键为 HMAC-SHA256(问卷随机盐,用户ID)。盐只在服务端使用且不通过问卷接口返回，匿名与实名提交使用相同去重语义，不能通过切换匿名绕过限制。允许重复时每次生成UUID。匿名是对问卷创建者隐藏身份，数据库管理员掌握用户库和盐后仍可能关联身份，不承诺密码学不可追踪。

草稿使用 `expectedRevision` 乐观锁，保存条件包括 `_id,status,revision`，成功后revision加1。发布也使用同样条件，避免编辑与发布并发时发出旧定义。问卷状态为 `draft → published → closed`；发布后的题目和配置不可修改，旧答案始终按原定义解释。截止时间不必额外改状态，每次读填与提交实时比较。

响应单文档写入原子完成，不依赖副本集事务。关闭状态与答案插入位于不同集合，当前实现以提交请求读取问卷时的状态为准，关闭前已通过检查的在途请求仍可能完成；没有实现跨集合强隔离。课程规模统计可完整显示文本答案，未实现大数据量分页和缓存。

## 跳转与校验

规则保存在题目文档中，不把某份问卷的业务条件写死在代码。单选支持 `eq`；多选支持 `includes / includesAny / includesAll`；数字支持 `eq / gt / gte / lt / lte`。同题多个规则按配置顺序匹配第一条；未命中则进入下一题。目标只能为后续题目或END，保存时拒绝后向跳转、自跳和无效目标，因此无需运行时处理循环。

填写页逐题执行校验再决定下一题。提交时服务端从首题重新执行相同规则，只校验真实到达的题；被跳过的必答题不要求作答，伪造的隐藏题答案被拒绝。返回上一题时暂存当前输入；改选后只清理已确定不可达的答案，保留共同后续题答案。尚未回答或暂不合法的后续题保留可能分支，等答案确定后再清理，最终只提交实际路径中的答案。

必答题不能空；多选检查选项有效、无重复、最少、最多和固定数量；文本按Unicode码点计算长度，必答拒绝全空格；数字必须为有限的JSON number，按需检查上下限和安全整数。边界值采用包含式最小和最大值。填写版本必须等于发布问卷revision。

## 统计与权限

MongoDB聚合先按surveyId筛选，再展开answers，忽略null，按questionId汇总回答数、原值和数值平均值。选项计数在聚合结果上整理，未被选择的选项显示0。多选每个有效选项在一份回答中计1次；总回答人数与选项次数分别展示，不混用。数字平均值只对该题的有效数值回答求平均；零回答时返回null。

创建者可查看整份问卷与单题统计。所有列表、编辑、发布、关闭和统计操作在服务器验证所有权。密码使用scrypt，Cookie为HttpOnly和SameSite=Lax，服务端只存会话令牌摘要。写接口要求JSON并检查存在的Origin，网页使用同源脚本和输出转义。默认仅绑定127.0.0.1；实际公网部署还需HTTPS、限流和运维配置。
