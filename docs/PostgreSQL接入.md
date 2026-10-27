# PostgreSQL 测试环境接入

2026-10-27 核实：环境 ID 为 `everyday-rose-d0gihszbt1940f4d1`（没有 `trial.` 前缀），上海 PostgreSQL 免费体验版，有效期至 2027-04-27。身份认证页面已明确显示 FORM & FLOW、AppID `wx6d8fac347b122572`、微信云开发登录已启用；自定义登录也已启用。微信 CLI 环境列表仍为空，不能据此断言账号未关联。

## 当前登录实现

已完成独立 CloudBase SDK 调用链：`wx.login` 获取一次性 code → HTTPS `getLoginTicket` 云函数通过微信服务端校验 → 签发环境限定的自定义登录票据 → 小程序 SDK 登录后调用 `api`。后端每次从 CloudBase 可信运行上下文读取 uid/customUserId，拒绝匿名、缺失或错误来源身份；不相信客户端提供的 openid/角色。

微信身份按 AppID + OpenID 生成稳定的不透明标识，区别于历史微信入口的原始 OpenID 哈希；目前没有云端业务用户需要迁移。未来已有数据切换身份方案必须显式迁移，不能按手机号自动接管。

SDK 使用小程序专用入口和微信适配器，由构建脚本打包，无需手工执行开发者工具 npm 构建。并发页面共享一次登录；鉴权过期最多刷新一次。预约等修改在网络结果未知时保留原请求 ID，避免重复扣课。

客户端保持 demo 模式。`getLoginTicket` 和 `api` 已部署为 Node.js 20.19 普通云函数。当前免费共享实例没有 PostgreSQL 内外网直连地址；`api` 已改用云函数临时身份调用官方 `ExecutePGSql`，不需要保存数据库密码。登录函数还缺 AppSecret 和自定义登录签名凭据，所以尚未创建公网登录网关。

## 已改好的代码

- `server/entry.ts` 通过 CloudBase 服务端 SDK 读取可信自定义登录身份，再使用共享 PostgreSQL 适配器。前端角色参数不能决定服务端权限。
- `server/manager-postgres-store.ts` 用一条 SQL 读取包含版本号的一致快照；业务代码在内存草稿上执行，再由 `ez_apply_writes` 在数据库事务中锁定版本行并原子提交写集合。版本冲突最多尝试 12 次。
- `server/postgres-store.ts` 保留给本地集成测试或未来可直连实例，仍使用 SERIALIZABLE 事务、参数化 SQL 和有限重试。
- 每种业务记录独立一张 `public.ez_*` 表，用主键和 JSONB 保留既有业务结构，GIN 索引支持当前字段过滤；这不是 NoSQL 数据库，也没有改用缺少跨请求事务的 REST 写入。
- 此次没有把所有字段拆为关系型列或补齐外键，业务完整性仍由事务服务检查。未来报表/分页可以按需要增加类型化列与索引。

## 环境关联与账号

1. 使用控制台已核实的环境 ID `everyday-rose-d0gihszbt1940f4d1`；准确 AppID 登录关联和云函数临时身份的 PostgreSQL 调用均已验证。
2. 现有微信登录关联已核实，自定义登录已启用。还需下载当前环境的签名凭据并注入登录云函数。私钥不发送到聊天、不放进仓库。
3. 已通过云端 SQL 编辑器执行与 `database/postgres/001_schema.sql` 等效的建表脚本，并核验 11 张表、每表 2 个索引、RLS 开启且策略数为 0。随后执行 `003_manager_runtime.sql`，创建版本表及原子写入函数。未执行仅供可直连实例使用的 `002_runtime_permissions.sql`。
4. 当前体验版的数据库角色页面显示“新建角色”为禁用，配置页也没有内网或公网地址，因此不创建 `ez_api`。升级为可直连实例时再使用 `002_runtime_permissions.sql`，不要把匿名客户端角色设成管理员。
5. 表启用 RLS，没有匿名或普通已登录客户端策略。`ExecutePGSql` 属于服务端管理通道，细粒度鉴权必须在云函数中完成；不得把 SQL、管理 SDK 或云函数临时凭据暴露给客户端。

## 云函数配置

当前共享环境只需给业务函数配置环境 ID；云函数运行时自动获得短期身份，不创建长期 API Key。

| 参数 | 值来源 |
| --- | --- |
| `EZ_ENV_ID` | 已确认并绑定的小程序环境 ID |
| `EZ_APP_ID` | 登录函数使用 `wx6d8fac347b122572` |

不要把数据库 URL、密码、管理员 API Key 放到 `miniprogram/`。本项目未创建长期管理员 API Key。

`api` 仅配置环境 ID，通过已登录 SDK 调用，不开启匿名业务 HTTP 网关。

另部署 `cloudfunctions/getLoginTicket`，仅该函数配置 `EZ_ENV_ID`、`EZ_APP_ID`、`EZ_WX_APP_SECRET`、`EZ_TCB_LOGIN_CREDENTIALS`（完整签名凭据 JSON，env_id 必须匹配）。AppSecret 和私钥由所有者在控制台直接配置，不放入客户端。登录入口接收 HTTP POST JSON `{code}`，不接受客户端指定身份；在 HTTP 网关配置限流后才开放该登录入口。

确认身份认证、数据库连接、表权限及两个函数联调成功后，再填写客户端 HTTPS `loginUrl`、`envId`，将 `mode` 切为 `cloud`，配置实际登录入口及 SDK 请求域名的微信白名单并开启 `urlCheck`。运行 `npm run build:production` 后重新生成预览码。生产构建会拒绝 demo 模式、空环境、非 HTTPS 登录地址和关闭域名校验。仅修改配置不会创建云资源。

## 验证与限制

`npm run test:postgres` 自动启动隔离的临时 PostgreSQL 18.4，仅监听 `127.0.0.1`，使用随机密码、临时目录及独立测试数据库。测试结束后停止进程并清理目录。它不使用用户的云连接变量，也不会清空云端数据库。首次安装会下载 `embedded-postgres` 对应平台的测试二进制；不支持的平台需另行准备测试环境，不能跳过后宣称 PG 集成通过。

21 项业务用例在内存和真实本机 PostgreSQL 上各跑一遍；额外检查并发相同请求仅创建一笔课包、首次排班锁竞争、参数化过滤、RLS 默认拒绝、服务端最小权限和重复执行建表脚本。共享适配器另有写入、过滤和乐观冲突重试测试。

还需云端验证：自定义登录完整链路、真实业务写事务、并发冲突、冷启动、API 配额、备份恢复，以及手机预约→冻结→教练名单→取消释放。当前共享适配器每笔写事务读取业务表快照，只适合小规模试用；数据量增长前应改为按业务命令的数据库 RPC 或升级可直连实例。此前本地虚构演示数据不自动迁入云端。

官方依据：
- https://docs.cloudbase.net/database/postgresql/connecting-to-postgresql
- https://docs.cloudbase.net/quick-start/create-env
- https://docs.cloudbase.net/authentication-v2/auth/auth-pg

登录实现依据：
- https://docs.cloudbase.net/recipes/migrate-wxcloud-to-cloudbase
- https://docs.cloudbase.net/recipes/add-auth-wechat-miniprogram
