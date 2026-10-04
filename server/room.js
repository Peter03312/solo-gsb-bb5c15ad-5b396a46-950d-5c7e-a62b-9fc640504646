'use strict';

// 共识演练房间：培训师选定已发布冻结版本开启房间，学员凭加入码取得成员凭证后
// 对当前步的可选处置投票（结算前可改票，每人每步只计最后一票），主持人携所见步号
// 结算，票数最多的选项推进同一条共享会话路径（同票按冻结版本的选项编排顺序）。
//
// 限时模式（rooms.step_duration_sec 非空）：
//  - 每步开始（开房 / 实际推进 / 主持人重开）时在 room_steps 持久化本步截止时间；
//  - 截止前可改票，主持人也可提前结算（手动结算 mode=manual）；
//  - 到点自动补办：有票则沿用既有多数决/同票顺序自动结算（mode=timeout）并从实际
//    推进时刻为下一步计时；零票则停在本步、标记 awaiting_reopen，主持人可凭主持凭证
//    与所见步号重开完整时长；
//  - 到点后拒绝本步新票与改票（STEP_STALE / STEP_AWAITING_REOPEN）。
//  - 无人访问时由后台巡检补结，服务重启后首次访问/巡检同样补办。
//
// 关键不变量：
//  - 房间绑定 (scenario_id, version) 冻结版本，后续发布新版本不改变本场规则；
//  - 房间会话（sessions.room_code 非空）不得经单人选择入口推进（见 session.performMove）；
//  - 投票 / 结算 / 自动结算 / 重开全部在事务内按“当前步号”乐观校验，防并发重复；
//    同一步结算留痕有 (房间, 步号) 唯一约束，自动与手动相遇只可能推进一次；
//  - 任何校验失败都不改变票数、路径与得分，并返回原因及当前步号。

const crypto = require('crypto');
const { initialMask, optionAvailable } = require('./scenario');
const { nodesById, buildSnapshot, performMove } = require('./session');

const STEP_DURATION_MIN = 30;
const STEP_DURATION_MAX = 3600;

function newRoomCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 位，即学员加入码
}
function newHostToken() {
  return `host_${crypto.randomBytes(12).toString('hex')}`;
}
function newMemberToken() {
  return `mem_${crypto.randomBytes(12).toString('hex')}`;
}

function getRoom(db, code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
}

function getRoomSession(db, room) {
  return db.prepare('SELECT * FROM sessions WHERE code = ?').get(room.session_code);
}

function getRoomContent(db, room) {
  const row = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?')
    .get(room.scenario_id, room.version);
  return row ? JSON.parse(row.content) : null;
}

function isTimed(room) {
  return Number.isInteger(room.step_duration_sec);
}

function getStepRow(db, roomCode, stepNo) {
  return db.prepare('SELECT * FROM room_steps WHERE room_code = ? AND step_no = ?')
    .get(roomCode, stepNo);
}

// 为新一步开始计时（房间开启 / 实际推进到下一步）。行不应已存在，冲突时不覆盖既有计时。
function startStepTimerTx(db, room, stepNo, nowMs) {
  if (!isTimed(room)) return;
  db.prepare(`
    INSERT INTO room_steps (room_code, step_no, deadline_ms, status)
    VALUES (?, ?, ?, 'running')
    ON CONFLICT(room_code, step_no) DO NOTHING
  `).run(room.code, stepNo, nowMs + room.step_duration_sec * 1000);
}

// 当前步的票数聚合（optionId -> 票数）
function currentTallies(db, roomCode, stepNo) {
  const rows = db.prepare(`
    SELECT option_id, COUNT(*) AS c FROM room_votes
     WHERE room_code = ? AND step_no = ? GROUP BY option_id
  `).all(roomCode, stepNo);
  return new Map(rows.map((r) => [r.option_id, r.c]));
}

/**
 * 事务内核心：按当前票数以多数决（同票按冻结版本编排顺序）推进当前步并留痕。
 * 调用方负责会话存在/未结束/步号/是否到点等前置校验；本函数只做“有票 → 结算推进”。
 * mode: 'manual' 主持人结算 / 'timeout' 到点自动结算。
 * 限时房间推进成功后，从实际推进时刻为下一步（仍是非结局步时）重新计时。
 */
function settleCurrentInTx(db, room, content, { mode, nowMs = Date.now() }) {
  const session = getRoomSession(db, room);
  if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
  if (session.status !== 'active') {
    return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再结算` };
  }
  const node = nodesById(content).get(session.current_node_id);
  if (!node || node.isEnd) {
    return { ok: false, status: 409, errorCode: 'NODE_NOT_CHOOSABLE', error: '当前步不是可结算节点' };
  }
  const talliesMap = currentTallies(db, room.code, session.step_no);
  const voterCount = [...talliesMap.values()].reduce((a, b) => a + b, 0);
  if (voterCount === 0) {
    return { ok: false, status: 409, errorCode: 'NO_VOTES', error: '当前步还没有任何投票，不能结算' };
  }

  // 按冻结版本的选项编排顺序扫描，严格大于才替换 → 同票时编排在前者胜出
  const eligible = node.options.filter((o) => optionAvailable(o, session.state_mask, content));
  const tallies = eligible.map((o) => ({
    optionId: o.id, optionLabel: o.label, votes: talliesMap.get(o.id) || 0,
  }));
  let winner = null;
  for (const t of tallies) {
    if (!winner || t.votes > winner.votes) winner = t;
  }
  if (!winner || winner.votes === 0) {
    // 理论上不会发生（有票必有可选项），兜底防呆
    return { ok: false, status: 409, errorCode: 'NO_VOTES', error: '当前步没有落在可选项上的投票，不能结算' };
  }

  // 推进共享会话（房间结算内部通道，绕过单人入口限制；步号/条件在 performMove 内再次校验）
  const move = performMove(db, {
    code: session.code,
    optionId: winner.optionId,
    stepNo: session.step_no,
    allowRoomSession: true,
  });
  if (!move.ok) {
    return { ok: false, status: 500, errorCode: 'SETTLE_FAILED', error: `结算推进失败：${move.error}` };
  }

  // 结算留痕；(room_code, step_no) 主键保证同一步不可能被结算两次（手动/自动并发亦如此）
  db.prepare('INSERT INTO room_settlements (room_code, step_no, option_id, tallies, voter_count, mode) VALUES (?, ?, ?, ?, ?, ?)')
    .run(room.code, session.step_no, winner.optionId, JSON.stringify(tallies), voterCount, mode);
  db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE code = ?").run(room.code);

  // 从实际推进时刻为下一步计时（结局步不再计时）
  if (move.session.status === 'active') {
    startStepTimerTx(db, room, move.session.step_no, nowMs);
  }

  return { ok: true, settledStepNo: session.step_no, winner, tallies, voterCount, mode };
}

/**
 * 事务内补办限时房间到期结算（必须在外层事务/savepoint 内调用）。
 *  - 到点且有票：自动多数决推进（mode=timeout），并继续检查下一步是否同样已到期
 *    （无人访问或停机较久时可能连补多步）；
 *  - 到点且零票：本步标记 awaiting_reopen，停在此步等待主持人重开；
 *  - 未到点 / 非限时 / 已结束 / 缺计时行（防御性补建，不补则不改变行为）：不做任何推进。
 * 幂等：已经结算/推进的步没有 running 计时行，重复调用不会二次推进。
 */
function catchUpTimedRoomTx(db, room, content = null, nowMs = Date.now()) {
  const settled = [];
  if (!isTimed(room)) return settled;
  for (let guard = 0; guard < 1000; guard++) {
    const session = getRoomSession(db, room);
    if (!session || session.status !== 'active') break;
    let stepRow = getStepRow(db, room.code, session.step_no);
    if (!stepRow) {
      // 防御：限时房间的当前非结局步理论上必有计时行；缺失时按完整时长补建，绝不丢计时
      const verContent = content || getRoomContent(db, room);
      const node = verContent && nodesById(verContent).get(session.current_node_id);
      if (!node || node.isEnd) break;
      startStepTimerTx(db, room, session.step_no, nowMs);
      stepRow = getStepRow(db, room.code, session.step_no);
    }
    if (!stepRow || stepRow.status !== 'running' || stepRow.deadline_ms > nowMs) break;

    const verContent = content || getRoomContent(db, room);
    if (!verContent) break;
    const talliesMap = currentTallies(db, room.code, session.step_no);
    const voterCount = [...talliesMap.values()].reduce((a, b) => a + b, 0);
    if (voterCount === 0) {
      // 零票：停在本步，标记待重开（不推进、不清票、不改路径得分）
      db.prepare(`
        UPDATE room_steps SET status = 'awaiting_reopen', updated_at = datetime('now')
         WHERE room_code = ? AND step_no = ? AND status = 'running'
      `).run(room.code, session.step_no);
      break;
    }
    const r = settleCurrentInTx(db, room, verContent, { mode: 'timeout', nowMs });
    if (!r.ok) break; // 留痕唯一约束等异常视为已结算，停止补办
    settled.push({ stepNo: r.settledStepNo, optionId: r.winner.optionId, mode: r.mode });
  }
  return settled;
}

// 公开包装：自动以 savepoint 形式嵌套进外层事务；无外层事务时即为普通事务。
function catchUpTimedRoom(db, room, opts = {}) {
  return db.transaction(() => catchUpTimedRoomTx(db, room, opts.content || null, opts.nowMs || Date.now()))();
}

// 后台巡检：无人访问/服务重启后也能补办全部已到点的限时步
function sweepTimedRooms(db, nowMs = Date.now()) {
  const dueRooms = db.prepare(`
    SELECT r.* FROM rooms r
      JOIN sessions se ON se.code = r.session_code
      JOIN room_steps rs ON rs.room_code = r.code AND rs.step_no = se.step_no
     WHERE r.step_duration_sec IS NOT NULL
       AND se.status = 'active' AND rs.status = 'running' AND rs.deadline_ms <= ?
  `).all(nowMs);
  let settledCount = 0;
  for (const room of dueRooms) {
    try {
      settledCount += catchUpTimedRoom(db, room, { nowMs }).length;
    } catch (e) {
      console.error(`[限时房间] 巡检补办失败 room=${room.code}:`, e);
    }
  }
  return settledCount;
}

/**
 * 房间现状快照。viewer 可带 { memberToken, hostToken }：
 *  - 任何人可见：当前步各选项的聚合票数、已结算路径、累计分；
 *  - 有效成员凭证：附加 myVote（自己的投票）；
 *  - 有效主持凭证：附加 votes（逐人投票明细）与 members（成员名单）；
 *  - 未结算前，任何视图都不暴露“谁投了什么”给学员。
 * 凭证提供了但无效时返回 401，不静默降级。
 * 限时房间在出快照前先补办到期结算（访问即触发，配合后台巡检双保险）。
 */
function buildRoomSnapshot(db, room, viewer = {}) {
  catchUpTimedRoom(db, room);

  const session = getRoomSession(db, room);
  const content = getRoomContent(db, room);
  if (!session || !content) {
    return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话或冻结版本内容缺失' };
  }
  const base = buildSnapshot(content, session, room.scenario_id, room.version);
  const sc = db.prepare('SELECT title FROM scenarios WHERE id = ?').get(room.scenario_id);

  const tallies = currentTallies(db, room.code, session.step_no);
  const withVotes = (list) => list.map((o) => ({ ...o, votes: tallies.get(o.id) || 0 }));
  const totalVotes = [...tallies.values()].reduce((a, b) => a + b, 0);
  const memberCount = db.prepare('SELECT COUNT(*) AS c FROM room_members WHERE room_code = ?').get(room.code).c;

  const settlements = db.prepare('SELECT * FROM room_settlements WHERE room_code = ? ORDER BY step_no')
    .all(room.code)
    .map((r) => ({
      stepNo: r.step_no,
      optionId: r.option_id,
      tallies: JSON.parse(r.tallies),
      voterCount: r.voter_count,
      mode: r.mode || 'manual',
      settledAt: r.created_at,
    }));

  // 限时模式计时信息
  const nowMs = Date.now();
  const timed = isTimed(room);
  let stepStatus = null;
  let deadlineMs = null;
  if (timed && session.status === 'active') {
    const row = getStepRow(db, room.code, session.step_no);
    if (row) {
      stepStatus = row.status; // running / awaiting_reopen
      deadlineMs = row.deadline_ms;
    }
  }

  const snapshot = {
    code: room.code,
    joinCode: room.code, // 加入码即房间码
    sessionCode: session.code,
    scenarioId: room.scenario_id,
    scenarioTitle: sc ? sc.title : null,
    version: room.version,
    status: session.status, // active / ended（以绑定会话为准）
    stepNo: session.step_no,
    totalScore: base.totalScore,
    currentNode: base.currentNode,
    startNodeTitle: base.startNodeTitle,
    states: base.states,
    // 投票前不暴露分值/说明（与单人演练一致）；每项附当前聚合票数
    options: withVotes(base.availableOptions),
    unavailableOptions: withVotes(base.unavailableOptions),
    memberCount,
    totalVotes,
    path: base.path.map((p) => ({
      ...p,
      settleMode: (settlements.find((s) => s.stepNo + 1 === p.step) || {}).mode || null,
    })), // 已结算路径（含每步得分、评分说明与结算方式）
    settlements,
    createdAt: room.created_at,
    myVote: null,
    isHost: false,
    // —— 限时模式增量字段（非限时房间 timed=false，其余为 null，旧用法不变）——
    timed,
    stepDurationSec: timed ? room.step_duration_sec : null,
    stepStatus, // running 计时中 / awaiting_reopen 到点零票待重开 / null（非限时或已结束）
    deadlineMs, // 本步截止时间（Unix 毫秒）；null 表示无计时
    deadlineAt: deadlineMs ? new Date(deadlineMs).toISOString() : null,
    remainingMs: stepStatus === 'running' && deadlineMs ? Math.max(0, deadlineMs - nowMs) : null,
    serverNowMs: nowMs, // 服务端当前时间，供页面校准倒计时，避免客户端时钟偏差
  };

  if (viewer.memberToken) {
    const member = db.prepare('SELECT * FROM room_members WHERE room_code = ? AND member_token = ?')
      .get(room.code, viewer.memberToken);
    if (!member) {
      return { ok: false, status: 401, errorCode: 'MEMBER_TOKEN_INVALID', error: '成员凭证无效，请重新加入房间' };
    }
    const my = db.prepare('SELECT option_id FROM room_votes WHERE room_code = ? AND step_no = ? AND member_token = ?')
      .get(room.code, session.step_no, viewer.memberToken);
    snapshot.myVote = my ? { optionId: my.option_id } : null;
    snapshot.memberName = member.name || null;
  }
  if (viewer.hostToken) {
    if (room.host_token !== viewer.hostToken) {
      return { ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID', error: '主持凭证无效' };
    }
    snapshot.isHost = true;
    // 主持人可见逐人投票明细与成员名单
    snapshot.votes = db.prepare(`
      SELECT m.name, v.option_id, v.updated_at FROM room_votes v
        LEFT JOIN room_members m ON m.room_code = v.room_code AND m.member_token = v.member_token
       WHERE v.room_code = ? AND v.step_no = ? ORDER BY v.updated_at, m.id
    `).all(room.code, session.step_no).map((r) => ({ name: r.name || '（匿名学员）', optionId: r.option_id }));
    snapshot.members = db.prepare('SELECT name, created_at FROM room_members WHERE room_code = ? ORDER BY id')
      .all(room.code).map((r) => ({ name: r.name || '（匿名学员）', joinedAt: r.created_at }));
  }
  return { ok: true, snapshot };
}

/**
 * 开启共识演练房间（培训师）。
 * version 缺省为该情境当前最新发布版；指定时必须是已发布（≤ current_version）的版本。
 * stepDurationSec 缺省/为 null 时为旧用法（不限时）；给出时必须为 30..3600 的整数秒。
 * 房间绑定该冻结版本：后续发布新版本不改变本场规则。
 */
function createRoom(db, { scenarioId, version, stepDurationSec }) {
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return { ok: false, status: 404, errorCode: 'SCENARIO_NOT_FOUND', error: '情境不存在' };
  if (sc.current_version < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_NOT_PUBLISHED', error: '该情境尚未发布，无法开启共识演练' };
  }
  const v = version === undefined || version === null ? sc.current_version : Number(version);
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_INVALID', error: `版本号非法：${JSON.stringify(version)}（必须为 ≥1 的整数）` };
  }
  // 每步时长：省略即旧用法（不限时）；填写则必须为 number 类型且为 30..3600 秒整数
  let durationSec = null;
  if (stepDurationSec !== undefined && stepDurationSec !== null && stepDurationSec !== '') {
    durationSec = typeof stepDurationSec === 'number' ? stepDurationSec : Number.NaN;
    if (!Number.isInteger(durationSec) || durationSec < STEP_DURATION_MIN || durationSec > STEP_DURATION_MAX) {
      return {
        ok: false, status: 400, errorCode: 'STEP_DURATION_INVALID',
        error: `每步时长非法：${JSON.stringify(stepDurationSec)}（限时模式必须填写 ${STEP_DURATION_MIN}..${STEP_DURATION_MAX} 秒的整数；省略则不限时）`,
      };
    }
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?').get(sc.id, v);
  if (!versionRow) {
    return { ok: false, status: 404, errorCode: 'VERSION_NOT_FOUND', error: `情境「${sc.title}」不存在已冻结版本 v${v}（当前已发布至 v${sc.current_version}）` };
  }
  const content = JSON.parse(versionRow.content);
  const startNode = (content.nodes || []).find((n) => n.id === content.startNodeId);
  const startIsEnd = !!(startNode && startNode.isEnd);

  // 房间码 / 会话码随机碰撞时极小概率重试
  for (let attempt = 0; attempt < 3; attempt++) {
    const roomCode = newRoomCode();
    const hostToken = newHostToken();
    const sessionCode = crypto.randomBytes(5).toString('hex');
    try {
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO sessions (code, scenario_id, version, current_node_id, state_mask, step_no, status,
                                path, trainee_name, root_code, room_code)
          VALUES (?, ?, ?, ?, ?, 0, 'active', '[]', ?, ?, ?)
        `).run(sessionCode, sc.id, v, content.startNodeId, initialMask(content),
          '共识演练房间', sessionCode, roomCode);
        db.prepare('INSERT INTO rooms (code, host_token, scenario_id, version, session_code, step_duration_sec) VALUES (?, ?, ?, ?, ?, ?)')
          .run(roomCode, hostToken, sc.id, v, sessionCode, durationSec);
        // 限时房间在第 0 步（非结局）开始时即持久化截止时间
        if (durationSec !== null && !startIsEnd) {
          startStepTimerTx(db, { code: roomCode, step_duration_sec: durationSec }, 0, Date.now());
        }
      });
      tx();
      const room = getRoom(db, roomCode);
      return { ok: true, room, hostToken, scenarioTitle: sc.title };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'ROOM_CODE_CONFLICT', error: '房间码生成失败，请重试' };
}

/** 学员凭加入码加入房间，取得成员凭证。已结束的房间仍可加入观摩（投票会被拒绝）。 */
function joinRoom(db, { code, name }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在，请核对加入码' };
  const trimmed = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const memberToken = newMemberToken();
    try {
      db.prepare('INSERT INTO room_members (room_code, member_token, name) VALUES (?, ?, ?)')
        .run(room.code, memberToken, trimmed);
      const snap = buildRoomSnapshot(db, room, { memberToken });
      return { ok: true, room, memberToken, memberName: trimmed, snapshot: snap.snapshot };
    } catch (e) {
      if (String(e && e.message).includes('UNIQUE')) continue;
      throw e;
    }
  }
  return { ok: false, status: 500, errorCode: 'MEMBER_TOKEN_CONFLICT', error: '成员凭证生成失败，请重试' };
}

/**
 * 学员投票 / 改票：{ memberToken, optionId, stepNo }。
 *  - stepNo 必须等于当前步号（过期页面/并发结算后的重复提交一律拒绝）；
 *  - 限时房间先补办到期：到点自动推进后本步投票得到 STEP_STALE；到点零票停步等待
 *    重开期间投票得到 STEP_AWAITING_REOPEN；截止前允许新票与改票；
 *  - 选项必须属于当前节点且条件满足；
 *  - 同一成员同一步只计最后一票（UPSERT）；
 *  - 任何失败都不改变票数、路径与得分，并返回原因及当前步号。
 */
function castVote(db, { code, memberToken, optionId, stepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };

  const member = db.prepare('SELECT * FROM room_members WHERE room_code = ? AND member_token = ?')
    .get(room.code, memberToken);

  const tx = db.transaction(() => {
    // 先补办到期结算（可能已自动推进或转入待重开），再裁决本票
    catchUpTimedRoomTx(db, room);

    const fail = (status, errorCode, error) => {
      const snap = buildRoomSnapshot(db, room, member ? { memberToken } : {});
      return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
    };
    if (!member) {
      return fail(401, 'MEMBER_TOKEN_INVALID', '成员凭证无效，请重新加入房间（未计票）');
    }

    const session = getRoomSession(db, room);
    const content = getRoomContent(db, room);
    if (!session || !content) return fail(500, 'VERSION_MISSING', '房间绑定的会话或冻结版本内容缺失');

    if (session.status !== 'active') {
      return fail(409, 'ROOM_ENDED', `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再投票`);
    }
    if (isTimed(room)) {
      const stepRow = getStepRow(db, room.code, session.step_no);
      if (stepRow && stepRow.status === 'awaiting_reopen') {
        return fail(409, 'STEP_AWAITING_REOPEN',
          `第 ${session.step_no} 步限时已到且无人投票，已停在本步等待主持人重开（重开前不能投票或改票，未计票）`);
      }
    }
    if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
      return fail(409, 'STEP_STALE',
        `步号不匹配：你针对的是第 ${stepNo} 步，房间当前已进行到第 ${session.step_no} 步（可能已被结算/到点自动推进），未计票`);
    }
    const node = nodesById(content).get(session.current_node_id);
    if (!node || node.isEnd) return fail(409, 'NODE_NOT_CHOOSABLE', '当前步不是可投票节点');
    const option = node.options.find((o) => o.id === optionId);
    if (!option) return fail(400, 'OPTION_NOT_FOUND', '当前步不存在该选项，未计票');
    if (!optionAvailable(option, session.state_mask, content)) {
      return fail(409, 'CONDITION_NOT_MET', `当前现场状态不满足选项「${option.label}」的条件，未计票`);
    }

    // 每人每步只计最后一票：主键 (room, step, member) 冲突即改票
    db.prepare(`
      INSERT INTO room_votes (room_code, step_no, member_token, option_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(room_code, step_no, member_token)
      DO UPDATE SET option_id = excluded.option_id, updated_at = datetime('now')
    `).run(room.code, session.step_no, memberToken, optionId);

    const snap = buildRoomSnapshot(db, room, { memberToken });
    return { ok: true, snapshot: snap.snapshot };
  });

  return tx();
}

/**
 * 主持人结算：{ hostToken, observedStepNo }。
 *  - 先补办到期：到点有票已被自动结算 → STEP_STALE；到点零票待重开 → STEP_AWAITING_REOPEN；
 *  - 截止前主持人可随时提前结算（mode=manual），observedStepNo 必须等于当前步号；
 *  - 无人投票不得结算；
 *  - 票数最多的选项推进共享会话；同票按冻结版本的选项编排顺序取先者；
 *  - 推进与留痕在同一事务内完成，(房间, 步号) 唯一约束防并发/自动手动重复结算。
 */
function settleRoom(db, { code, hostToken, observedStepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };
  if (room.host_token !== hostToken) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID',
      error: '主持凭证无效（未结算）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { hostToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  const content = getRoomContent(db, room);
  if (!content) return fail(500, 'VERSION_MISSING', '房间绑定的冻结版本内容缺失');

  const tx = db.transaction(() => {
    // 事务内先补办到期（自动结算/待重开），随后的步号校验天然识别“相遇”场景
    catchUpTimedRoomTx(db, room, content);

    // 事务内重读会话：步号即乐观锁，防并发重复结算/推进
    const session = getRoomSession(db, room);
    if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
    if (session.status !== 'active') {
      return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再结算` };
    }
    if (isTimed(room)) {
      const stepRow = getStepRow(db, room.code, session.step_no);
      if (stepRow && stepRow.status === 'awaiting_reopen') {
        return { ok: false, status: 409, errorCode: 'STEP_AWAITING_REOPEN',
          error: `第 ${session.step_no} 步限时已到且无人投票，已停在本步；请使用“重开本步”恢复计时（不能直接结算）` };
      }
    }
    if (!Number.isInteger(observedStepNo) || observedStepNo !== session.step_no) {
      return { ok: false, status: 409, errorCode: 'STEP_STALE',
        error: `步号不匹配：你看到的是第 ${observedStepNo} 步，房间当前为第 ${session.step_no} 步（可能已被他人/到点自动结算），未结算` };
    }

    return settleCurrentInTx(db, room, content, { mode: 'manual' });
  });

  const result = tx();
  if (!result.ok) return fail(result.status, result.errorCode, result.error);

  const snap = buildRoomSnapshot(db, room, { hostToken });
  const last = snap.ok ? snap.snapshot.path.find((p) => p.step === result.settledStepNo + 1) : null;
  return {
    ok: true,
    settled: {
      stepNo: result.settledStepNo,
      optionId: result.winner.optionId,
      optionLabel: result.winner.optionLabel,
      tallies: result.tallies,
      voterCount: result.voterCount,
      mode: result.mode,
      score: last ? last.score : 0,
      scoreNote: last ? last.scoreNote : '',
      totalScore: snap.ok ? snap.snapshot.totalScore : 0,
    },
    snapshot: snap.ok ? snap.snapshot : null,
  };
}

/**
 * 主持人重开限时房间的暂停步：{ hostToken, observedStepNo }。
 * 仅当该步“到点零票停步（awaiting_reopen）”时允许：凭主持凭证与所见步号，
 * 从操作时刻重新给本步完整时长（原 step_duration_sec）。已有投票（理论上没有）保留。
 * 非限时房间、步号不符、步号仍在计时中、房间已结束等情况一律拒绝并返回当前步号。
 */
function reopenStep(db, { code, hostToken, observedStepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };
  if (room.host_token !== hostToken) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'HOST_TOKEN_INVALID',
      error: '主持凭证无效（未重开）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { hostToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  if (!isTimed(room)) {
    return fail(400, 'NOT_TIMED_ROOM', '该房间不是限时房间，没有限时步需要重开');
  }
  if (!Number.isInteger(observedStepNo)) {
    return fail(400, 'STEP_NO_INVALID', '缺少或非法的 observedStepNo（必须为整数）');
  }

  const tx = db.transaction(() => {
    catchUpTimedRoomTx(db, room);
    const session = getRoomSession(db, room);
    if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
    if (session.status !== 'active') {
      return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能重开` };
    }
    if (observedStepNo !== session.step_no) {
      return { ok: false, status: 409, errorCode: 'STEP_STALE',
        error: `步号不匹配：你看到的是第 ${observedStepNo} 步，房间当前为第 ${session.step_no} 步（可能已被结算/到点自动推进），未重开` };
    }
    const stepRow = getStepRow(db, room.code, session.step_no);
    if (!stepRow) {
      return { ok: false, status: 409, errorCode: 'STEP_NOT_PAUSED', error: '当前步没有待重开的限时记录，未重开' };
    }
    if (stepRow.status !== 'awaiting_reopen') {
      return { ok: false, status: 409, errorCode: 'STEP_NOT_PAUSED',
        error: `第 ${session.step_no} 步仍在计时中，无需重开；只有到点且无人投票的步才能重开，未重开` };
    }
    const nowMs = Date.now();
    const info = db.prepare(`
      UPDATE room_steps
         SET status = 'running', deadline_ms = ?, updated_at = datetime('now')
       WHERE room_code = ? AND step_no = ? AND status = 'awaiting_reopen'
    `).run(nowMs + room.step_duration_sec * 1000, room.code, session.step_no);
    if (info.changes !== 1) {
      return { ok: false, status: 409, errorCode: 'STEP_NOT_PAUSED', error: '当前步已不在待重开状态（可能已被处理），未重开' };
    }
    return { ok: true, reopenedStepNo: session.step_no, deadlineMs: nowMs + room.step_duration_sec * 1000 };
  });

  const result = tx();
  if (!result.ok) return fail(result.status, result.errorCode, result.error);

  const snap = buildRoomSnapshot(db, room, { hostToken });
  return {
    ok: true,
    reopened: {
      stepNo: result.reopenedStepNo,
      stepDurationSec: room.step_duration_sec,
      deadlineMs: result.deadlineMs,
      deadlineAt: new Date(result.deadlineMs).toISOString(),
    },
    snapshot: snap.ok ? snap.snapshot : null,
  };
}

/** 最近房间列表（含限时模式与当前步计时状态；不暴露任何凭证与投票明细）。 */
function listRooms(db) {
  return db.prepare(`
    SELECT r.code, r.scenario_id, s.title AS scenario_title, r.version, r.session_code,
           r.step_duration_sec AS step_duration_sec,
           se.status, se.step_no, r.created_at,
           rs.status AS step_status, rs.deadline_ms AS deadline_ms,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code) AS member_count
      FROM rooms r
      JOIN scenarios s ON s.id = r.scenario_id
      JOIN sessions se ON se.code = r.session_code
      LEFT JOIN room_steps rs ON rs.room_code = r.code AND rs.step_no = se.step_no
     ORDER BY r.created_at DESC, r.code LIMIT 100
  `).all();
}

module.exports = {
  createRoom,
  joinRoom,
  castVote,
  settleRoom,
  reopenStep,
  buildRoomSnapshot,
  listRooms,
  getRoom,
  catchUpTimedRoom,
  sweepTimedRooms,
  STEP_DURATION_MIN,
  STEP_DURATION_MAX,
};
