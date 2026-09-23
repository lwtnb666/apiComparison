# 新老接口字段对比工具

后端重构号称"只是大驼峰变小驼峰"。这个工具**真实请求新接口**，把返回的字段结构+类型和你保存的老接口逐一对比，差异生成 MD 表格报告。纯 Node 18+，零依赖。

## 三步上手

### 1. 配 .env（只配一次，token 过期了才换）

在项目根目录新建 `.env` 文件（注意：注释要单独一行）：

```
# 两个环境的接口地址
NEW_API_BASE_URL_DEV=https://dev环境的接口域名
NEW_API_BASE_URL_TEST=https://test环境的接口域名
# 浏览器抓包请求头 authtoken 的值
NEW_API_TOKEN=你的token
```

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
| `"keyOverrides": { "OrderID": "orderId" }` | 报告里 `xxxID` 缺失 + `xxxId` 多给成对出现时（缩写词要人工指路一次） |
| `"ignorePaths": ["data.traceId"]` | 某字段每次都变、不想看时 |

注意：抓包时**列表至少留 1 条数据**（空列表没法比字段）；长 ID 用字符串形式粘贴。**接口标识 = 文件名 + 接口 name**（同一文件内 name 别重复；复制文件改文件名即是新模块。报告里每条结果的标识是 `文件名 › 接口名`，一眼看出自哪个 json）。

### 3. 跑

```bash
node index.js            # 全部接口（自动全并发）
node index.js bid.list   # 单个接口（模块.接口名）
node index.js bid        # 整个模块
node index.js --detail   # 报告带完整字段对照表（默认只列不一致和多出来的字段）
```

习惯用 npm 的话：`npm start` = 全部接口；`npm run detail` = 带完整对照表。注意 npm 传参要带 `--` 分隔（如 `npm start -- bid.list`），直接写 `npm start --detail` 会被 npm 自己吞掉。

## 看结果

- 控制台：✅ 过 / ❌ 有差异 / 🟡 业务报错（HTTP 通了但接口报错，先解决报错再看字段）
- 报告：`reports/` 目录下最新的 `.md` 文件。**默认只列不一致和多出来的字段**（接口再多报告也短）；要完整对照表就跑时加 `--detail`
- **接口 FAIL 先拉报告底部折叠块**看新接口实际返回——如果 errMsg 是"未登录 / 签名失效"，换 token 或重新抓包，那不是真改了字段

## 其他

```bash
node index.js --help     # 用法速览
```

| 参数 | 作用（一般用不到） |
|---|---|
| `--module bid` / `--api list` | 按模块/接口过滤（可重复传；等价于位置参数 `bid.list`） |
| `--env test` | 切换环境（可选值在 config.js 的 envs） |
| `--concurrency 8` | 限制并发数（默认不限=全部同时发；`1` = 串行调试） |
| `--verbose` | 控制台显示提示级信息（null 跳过、多给字段等） |
| `--report-dir ./out` | 改报告输出目录（默认 reports/） |

退出码：`0` 全过；`1` 有差异或请求失败；`2` fixture/参数写错了。

## 给维护脚本的人（或接手的 AI）

`lib/mockServer.js` 和 `test/` 是**改脚本代码时的自检工具，日常使用永远不用碰**：

- 改动任何代码后必须跑 `node index.js --mock` + `npm test`，两个全绿才算改完
- `--mock`：本地假服务器预埋 13 种已知差异（缺字段/多字段/类型变化/500/业务失败……），断言脚本发现的差异**恰好等于**预埋的——端到端验证全链路
- `npm test`：转换/对比纯函数的单元测试
- 意义：对比工具本身不可信，报告就没有意义。平时录 fixture、跑对比、看报告用不到它们
