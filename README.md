# 新老接口字段对比工具

后端重构号称"只是大驼峰变小驼峰"。这个工具**真实请求新接口**，把返回的字段结构+类型和你保存的老接口逐一对比，差异生成 MD 表格报告。纯 Node 18+，零依赖（不用 npm install）。

## 命令速查

**统一用 `node index.js` 启动**。npm 命令只是等价别名（见文末「npm 等价命令」），平时可以当它不存在。

| 输入 | 做什么 | 什么时候用 |
|---|---|---|
| `node index.js` | 跑 fixtures/ 里**全部**接口：并发真实请求新接口 → 与保存的老响应对比 → MD 报告写入 reports/ | 日常全量回归 |
| `node index.js bid.list` | 只跑 bid.json 里 name 为 `list` 的那一个接口 | 复验、调试单个接口 |
| `node index.js bid` | 跑 bid.json **整个文件**（模块 = 文件名） | 按模块回归 |
| `node index.js list` | 只写接口名：全库唯一时自动定位；重名会报错提示你写全 `bid.list`；若恰好也是模块名（存在同名 .json）则优先按模块处理 | 偷懒写法 |
| `node index.js --detail` | 报告带**完整字段对照表**（默认只列不一致和多出来的字段） | 留档、给旁人看全量字段 |
| `node index.js --help` | 打印用法速览 | 忘了参数时 |
| `node index.js --mock` | 起本地假服务器**自测脚本自身**（13 个预埋用例：缺字段/多字段/类型变化/HTTP 500/业务失败/请求转换……断言脚本判定与预期完全一致） | 只有改了脚本代码才跑 |
| `npm test` | 单元测试（转换/对比纯函数） | 只有改了脚本代码才跑 |

参数可叠加，例如：`node index.js bid --env dev --concurrency 1 --verbose --detail`

## 三步上手

### 1. 配 .env（只配一次，token 过期了才换）

在项目根目录新建 `.env` 文件（注意：注释要单独一行）：

```
# 两个环境的接口地址
NEW_API_BASE_URL_DEV=https://dev线上环境的接口域名
NEW_API_BASE_URL_TEST=https://test测试环境的接口域名
# 浏览器抓包请求头 authtoken 的值
NEW_API_TOKEN=你的token
```

默认环境是 `test`，用 `--env dev` 切换。配了 token 会放进 `authtoken` 请求头发送（不加 Bearer 前缀）；没配只告警不中断，需要登录态的接口会 401——首个 401/403 会自动中止运行（见「看结果」）。

### 2. 录 fixture（抓包原样粘贴）

在 `fixtures/` 建 `<模块>.json`（**模块名就是文件名**，如 `bid.json` 里的接口用 `bid.list` 指代）：

```json
{
  "apis": [
    {
      "name": "list",
      "oldApi": { "method": "POST", "path": "/v1/bid/list" },
      "newApi": { "method": "POST", "path": "/v1/bid/list" },
      "request": { "body": { "老接口入参原样粘贴": "大驼峰不用管" } },
      "response": { "老接口响应原样粘贴": "大驼峰不用管" }
    }
  ]
}
```

**`oldApi` / `newApi` 两个对象都要写全**（method + path）——`oldApi` 是老接口标识，仅存档不发请求；`newApi` 是新接口，实际请求用。脚本强制校验，少写会报错。入参出参直接复制浏览器里的，脚本自动转小驼峰后发请求、做对比。

按需补充（用到才写）：

| 加这个字段 | 什么时候 |
|---|---|
| `"request": { "query": {...} }` | 参数在 URL 上时（GET 常用；POST 也能 query+body 混用） |
| `"request": { "headers": {...} }` | 该接口要额外带请求头时（覆盖公共 header） |
| `"keyOverrides": { "OrderID": "orderId" }` | 报告里 `xxxID` 缺失 + `xxxId` 多给成对出现时（缩写词要人工指路一次） |
| `"ignorePaths": ["data.traceId"]` | 某字段每次都变、不想看时 |
| `"queryArrayFormat": "comma"` | 该接口数组参数要 `cats=4,41` 形式时（默认 `repeat` 即 `cats=4&cats=41`，还有 `brackets`） |

注意：抓包时**列表至少留 1 条数据**（空列表没法比字段）；长 ID 用字符串形式粘贴。**接口标识 = 文件名 + 接口名**（同一文件内 name 别重复；复制文件改文件名即是新模块。报告里每条结果的标识是 `文件名 › 接口名`，一眼看出自哪个 json）。

### 3. 跑

```bash
node index.js            # 全部接口（自动全并发）
node index.js bid.list   # 单个接口（模块.接口名）
node index.js bid        # 整个模块
node index.js --detail   # 报告带完整字段对照表
```

## 看结果

控制台逐接口打印状态标签（`[PASS]`/`[FAIL]`/`[BIZFAIL]`/`[ERROR]`），MD 报告里对应四种图标：

| 状态 | 含义 | 怎么办 |
|---|---|---|
| ✅ PASS | 字段结构+类型全部一致 | 不用管 |
| ❌ FAIL | 有字段缺失或类型变化 | 看报告；**先拉报告底部折叠块**看新接口实际返回——errMsg 是"未登录/签名失效"就换 token，那不是真改了字段 |
| 🟡 BIZFAIL | HTTP 通了但业务报错（如 `success:false`），**不参与字段对比**（拿空 data 对比会误报一片缺失） | 先解决业务报错再看字段 |
| 🟥 ERROR | 请求本身失败：HTTP 非 2xx / 响应不是 JSON / 超时 / 网络不通 / 地址配置非法 | 按打印的错误类型排查 |

- 报告：`reports/` 目录下 `report-<时间戳>-<文件名>.md`，**一个 fixture 文件一份报告**，最新的按文件名排序排最后。默认只列异常字段，加 `--detail` 出全量对照表
- 首个 401/403 会**自动中止**本次运行（避免 token 过期时满屏误报），换 token 重跑即可

退出码：`0` 全过；`1` 有字段差异、请求失败或业务失败（BIZFAIL）；`2` fixture/参数/配置写错或脚本自身故障（fixture 有错时优先退出 2）。

## 参数全表

| 参数 | 作用 |
|---|---|
| 位置参数 `bid.list` / `bid` / `list` | 按 模块.接口 / 模块 / 接口名 过滤（只支持一个） |
| `--module bid` / `--api list` | 同上，可重复传多个 |
| `--env dev` | 切环境（默认 `test`；可选值是 config.js 里 envs 的 key） |
| `--detail` | 报告带完整字段对照表 |
| `--concurrency 8` | 限制并发数（默认不限=全部同时发；`1` = 串行调试） |
| `--verbose` | 控制台显示提示级信息（多给字段、null 跳过等） |
| `--report-dir ./out` | 改报告输出目录（默认 reports/） |
| `--mock` | 自测模式（见文末） |
| `--help` / `-h` | 用法速览 |

## 默认对比规则（什么算差异）

- 老响应里有的字段，新接口没有 → ❌ 差异（missing；例外：老数组里只有部分行出现的可选字段，缺失降级为提示）
- 字段类型变了（含"以前有值、现在恒 null"）→ ❌ 差异（type-mismatch）
- 新接口**多给**的字段 → 只存档不算差异（`--verbose` 可见；config.js 里 `addedIsFail: true` 恢复严格模式）
- 老数据为 null、空数组 → 跳过记提示（没法推断类型）
- 只比**结构+类型**，不比具体值（每次请求值本来就不同）
- key 转换：大驼峰只转首字母（`OrderNo`→`orderNo`），缩写词不猜（`OrderID` 默认变 `orderID`，认不出就用 `keyOverrides` 人工指路）

## npm 等价命令

不习惯记 node 命令的话，package.json 里配了四个等价命令，**效果完全一样**：

| npm 写法 | 等价于 |
|---|---|
| `npm start` | `node index.js` |
| `npm run detail` | `node index.js --detail` |
| `npm run mock` | `node index.js --mock` |
| `npm test` | `node --test`（单元测试） |

注意 npm 传参要带 `--` 分隔：`npm start -- bid.list`；直接写 `npm start --detail` 会被 npm 自己吞掉。

## 给维护脚本的人（或接手的 AI）

`lib/mockServer.js` 和 `test/` 是**改脚本代码时的自检工具，日常使用永远不用碰**：

- 改动任何代码后必须跑 `node index.js --mock` + `npm test`，两个全绿才算改完
- `--mock`：本地假服务器内置 13 个自测用例（缺字段/多字段/类型变化/HTTP 500/业务失败/请求大小写与 query 序列化……部分用例预期 PASS 以验证不误报），断言脚本判定与预期**完全一致**——端到端验证全链路
- `npm test`：转换/对比纯函数的单元测试
- 意义：对比工具本身不可信，报告就没有意义。平时录 fixture、跑对比、看报告用不到它们
