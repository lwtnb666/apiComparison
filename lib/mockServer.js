'use strict';

const http = require('node:http');

/**
 * --mock 自测模式：node:http 起本地服务，返回预埋差异的"新接口"数据，
 * 与内嵌的"老 fixture"配套，验证脚本自身（转换器/对比器/HTTP/报告/退出码）是对的。
 *
 * 每个用例的期望结果在 expectations 里，index.js 跑完后逐条断言：
 * 「发现的差异集合 === 预埋差异集合」。
 */

// ---------- 工具 ----------

function json(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

// 递归检查请求里是否混入了大写开头的 key（用于验证请求侧转换）
function findPascalKeys(node, path = '', bad = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findPascalKeys(v, `${path}[${i}]`, bad));
    return bad;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (/^[A-Z]/.test(k)) bad.push(p);
      findPascalKeys(v, p, bad);
    }
  }
  return bad;
}

// ---------- 路由表（"新接口"的预埋行为） ----------

const routes = {
  // 用例1：纯改名——响应只是老数据的小驼峰版，应 PASS
  '/mock/pure-rename': ({ res }) => json(res, 200, {
    code: 0,
    message: 'ok',
    data: {
      userId: 1, userName: '张三', isVip: false, score: 9.5,
      tags: ['x'], address: { city: '杭州' }, avatarUrl: null,
    },
  }),

  // 用例2：后端忘了改大小写——应暴露 missing + added 成对差异
  '/mock/not-renamed': ({ res }) => json(res, 200, { code: 0, data: { UserName: '张三' } }),

  // 用例3：缺字段——新响应少了 data.address.city
  '/mock/missing-field': ({ res }) => json(res, 200, {
    code: 0, data: { address: { zip: '310000' }, name: '张三' },
  }),

  // 用例4：多字段——新响应顶层多了 traceId
  '/mock/added-field': ({ res }) => json(res, 200, { code: 0, data: { name: '张三' }, traceId: 'abc123' }),

  // 用例5：类型变化——total 由 number 变 string
  '/mock/type-changed': ({ res }) => json(res, 200, { code: 0, data: { total: '3' } }),

  // 用例6/7：缩写词——老 OrderID → 新 orderId（配不配 override 两种跑法共用此路由）
  '/mock/acronym': ({ res }) => json(res, 200, { code: 0, data: { orderId: 'A20260901001' } }),

  // 用例8：数组异构行——老侧 a 全 null、b 仅部分行出现；新侧 a 全 string、无 b
  '/mock/array-hetero': ({ res }) => json(res, 200, { code: 0, data: { list: [{ a: 'x' }, { a: 'y' }] } }),

  // 用例9：HTTP 500 + HTML 错误页——应标记 ERROR 且跳过对比
  '/mock/server-error': ({ res }) => {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>Internal Server Error</body></html>');
  },

  // 用例10：验证请求侧 body 的 key 已全部转小驼峰（含嵌套与数组元素）
  '/mock/echo-check': ({ res, body }) => {
    const bad = findPascalKeys(body);
    if (bad.length) return json(res, 400, { code: 400, message: '请求存在大驼峰 key', badKeys: bad });
    return json(res, 200, { code: 0, data: { ok: true } });
  },

  // 用例11：验证 GET query 的 key 已全部转小驼峰；
  //         数组默认按 repeat 序列化（cats=4&cats=41）；空数组不发出（无 areas 参数）
  '/mock/query-check': ({ res, query }) => {
    const keys = [...query.keys()];
    const bad = keys.filter((k) => /^[A-Z]/.test(k));
    const cats = query.getAll('cats');
    const catsOk = cats.length === 2 && cats[0] === '4' && cats[1] === '41';
    if (bad.length || !query.has('userId') || !query.has('status') || !catsOk || query.has('areas')) {
      return json(res, 400, { code: 400, message: 'query 不符合预期', got: keys, cats });
    }
    return json(res, 200, { code: 0, data: { ok: true } });
  },

  // 用例12：HTTP 200 但业务失败——应标记 BIZFAIL 并跳过字段对比
  '/mock/biz-fail': ({ res }) => json(res, 200, { success: false, code: 500, errMsg: '分类没有限定行业', data: {} }),

  // 用例13：POST + URL query 参数也要发出去（query 拼 URL，body 照常发 JSON）
  '/mock/post-query': ({ res, query, body }) => {
    if (query.get('userId') === '7' && body && body.name === 'x') {
      return json(res, 200, { code: 0, data: { ok: true } });
    }
    return json(res, 400, { code: 400, message: 'POST 的 query 或 body 没收到', gotQuery: [...query.keys()], gotBody: body });
  },
};

// ---------- 内嵌"老 fixture"（人工维护视角，大驼峰原样） ----------

const mockFixtures = [
  {
    module: 'mock',
    apis: [
      {
        name: 'PureRename', method: 'GET', path: '/mock/pure-rename',
        response: {
          Code: 0, Message: 'ok',
          Data: {
            UserId: 1, UserName: '李四', IsVip: true, Score: 100,
            Tags: ['a', 'b'], Address: { City: '上海' }, AvatarUrl: null,
          },
        },
      },
      {
        name: 'NotRenamed', method: 'GET', path: '/mock/not-renamed',
        response: { Code: 0, Data: { UserName: '李四' } },
      },
      {
        name: 'MissingField', method: 'GET', path: '/mock/missing-field',
        response: { Code: 0, Data: { Address: { City: '上海', Zip: '200000' }, Name: '李四' } },
      },
      {
        name: 'AddedField', method: 'GET', path: '/mock/added-field',
        response: { Code: 0, Data: { Name: '李四' } },
      },
      {
        name: 'TypeChanged', method: 'GET', path: '/mock/type-changed',
        response: { Code: 0, Data: { Total: 3 } },
      },
      {
        name: 'AcronymNoOverride', method: 'GET', path: '/mock/acronym',
        response: { Code: 0, Data: { OrderID: 'B1' } },
      },
      {
        name: 'AcronymWithOverride', method: 'GET', path: '/mock/acronym',
        keyOverrides: { OrderID: 'orderId' },
        response: { Code: 0, Data: { OrderID: 'B1' } },
      },
      {
        name: 'ArrayHetero', method: 'GET', path: '/mock/array-hetero',
        response: { Code: 0, Data: { List: [{ A: null, B: 1 }, { A: null }] } },
      },
      {
        name: 'ServerError', method: 'GET', path: '/mock/server-error',
        response: { Code: 0, Data: { Ok: true } },
      },
      {
        name: 'RequestConvert', method: 'POST', path: '/mock/echo-check',
        request: { body: { PageIndex: 1, Filters: { UserName: 'x' }, Ids: [{ SkuId: 1 }] } },
        response: { Code: 0, Data: { Ok: true } },
      },
      {
        name: 'QueryConvert', method: 'GET', path: '/mock/query-check',
        request: { query: { UserId: 1001, Status: 'on', Cats: [4, 41], Areas: [] } },
        response: { Code: 0, Data: { Ok: true } },
      },
      {
        name: 'BizFail', method: 'GET', path: '/mock/biz-fail',
        response: { Code: 0, Data: { Ok: true } },
      },
      {
        name: 'PostQuery', method: 'POST', path: '/mock/post-query',
        request: { query: { UserId: 7 }, body: { Name: 'x' } },
        response: { Code: 0, Data: { Ok: true } },
      },
    ],
  },
];

// ---------- 期望断言 ----------

function diffSet(r) {
  return r.diffs.map((d) => `${d.type} ${d.path}`).sort();
}

function expectDiffsExactly(r, want) {
  const actual = diffSet(r);
  const expected = [...want].sort();
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? null
    : `期望差异 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
}

const expectations = [
  {
    name: 'PureRename',
    check: (r) => (r.status === 'PASS' && r.diffs.length === 0
      ? null : `期望 PASS 无差异，实际 ${r.status} ${JSON.stringify(diffSet(r))}`),
  },
  { name: 'NotRenamed', check: (r) => expectDiffsExactly(r, ['missing-in-new data.userName', 'added-in-new data.UserName']) },
  { name: 'MissingField', check: (r) => expectDiffsExactly(r, ['missing-in-new data.address.city']) },
  {
    name: 'AddedField',
    check: (r) => (r.status === 'FAIL'
      ? expectDiffsExactly(r, ['added-in-new traceId'])
      : `期望 FAIL（严格模式下多字段挂红），实际 ${r.status}`),
  },
  { name: 'TypeChanged', check: (r) => expectDiffsExactly(r, ['type-mismatch data.total']) },
  { name: 'AcronymNoOverride', check: (r) => expectDiffsExactly(r, ['missing-in-new data.orderID', 'added-in-new data.orderId']) },
  {
    name: 'AcronymWithOverride',
    check: (r) => (r.status === 'PASS' && r.diffs.length === 0
      ? null : `期望 override 后 PASS，实际 ${r.status} ${JSON.stringify(diffSet(r))}`),
  },
  {
    name: 'ArrayHetero',
    check: (r) => (r.status === 'PASS' && r.diffs.length === 0 && r.infos.length >= 2
      ? null : `期望 PASS 且有 ≥2 条提示，实际 ${r.status} diffs=${JSON.stringify(diffSet(r))} infos=${r.infos.length}`),
  },
  {
    name: 'ServerError',
    check: (r) => (r.status === 'ERROR' && r.error === 'HTTP_ERROR' && r.httpStatus === 500
      ? null : `期望 ERROR/HTTP_ERROR/500，实际 ${r.status}/${r.error}/${r.httpStatus}`),
  },
  {
    name: 'RequestConvert',
    check: (r) => (r.status === 'PASS'
      ? null : `期望 PASS（请求 body 的 key 应全部小驼峰），实际 ${r.status} ${r.error || ''} ${JSON.stringify(diffSet(r))}`),
  },
  {
    name: 'QueryConvert',
    check: (r) => (r.status === 'PASS'
      ? null : `期望 PASS（query key 应全部小驼峰），实际 ${r.status} ${r.error || ''} ${JSON.stringify(diffSet(r))}`),
  },
  {
    name: 'BizFail',
    check: (r) => (r.status === 'BIZFAIL' && r.diffs.length === 0 && /分类没有限定行业/.test(r.bizErrMsg || '')
      ? null : `期望 BIZFAIL 且不参与字段对比、带 errMsg，实际 ${r.status} diffs=${JSON.stringify(diffSet(r))} bizErrMsg=${r.bizErrMsg}`),
  },
  {
    name: 'PostQuery',
    check: (r) => (r.status === 'PASS'
      ? null : `期望 PASS（POST 的 query 应拼到 URL、body 照常发），实际 ${r.status} ${r.error || ''} ${JSON.stringify(diffSet(r))}`),
  },
];

// ---------- 启动 ----------

function startMockServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handler = routes[url.pathname];
    if (!handler) return json(res, 404, { code: 404, message: `unknown mock route: ${url.pathname}` });
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) { try { body = JSON.parse(text); } catch { body = null; } }
    }
    return handler({ req, res, query: url.searchParams, body });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockServer, mockFixtures, expectations };
