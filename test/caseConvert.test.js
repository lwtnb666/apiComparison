'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertKey, toCamelKeys } = require('../lib/caseConvert');

test('默认规则：首字母小写，其余原样（缩写词不猜）', () => {
  assert.equal(convertKey('UserName'), 'userName');
  assert.equal(convertKey('UserID'), 'userID'); // 缩写词交给 keyOverrides
  assert.equal(convertKey('URL'), 'uRL');
  assert.equal(convertKey('alreadyCamel'), 'alreadyCamel');
  assert.equal(convertKey('_private'), '_private'); // 非字母开头 no-op
});

test('递归转换嵌套对象与数组，value 不动', () => {
  const { value } = toCamelKeys({
    UserName: '张三',
    Tags: ['A', 'B'],
    Address: { City: '杭州' },
    List: [{ SkuId: 1 }],
  });
  assert.deepEqual(value, {
    userName: '张三',
    tags: ['A', 'B'],
    address: { city: '杭州' },
    list: [{ skuId: 1 }],
  });
});

test('overrides 优先于默认规则，且任意嵌套层级生效', () => {
  const { value } = toCamelKeys(
    { OrderID: 'A1', Detail: { OrderID: 'A2' } },
    { OrderID: 'orderId' },
  );
  assert.deepEqual(value, { orderId: 'A1', detail: { orderId: 'A2' } });
});

test('转换后 key 冲突：保留先出现者并告警，绝不静默覆盖', () => {
  const { value, warnings } = toCamelKeys({ UserID: 1, UserId: 2 }, { UserID: 'userId' });
  assert.deepEqual(value, { userId: 1 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'key-collision');
  assert.equal(warnings[0].from, 'UserId');
});

test('null 与原始值原样保留', () => {
  const { value } = toCamelKeys({ A: null, B: 1.5, C: true });
  assert.deepEqual(value, { a: null, b: 1.5, c: true });
});
