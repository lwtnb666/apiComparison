'use strict';

const path = require('node:path');
const { loadDotEnv } = require('./lib/dotenv');

// 启动时先从项目根目录 .env 读 token 等敏感配置（shell 里已设置的环境变量优先，不被覆盖）
loadDotEnv(path.join(__dirname, '.env'));

/**
 * 全局配置。
 *
 * 【安全约定】token 等敏感信息一律走环境变量，本文件（以及 fixtures/）永不出现真实 token。
 */
module.exports = {
  // 环境 → 新接口 baseURL 映射（地址放 .env，这里只写环境变量名；envVar 用于没配时的报错提示）
  envs: {
    dev: { baseURL: process.env.NEW_API_BASE_URL_DEV, envVar: 'NEW_API_BASE_URL_DEV' },
    test: { baseURL: process.env.NEW_API_BASE_URL_TEST, envVar: 'NEW_API_BASE_URL_TEST' },
  },
  defaultEnv: 'test',

  timeoutMs: 10000, // 单接口超时

  concurrency: Infinity, // 并发请求数上限：默认不限=全部接口同时发（fetch 连接池对单域名自带连接数上限，传输层会自然排队）；接口特别多怕压服务器时才需要改小或用 --concurrency N，1 = 串行调试

  // token 环境变量【名】（这里只写变量名！真实 token 放 .env 文件或 shell 环境变量，永不写进本文件）
  // 注意：此前有人把 token 值本身贴到了这里——那个 token 已泄露，请作废重签
  tokenEnvVar: 'NEW_API_TOKEN',

  // query 数组参数的序列化方式：repeat（默认，cats=4&cats=41）| comma（cats=4,41）| brackets（cats[]=4）
  // 接口级可在 fixture 里加 queryArrayFormat 覆盖；null 和空数组默认不发出
  queryArrayFormat: 'repeat',

  // 首个 401/403 立即中止本次运行，避免满屏误报
  failFastOnAuthError: true,

  // 启动时组装公共 header；缺 token 告警但不致命（部分接口可能免登）
  buildHeaders() {
    const token = process.env[this.tokenEnvVar];
    if (!token) {
      console.warn(`[warn] 未读到 ${this.tokenEnvVar}（可在 .env 文件或 shell 环境变量里设置），需要登录态的接口会 401`);
    }
    return {
      'Content-Type': 'application/json',
      // 登录态放在 authtoken 请求头（原始 token 值，不加 Bearer 前缀）；
      // 若抓包里字段名不是 authtoken（比如 auth-token），只改下面这处的名字即可
      ...(token ? { authtoken: token } : {}),
    };
  },

  // 全局 key 例外映射（老原始 key → 新实际 key，任意嵌套层级生效）
  // 接口级 keyOverrides 优先级更高。例：'OrderID': 'orderId'
  globalKeyOverrides: {},

  // 业务成功判定：HTTP 200 不代表业务成功（比如 {"success":false,"code":401,"data":{}}）。
  // 判定失败时接口标记 BIZFAIL、控制台显示 errMsg、跳过字段对比（拿空 data 对比会误报一堆字段缺失）。
  // field 支持点路径（如 'data.success'）；响应里没有该字段时不做判定、照常对比。设为 null 整体关闭。
  // 按你们接口的包裹结构选择：success:true 或 code:200 都行（code 方式：field 'code', value 200）
  bizSuccess: { field: 'success', value: true, errField: 'errMsg' },

  // 对比策略（含义见 lib/compare.js 注释）
  compare: {
    nullPolicy: 'asymmetric', // asymmetric | lax | strict
    strictNumber: false,      // true 时 int/float 细分（只产 hint，不算差异）
    emptyArrayIsDiff: false,  // true 时新侧空数组算差异
    addedIsFail: false,       // 包含式对比：新接口多给字段只记 info（控制台不显示，--verbose 可见）；老字段缺失/类型变了仍 fail。true 恢复严格模式
  },
};
