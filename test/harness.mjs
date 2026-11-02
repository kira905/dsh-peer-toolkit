// test/harness.mjs —— 极简断言器（零依赖）
//
// 只做三件事：断言、计数、把失败原因写清楚。
// 纪律：**每个断言都必须能独立复跑**（不依赖上一个断言留下的状态）。
export function createSuite(title) {
  const rows = [];
  const t0 = Date.now();
  const push = (name, pass, detail) => {
    rows.push({ name, pass, detail });
    console.log(`${pass ? '  ✓' : '  ✗'} ${name}${pass || !detail ? '' : `\n      ${detail}`}`);
    return pass;
  };
  return {
    ok(name, cond, detail = '') {
      return push(name, cond === true, cond === true ? '' : detail || `期望 true，实得 ${JSON.stringify(cond)}`);
    },
    eq(name, actual, expected, detail = '') {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      return push(name, same, same ? '' : detail || `期望 ${JSON.stringify(expected)}，实得 ${JSON.stringify(actual)}`);
    },
    throws(name, fn, re) {
      try {
        fn();
        return push(name, false, '期望抛错，但没有抛');
      } catch (e) {
        const msg = String(e?.message ?? e);
        const pass = re ? re.test(msg) : true;
        return push(name, pass, pass ? '' : `抛了但消息不符（/${re}/）：${msg}`);
      }
    },
    section(name) {
      console.log(`\n[${name}]`);
    },
    done() {
      const fail = rows.filter((r) => !r.pass).length;
      const ms = Date.now() - t0;
      console.log(`\n${fail === 0 ? '✅' : '❌'} ${title}：${rows.length - fail}/${rows.length} 通过（${ms} ms）`);
      return { total: rows.length, fail, rows, ms };
    },
  };
}
