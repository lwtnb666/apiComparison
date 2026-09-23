'use strict';

/**
 * 新老接口出入参差异对比 —— CLI 入口（只做编排，纯逻辑在 lib/ 下）。
 *
 * 用法见 README.md 或 `node index.js --help`。
 * 退出码：0 全部 PASS；1 存在 FAIL/ERROR（接口有差异或请求失败）；2 自身故障（fixture/config/参数错误）。
 */

const path = require('node:path');
const { parseArgs } = require('node:util');
const config = require('./config');
const { loadFixtures } = require('./lib/loader');
const { toCamelKeys } = require('./lib/caseConvert');
const { compareResponses } = require('./lib/compare');
const { callApi } = require('./lib/http');
const report = require('./lib/report');

const USAGE = `
新老接口出入参差异对比（字段结构 + 类型）

用法:
  node index.js              跑全部接口，报告写入 reports/
  node index.js bid.list     只跑单个接口（文件名.接口名；接口名全库唯一时可只写接口名）
  node index.js --detail     报告带完整字段对照表（默认只列不一致和多出来的字段）

其他参数（一般用不到，详见 README.md）:
  --module / --api  按模块/接口过滤    --env  切环境（默认 ${config.defaultEnv}）
  --concurrency  限并发    --verbose  提示级信息    --report-dir  改报告目录    --mock  自测

鉴权: token 放 .env 文件的 ${config.tokenEnvVar}（浏览器抓包请求头 authtoken 的值）
`.trim();

function exit2(message) {
  if (message) console.error(`[配置错误] ${message}`);
  console.error(USAGE);
  process.exit(2);
}

/**
 * 退出前留一小段宽限再 process.exit。
 * Windows 上若退出瞬间有 socket 恰在 closing（keep-alive 连接被对端关闭后），
 * libuv 会打 Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) 并 abort（退出码被污染成 127），
 * 150ms 足够任何 closing 中的 socket 走完；active 状态的 socket 不受影响，直接退。
 */
async function settleAndExit(code) {
  await new Promise((r) => setTimeout(r, 150));
  process.exit(code);
}

/** 按点路径取值（'a.b.c'），取不到返回 undefined */
function getByPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj);
}

/** 跑单个接口：转换入参 → 请求新接口 → 对比响应 */
async function runOne(api, ctx) {
  const overrides = { ...config.globalKeyOverrides, ...(api.keyOverrides || {}) };
  const q = toCamelKeys((api.request && api.request.query) || {}, overrides);
  const hasBody = api.request && Object.hasOwn(api.request, 'body');
  const b = hasBody ? toCamelKeys(api.request.body, overrides) : { value: undefined, warnings: [] };
  const warnings = [...q.warnings, ...b.warnings];

  const resp = await callApi(api, { query: q.value, body: b.value }, ctx);
  if (!resp.ok) {
    return {
      module: api.module, name: api.name, file: api.file, method: api.method, path: api.path, oldApi: api.oldApi || null,
      status: 'ERROR', error: resp.error, httpStatus: resp.status, message: resp.message,
      bodySnippet: resp.bodySnippet
        || (resp.json != null ? JSON.stringify(resp.json).slice(0, 500) : undefined),
      durationMs: resp.durationMs, diffs: [], infos: [], warnings,
    };
  }

  // 业务成功判定：HTTP 200 但 success:false 时 data 常为空对象，直接对比会误报字段缺失
  const biz = ctx.bizSuccess !== undefined ? ctx.bizSuccess : config.bizSuccess;
  if (biz && biz.field) {
    const actual = getByPath(resp.json, biz.field);
    if (actual !== undefined && actual !== biz.value) {
      return {
        module: api.module, name: api.name, file: api.file, method: api.method, path: api.path, oldApi: api.oldApi || null,
        status: 'BIZFAIL', httpStatus: resp.status,
        bizField: `${biz.field}=${JSON.stringify(actual)}`,
        bizErrMsg: biz.errField ? getByPath(resp.json, biz.errField) : undefined,
        durationMs: resp.durationMs, diffs: [], infos: [], warnings,
        newResponseSnippet: JSON.stringify(resp.json).slice(0, 2000),
      };
    }
  }

  const { diffs, infos, fields } = compareResponses(api.response, resp.json, {
    ...(ctx.compare || config.compare), // mock 模式钉死策略，与用户 config 解耦
    overrides,
    ignorePaths: api.ignorePaths || [],
  });
  const hasFail = diffs.some((d) => d.level === 'fail');
  return {
    module: api.module, name: api.name, file: api.file, method: api.method, path: api.path, oldApi: api.oldApi || null,
    status: hasFail ? 'FAIL' : 'PASS', httpStatus: resp.status, durationMs: resp.durationMs,
    diffs, infos, fields, warnings,
    // FAIL 时留存新接口实际返回片段（限 2000 字符），写进 JSON 报告——
    // 用于判断是"真改了字段"还是"鉴权/签名失效导致返回异常"
    ...(hasFail ? { newResponseSnippet: JSON.stringify(resp.json).slice(0, 2000) } : {}),
  };
}

/**
 * 并发跑一批接口（worker 池）。
 * - 控制台按完成顺序打印（带 n/total 进度）；返回结果保持 fixture 顺序（报告可 diff）
 * - 遇 401/403 按配置 fail-fast：停止调度新请求，在飞的跑完
 */
async function runAll(apis, ctx, { verbose = false, concurrency = Infinity } = {}) {
  const results = new Array(apis.length);
  let next = 0;
  let done = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped && next < apis.length) {
      const i = next;
      next += 1;
      const result = await runOne(apis[i], ctx);
      results[i] = result;
      done += 1;
      report.printApiResult(result, { verbose, progress: `[${done}/${apis.length}] ` });
      if (
        result.status === 'ERROR'
        && (result.httpStatus === 401 || result.httpStatus === 403)
        && config.failFastOnAuthError
        && !stopped
      ) {
        stopped = true;
        console.error(`\n[中止] 收到 ${result.httpStatus}，疑似鉴权失效（请检查环境变量 ${config.tokenEnvVar} 是否过期），剩余接口跳过。`);
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, apis.length)) }, worker);
  await Promise.all(workers);
  return results.filter(Boolean); // 401 中止时剔除未执行的坑位
}

async function runMock(values) {
  const { startMockServer, mockFixtures, expectations } = require('./lib/mockServer');
  const started = Date.now();
  const server = await startMockServer();
  let exitCode = 1;
  try {
    const apis = mockFixtures.flatMap((m) => m.apis.map((a) => ({ ...a, module: m.module })));
    // mock 模式显式指定业务判定规则，与用户 config 解耦（自测结果不受 config.bizSuccess 改动影响）
    const results = await runAll(apis, {
      baseURL: server.baseURL,
      headers: {},
      timeoutMs: 5000,
      bizSuccess: { field: 'success', value: true, errField: 'errMsg' },
      // 对比策略同样钉死（含"多字段算 fail"严格模式），自测结果不受 config.compare 改动影响
      compare: { nullPolicy: 'asymmetric', strictNumber: false, emptyArrayIsDiff: false, addedIsFail: true },
    }, { verbose: values.verbose });
    report.printSummary(results, { env: 'mock', durationMs: Date.now() - started });

    console.log('\n自测断言:');
    let failed = 0;
    const byName = new Map(results.map((r) => [r.name, r]));
    for (const exp of expectations) {
      const r = byName.get(exp.name);
      const err = r ? exp.check(r) : '用例未执行';
      if (err) {
        failed++;
        console.log(`  ✗ ${exp.name}: ${err}`);
      } else {
        console.log(`  ✓ ${exp.name}`);
      }
    }
    console.log(failed
      ? `\n自测失败 ${failed}/${expectations.length} —— 脚本自身有问题，先别拿去对真实接口`
      : `\n自测全部通过（${expectations.length}/${expectations.length}），脚本可信`);
    exitCode = failed ? 1 : 0;
  } finally {
    await server.close();
  }
  await settleAndExit(exitCode); // 必须在 server.close() 之后：closing 中的 socket 需要宽限
}

async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true, // 位置参数简写：bid.list / bid / list
      options: {
        module: { type: 'string', multiple: true },
        api: { type: 'string', multiple: true },
        env: { type: 'string' },
        mock: { type: 'boolean' },
        verbose: { type: 'boolean' },
        detail: { type: 'boolean' },
        'report-dir': { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    exit2(e.message);
  }
  const { values } = args;
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (values.mock) {
    await runMock(values);
    return;
  }

  const startedAt = new Date();
  const started = Date.now();

  // 环境
  const env = values.env || config.defaultEnv;
  const envConf = config.envs[env];
  if (!envConf) exit2(`未知环境 "${env}"，可选: ${Object.keys(config.envs).join(', ')}`);
  if (!envConf.baseURL) exit2(`环境 "${env}" 还没配地址：请在 .env 里加一行 ${envConf.envVar}=https://新接口域名`);

  // fixture
  const fixturesDir = path.join(__dirname, 'fixtures');
  const { fixtures, errors } = loadFixtures(fixturesDir);
  for (const e of errors) console.error(`[fixture] ${e}`);
  if (fixtures.length === 0) exit2('没有可用的 fixture，请先按 README.md 录入老接口出入参');

  // 位置参数简写 → 翻译成 --module/--api 过滤条件，走下方同一套校验报错
  const positionals = args.positionals || [];
  if (positionals.length > 1) exit2(`位置参数只支持一个（如 bid.list）；要跑多个接口请用 --module/--api`);
  if (positionals.length === 1) {
    const spec = positionals[0];
    const dot = spec.indexOf('.');
    if (dot > 0) {
      values.module = [...(values.module || []), spec.slice(0, dot)];
      values.api = [...(values.api || []), spec.slice(dot + 1)];
    } else if (fixtures.some((f) => f.module === spec)) {
      values.module = [...(values.module || []), spec];
    } else {
      const inModules = fixtures.filter((f) => f.apis.some((a) => a.name === spec)).map((f) => f.module);
      if (inModules.length === 0) exit2(`未找到模块或接口 "${spec}"（可用模块: ${fixtures.map((f) => f.module).join(' / ')}）`);
      if (inModules.length > 1) exit2(`接口名 "${spec}" 在多个模块里都有（${inModules.join(' / ')}），请写成 模块.接口，如 ${inModules[0]}.${spec}`);
      values.api = [...(values.api || []), spec];
    }
  }

  // 过滤
  let selected = fixtures;
  if (values.module && values.module.length) {
    const available = fixtures.map((f) => f.module);
    const unknown = values.module.filter((m) => !available.includes(m));
    if (unknown.length) exit2(`未找到模块: ${unknown.join(', ')}（可用: ${available.join(', ')}）`);
    selected = fixtures.filter((f) => values.module.includes(f.module));
  }
  let apis = selected.flatMap((m) => m.apis);
  if (values.api && values.api.length) {
    const available = apis.map((a) => a.name);
    const unknown = values.api.filter((n) => !available.includes(n));
    if (unknown.length) exit2(`未找到接口: ${unknown.join(', ')}（可用: ${available.join(', ')}）`);
    apis = apis.filter((a) => values.api.includes(a.name));
  }

  // 并发数：CLI 覆盖 config（默认 Infinity = 全部并发）
  let concurrency = config.concurrency || Infinity;
  if (values.concurrency !== undefined) {
    const n = Number(values.concurrency);
    if (!Number.isInteger(n) || n < 1) exit2(`--concurrency 必须是 ≥1 的整数（收到 "${values.concurrency}"）`);
    concurrency = n;
  }

  // 执行
  const ctx = { baseURL: envConf.baseURL, headers: config.buildHeaders(), timeoutMs: config.timeoutMs };
  const results = await runAll(apis, ctx, { verbose: values.verbose, concurrency });
  const durationMs = Date.now() - started;
  report.printSummary(results, { env, durationMs });

  // 报告按 fixture 文件拆分：一个 json 一份 report-<时间戳>-<文件名>.md（时间戳在前：按名称排序=按时间排序，最新的永远排在最后），互不混在一起
  const reportDir = path.resolve(values['report-dir'] || path.join(__dirname, 'reports'));
  const ts = report.timestamp();
  const byFile = new Map();
  for (const r of results) {
    const f = r.file || 'unknown';
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(r);
  }
  for (const [file, fileResults] of byFile) {
    const payload = {
      meta: {
        env, baseURL: envConf.baseURL, startedAt: startedAt.toISOString(), durationMs,
        fixtureErrors: errors.filter((e) => e.startsWith(`${file}:`)), // 只列本文件的 fixture 问题
        detail: values.detail || false, // 报告是否显示完整字段对照
        file, // 来源 json 文件名，报告头部展示
      },
      results: fileResults,
    };
    const mdFile = report.writeMarkdownReport(reportDir, payload, `${ts}-${file.replace(/\.json$/i, '')}`);
    console.log(`报告已写入 ${mdFile}`);
  }

  await settleAndExit(errors.length ? 2 : (results.some((r) => r.status !== 'PASS') ? 1 : 0)); // fixture 有问题属于自身故障，与接口差异区分
}

main().catch((e) => {
  console.error(`[自身故障] ${e.stack || e}`);
  settleAndExit(2);
});
