# 阶段二系统与数据库设计

## 原设计与新问题

阶段一使用Node.js、原生网页及MongoDB，users/sessions/surveys/responses四集合分别保存账号、会话、问卷快照与独立答卷。题目嵌入问卷，局部questionId稳定，跳转指向后续题ID。整卷读取和原子保存简单，但复制题目后无法追踪跨卷身份、共享、来源和版本；直接联动修改又会使旧问卷与回答失配。

阶段二保留四集合、原接口及填题规则，在外部增加独立题目管理层。auth.js、server.js、statistics.js和原43项测试保持；app.js接入新路由及来源检查，logic.js保留来源并生成可信回答元数据，database.js新增集合与索引。

## 七集合结构

| 集合 | 关键字段 | 组织原因 |
| --- | --- | --- |
| users | username、passwordHash、createdAt | 沿用独立账号与唯一用户名 |
| sessions | tokenHash、userId、expiresAt | 沿用会话摘要与TTL |
| surveys | ownerId、questions、revision、status | 沿用嵌入快照，题目追加sourceFamilyId/sourceVersionId |
| responses | surveyId、path、answers、dedupeKey | 沿用独立答卷，答案补充可信来源 |
| question_families | ownerId、sharedWith、nextVersionNo | 跨版本身份、授权与原子序号分配 |
| question_versions | familyId、versionNo、parentVersionId、restoredFromVersionId、question | 独立不可变内容、分支及恢复来源 |
| banks | ownerId、title、questionFamilyIds、revision | 私有题库目录，成员按族引用 |

集合主键及跨集合关系采用ObjectId；嵌入问卷/回答的来源使用24位hex字符串，兼容现有浏览器与JSON接口，由后端转换并校验归属。版本内容包含title/type/required/options/validation，模板id规范化为template，rules为空。跳转依赖问卷上下文，导入后再配置，不携带不存在的旧目标。

## 快照、历史与并发

问卷questions既保存实际内容，又指向固定版本。库中改版不联动旧卷；服务端检查来源版本、族归属、权限和内容一致性，不能修改题目内容却保留旧版本标记。引用题的内容在页面锁定，问卷自身的跳转仍可配置。发布后继续拒绝修改。

每次修改追加不可变版本，parentVersionId可指向本族任意旧版，实现分支。恢复也追加版本，parent记录恢复操作基于的最新版本，restoredFrom记录恢复内容来源。另存独立题生成新族，不混入原统计。

先对族文档原子$inc分配versionNo，再插入版本；(familyId,versionNo)唯一索引防重，六路同父并发都保留。默认standalone不依赖多文档事务。分配后插入前若进程失败可留下序号间隙，但不覆盖旧版本。问卷、题库和导入继续以revision条件防多窗口覆盖。

## 权限与共享撤销

创建者可追加版本、恢复和授权；接收者可阅读、引用或另存独立题，不能改共享历史或转授。共享用户名须已注册。所有接口在后端检查，不依赖按钮隐藏。

撤销共享后阻止新引用和库内访问，既有发布快照继续填写。原草稿可保留原局部题ID下完全未变的引用，换ID复制或更换版本须重新授权。在途操作可能在撤销前已通过权限检查，不保证撤销能取消这类请求。

使用反查仅列出本人可管理问卷；他人只返回引用数量，不泄露问卷ID、标题、答案或身份。题库为个人目录，移除成员或删除目录不级联删除题目、问卷和回答。

## 跨问卷统计

先按ownerId限定可管理问卷，再按族和不可变版本汇总。每卷同一版本最多一次，不按标题、局部ID或选项文字猜测合并。同版本跨卷合并、不同版本分组，是用户本次评审确认的规则。

单选/多选计选项频次，文本保留原值，数字用MongoDB聚合求平均并形成升序频数分布。空值、跳过不作0，返回totalResponses/answeredCount/skippedCount及参与卷数。共享不扩大答卷统计权限。

## 新增索引

| 集合 | 索引 | 用途 |
| --- | --- | --- |
| question_families | ownerId+createdAt；sharedWith | 自建与共享题列表 |
| question_versions | familyId+versionNo唯一；parentVersionId | 历史、最新版本、分支 |
| surveys | questions.sourceFamilyId；questions.sourceVersionId | 多键反查与定位 |
| responses | surveyId+answers.sourceVersionId | 授权卷范围内筛选版本 |
| banks | ownerId+createdAt | 私有目录 |

原唯一用户名、会话摘要/TTL、ownerId和回答去重索引保留。新集合JSON Schema检查BSON类型、必需字段与模板结构，应用检查业务内容及引用权限。

## 程序调整与限制

新增src/library.js与migration.js及迁移CLI；前端新增public/library.js，在原app.js导航、路由、编辑器中接入，CSS扩展手机布局。迁移详见[MIGRATION.md](MIGRATION.md)，接口见[API.md](API.md)，实测见[TESTS.md](TESTS.md)。统计原值尚未分页，未验证大规模压力、崩溃恢复或公网部署；迁移须停止写入。

MongoDB设计依据：[单文档原子性与并发更新](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/)、[事务部署条件](https://www.mongodb.com/docs/manual/data-modeling/enforce-consistency/transactions/)。实现适配现有standalone环境，以不可变记录、原子计数、唯一索引和可续跑迁移组织一致性。
