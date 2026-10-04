'use strict';

// 共识演练房间：培训师选定已发布冻结版本开启房间，学员凭加入码取得成员凭证后
// 对当前步的可选处置投票（结算前可改票，每人每步只计最后一票），主持人携所见步号
// 结算，票数最多的选项推进同一条共享会话路径（同票按冻结版本的选项编排顺序）。
//
// 关键不变量：
//  - 房间绑定 (scenario_id, version) 冻结版本，后续发布新版本不改变本场规则；
//  - 房间会话（sessions.room_code 非空）不得经单人选择入口推进（见 session.performMove）；
//  - 投票 / 结算 / 推进全部在事务内按“当前步号”乐观校验，防并发重复；
//  - 任何校验失败都不改变票数、路径与得分，并返回原因及当前步号。

const crypto = require('crypto');
const { initialMask, optionAvailable } = require('./scenario');
const { nodesById, buildSnapshot, performMove } = require('./session');

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

// 当前步的票数聚合（optionId -> 票数）
function currentTallies(db, roomCode, stepNo) {
  const rows = db.prepare(`
    SELECT option_id, COUNT(*) AS c FROM room_votes
     WHERE room_code = ? AND step_no = ? GROUP BY option_id
  `).all(roomCode, stepNo);
  return new Map(rows.map((r) => [r.option_id, r.c]));
}

/**
 * 房间现状快照。viewer 可带 { memberToken, hostToken }：
 *  - 任何人可见：当前步各选项的聚合票数、已结算路径、累计分；
 *  - 有效成员凭证：附加 myVote（自己的投票）；
 *  - 有效主持凭证：附加 votes（逐人投票明细）与 members（成员名单）；
 *  - 未结算前，任何视图都不暴露“谁投了什么”给学员。
 * 凭证提供了但无效时返回 401，不静默降级。
 */
function buildRoomSnapshot(db, room, viewer = {}) {
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
    path: base.path, // 已结算路径（含每步得分与评分说明）
    settlements: db.prepare('SELECT * FROM room_settlements WHERE room_code = ? ORDER BY step_no')
      .all(room.code)
      .map((r) => ({
        stepNo: r.step_no,
        optionId: r.option_id,
        tallies: JSON.parse(r.tallies),
        voterCount: r.voter_count,
        settledAt: r.created_at,
      })),
    createdAt: room.created_at,
    myVote: null,
    isHost: false,
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
 * 房间绑定该冻结版本：后续发布新版本不改变本场规则。
 */
function createRoom(db, { scenarioId, version }) {
  const sc = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(scenarioId);
  if (!sc) return { ok: false, status: 404, errorCode: 'SCENARIO_NOT_FOUND', error: '情境不存在' };
  if (sc.current_version < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_NOT_PUBLISHED', error: '该情境尚未发布，无法开启共识演练' };
  }
  const v = version === undefined || version === null ? sc.current_version : Number(version);
  if (!Number.isInteger(v) || v < 1) {
    return { ok: false, status: 400, errorCode: 'VERSION_INVALID', error: `版本号非法：${JSON.stringify(version)}（必须为 ≥1 的整数）` };
  }
  const versionRow = db.prepare('SELECT content FROM versions WHERE scenario_id = ? AND version = ?').get(sc.id, v);
  if (!versionRow) {
    return { ok: false, status: 404, errorCode: 'VERSION_NOT_FOUND', error: `情境「${sc.title}」不存在已冻结版本 v${v}（当前已发布至 v${sc.current_version}）` };
  }
  const content = JSON.parse(versionRow.content);

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
        db.prepare('INSERT INTO rooms (code, host_token, scenario_id, version, session_code) VALUES (?, ?, ?, ?, ?)')
          .run(roomCode, hostToken, sc.id, v, sessionCode);
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
 *  - 选项必须属于当前节点且条件满足；
 *  - 同一成员同一步只计最后一票（UPSERT）；
 *  - 任何失败都不改变票数、路径与得分，并返回原因及当前步号。
 */
function castVote(db, { code, memberToken, optionId, stepNo }) {
  const room = getRoom(db, code);
  if (!room) return { ok: false, status: 404, errorCode: 'ROOM_NOT_FOUND', error: '房间不存在' };

  const member = db.prepare('SELECT * FROM room_members WHERE room_code = ? AND member_token = ?')
    .get(room.code, memberToken);
  if (!member) {
    const pub = buildRoomSnapshot(db, room, {});
    return {
      ok: false, status: 401, errorCode: 'MEMBER_TOKEN_INVALID',
      error: '成员凭证无效，请重新加入房间（未计票）',
      current: pub.ok ? pub.snapshot : null,
    };
  }

  const fail = (status, errorCode, error) => {
    const snap = buildRoomSnapshot(db, room, { memberToken });
    return { ok: false, status, errorCode, error, current: snap.ok ? snap.snapshot : null };
  };

  const session = getRoomSession(db, room);
  const content = getRoomContent(db, room);
  if (!session || !content) return fail(500, 'VERSION_MISSING', '房间绑定的会话或冻结版本内容缺失');

  if (session.status !== 'active') {
    return fail(409, 'ROOM_ENDED', `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再投票`);
  }
  if (!Number.isInteger(stepNo) || stepNo !== session.step_no) {
    return fail(409, 'STEP_STALE',
      `步号不匹配：你针对的是第 ${stepNo} 步，房间当前已进行到第 ${session.step_no} 步（可能已被结算推进），未计票`);
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
}

/**
 * 主持人结算：{ hostToken, observedStepNo }。
 *  - observedStepNo 必须等于当前步号（所见步号过期则拒绝并返回当前步号）；
 *  - 无人投票不得结算；
 *  - 票数最多的选项推进共享会话；同票按冻结版本的选项编排顺序取先者；
 *  - 推进与留痕在同一事务内完成，(房间, 步号) 唯一约束防并发重复结算。
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
    // 事务内重读会话：步号即乐观锁，防并发重复结算/推进
    const session = getRoomSession(db, room);
    if (!session) return { ok: false, status: 500, errorCode: 'VERSION_MISSING', error: '房间绑定的会话缺失' };
    if (session.status !== 'active') {
      return { ok: false, status: 409, errorCode: 'ROOM_ENDED', error: `本场共识演练已结束（止步于第 ${session.step_no} 步），不能再结算` };
    }
    if (!Number.isInteger(observedStepNo) || observedStepNo !== session.step_no) {
      return { ok: false, status: 409, errorCode: 'STEP_STALE',
        error: `步号不匹配：你看到的是第 ${observedStepNo} 步，房间当前为第 ${session.step_no} 步（可能已被他人结算），未结算` };
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

    // 结算留痕；(room_code, step_no) 主键保证同一步不可能被结算两次
    db.prepare('INSERT INTO room_settlements (room_code, step_no, option_id, tallies, voter_count) VALUES (?, ?, ?, ?, ?)')
      .run(room.code, session.step_no, winner.optionId, JSON.stringify(tallies), voterCount);
    db.prepare("UPDATE rooms SET updated_at = datetime('now') WHERE code = ?").run(room.code);

    return { ok: true, settledStepNo: session.step_no, winner, tallies, voterCount };
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
      score: last ? last.score : 0,
      scoreNote: last ? last.scoreNote : '',
      totalScore: snap.ok ? snap.snapshot.totalScore : 0,
    },
    snapshot: snap.ok ? snap.snapshot : null,
  };
}

/** 最近房间列表（含状态、步号、成员数；不暴露任何凭证与投票明细）。 */
function listRooms(db) {
  return db.prepare(`
    SELECT r.code, r.scenario_id, s.title AS scenario_title, r.version, r.session_code,
           se.status, se.step_no, r.created_at,
           (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code) AS member_count
      FROM rooms r
      JOIN scenarios s ON s.id = r.scenario_id
      JOIN sessions se ON se.code = r.session_code
     ORDER BY r.created_at DESC, r.code LIMIT 100
  `).all();
}

module.exports = { createRoom, joinRoom, castVote, settleRoom, buildRoomSnapshot, listRooms, getRoom };
