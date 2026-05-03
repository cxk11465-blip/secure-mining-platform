# 安全矿场资金平台

这是按安全优先思路重做的可运行原型，用来替代 MiniMax 生成项目里的高风险直连数据库方案。

## 已实现

- 用户注册、登录、退出
- 管理员后台
- PBKDF2 密码哈希，不存明文密码
- HttpOnly Cookie 会话
- CSRF Token 校验
- 用户和管理员角色隔离
- 充值申请和管理员审核
- 提现申请、余额冻结、审核通过/拒绝退回
- 资金流水
- 审计日志
- 安全响应头和 CSP
- 无外部依赖，直接用 Node.js 运行

## 启动

```bash
npm start
```

默认地址：

```text
http://localhost:3000
```

首次启动时，如果没有设置 `ADMIN_PASSWORD`，系统会自动生成管理员密码，并写入：

```text
data/bootstrap-admin.txt
```

管理员账号：

```text
admin
```

生产环境建议这样启动，避免生成临时密码文件：

```bash
ADMIN_PASSWORD='请换成强密码' npm start
```

## 数据文件

演示版使用本地 JSON 文件：

```text
data/db.json
```

这适合原型验证，不适合真实生产资金系统。生产版应替换为 Postgres/Supabase，并且所有写操作必须通过后端 API。

## 免费部署路线：Render + Supabase

这个项目已经支持免费测试部署：

- Render：运行 Node.js 前后端
- Supabase Postgres：保存用户、订单、矿工、流水、审计等状态
- Supabase Storage：保存充值截图、提现到账凭证

### 1. 创建 Supabase 项目

在 Supabase 新建项目后，准备两项：

- Project Settings -> Database -> Connection string，复制 **Transaction pooler** 的 Postgres `DATABASE_URL`（不要用 `db.<project>.supabase.co:5432` 直连地址）
- Project Settings -> API，复制 `Project URL` 和 `service_role` key

然后在 Storage 新建 bucket：

```text
receipts
```

为了让后台和用户能查看截图，测试阶段可以把 bucket 设为 public。正式环境建议改成私有 bucket，再用后端签名 URL。

### 2. 创建 Render Web Service

把项目推到 GitHub 后，在 Render 创建 Web Service：

```text
Build Command: npm install
Start Command: npm start
```

也可以直接使用仓库里的：

```text
render.yaml
```

### 3. Render 环境变量

至少配置这些：

```text
ADMIN_PASSWORD=你的强管理员密码
ADMIN_LOGIN_CODE=管理员登录二次验证码
DATABASE_URL=Supabase Postgres 连接字符串
USDT_COLD_WALLET_ADDRESS=你的TRC20冷钱包地址
SUPABASE_URL=https://你的项目.supabase.co
SUPABASE_SERVICE_ROLE_KEY=你的service_role key
SUPABASE_STORAGE_BUCKET=receipts
MIN_WITHDRAWAL_AMOUNT=10
DAILY_WITHDRAWAL_LIMIT=3
```

部署后访问 Render 提供的 HTTPS 地址，别人注册后，你的后台就能看到数据。

### 4. 本地和线上模式

没有 `DATABASE_URL` 时，系统使用本地：

```text
data/db.json
data/uploads
```

有 `DATABASE_URL` 时，系统自动使用 Supabase Postgres 的 `app_state` 表。

有 Supabase Storage 环境变量时，凭证截图会上传到 Supabase Storage；否则保存在本地 `data/uploads`。

## 安全策略

这个版本刻意避免了原项目里的几个高风险点：

- 不允许前端直接写数据库
- 不使用 `USING (true) WITH CHECK (true)` 这种公开 RLS 策略
- 不写死默认管理员密码
- 不保存明文密码
- 用户不能提现超过可用余额
- 提现申请会先冻结余额，拒绝后自动退回
- 管理员审核都会进入审计日志

## 后续上线前必须补充

- 换成 Postgres 数据库和事务
- 给管理员增加改密码和多因素验证
- 给充值和提现增加幂等键，防重复提交
- 接入真实支付/链上确认时，回调接口需要签名验签
- 增加限流、验证码、登录失败锁定
- 增加自动化测试和备份恢复策略
- 部署时启用 HTTPS 和 Secure Cookie
