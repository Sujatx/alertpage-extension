// Test-only Worker (never deployed): runs the real ingest Worker but makes its write batch fail by construction (AC-6).
// The Worker calls db.batch() twice per accepted request: read-only prelude, then the write. The second call gets a
// statement that violates a CHECK at the very end, so D1 must roll the whole transaction back.
import worker from '../src/index.js';

export default {
  fetch(req, env, ctx) {
    let calls = 0;
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === 'batch') return (stmts) => t.batch(++calls === 2
          ? [...stmts, t.prepare(`INSERT INTO dispositions (event_id, lead_id, dispatcher_id, action, submitted_at, dup_marker, outcome_status, derive_rule_version)
                                  VALUES ('poison', 1, 'x', 'not_an_action', 0, 0, 'pending', 'x')`)]
          : stmts);
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return worker.fetch(req, { ...env, DB: db }, ctx);
  },
};
