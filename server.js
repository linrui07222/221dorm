'use strict';
/*  221 宿舍 · 联机服务器
 *  零依赖：只用 Node 内置模块。启动： node server.js   （默认 8080）
 *  协议： GET /events?room=CODE&pid=PID  → SSE 状态推送
 *         POST /api/<action>            → JSON 指令
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;

const ROUND_MS = Number(process.env.D221_ROUND_MS || 90_000);   // 每轮行动时间
const VOTE_MS = Number(process.env.D221_VOTE_MS || 25_000);    // 指认投票
const OWL_MS = Number(process.env.D221_OWL_MS || 22_000);     // 闭眼
const PICK_MS = Number(process.env.D221_PICK_MS || 25_000);    // 终局指认地点
const CALL_MS = Number(process.env.D221_CALL_MS || 20_000);    // 公开口令窗口
const BUDGET = 180;        // 每人每轮行动预算（秒）

const ROLES = {
  pink:   { name: '粉毛',   who: '阿桃',   task: '让 2 个人夸你的头发',
            skill: '粉毛反光', skillDesc: '亮一下头发，拿到一条线索——但全场都看见你亮了',
            persona: '头发最亮，断电后唯一自带反光标识的人',
            joke: '越黑越显眼，越显眼越可疑。' },
  nerd:   { name: '学霸',   who: '林默',   task: '让 3 个人承认作业没写完',
            skill: '重点划圈', skillDesc: '在纸上划掉一个绝对不是小夜灯的位置',
            persona: '唯一还惦记作业的人，坚持用最后电量记笔记',
            joke: '全宿舍都怕他问「你作业写了吗」。' },
  dragon: { name: '龙王',   who: '大刘',   task: '让 3 个人跟着喊「龙王驾到」',
            skill: '龙王降雨', skillDesc: '喊一个动作，没照做的人这一轮不能投票',
            persona: '嘴强王者、水群之王，断电后负责呼风唤雨',
            joke: '宿舍没水，但龙王必须降雨。' },
  flo:    { name: '弗洛洛', who: '阿远', task: '把暗号悄悄传给一个人，别被第三人听见',
            skill: '悄悄话结界', skillDesc: '和一个室友交换一条任务提示，第三人不许听',
            persona: '神秘中二担当，掌握全宿舍最多奇怪暗号',
            joke: '越神秘越像幕后黑手。' },
  gz:     { name: '贵州',   who: '小胖',   task: '让 2 个人学你说一句方言',
            skill: '方言加密', skillDesc: '用方言喊一句指令，跟着学的人越多越好',
            persona: '方言输出机，自带酸汤与辣椒气场',
            joke: '全宿舍都在猜「到底是不是这个意思」。' },
  pig:    { name: '猪',     who: '阿哲',   task: '找到外卖，或让 3 个人说「饿了」',
            skill: '吃货嗅觉', skillDesc: '问裁判：灯离外卖近不近（远 / 近）',
            persona: '吃货＋躺平担当，鼻子最灵，最关心神秘外卖藏哪',
            joke: '找灯是顺便，找外卖是主线。' }
};
const ROLE_IDS = Object.keys(ROLES);

const SPOTS = {
  balcony: { name: '阳台门后', h: 0, w: 1, s: 1 },
  bunk:    { name: '上铺被窝', h: 1, w: 1, s: 1 },
  drawer:  { name: '书桌抽屉', h: 0, w: 1, s: 0 },
  books:   { name: '课本堆',   h: 1, w: 1, s: 0 },
  closet:  { name: '衣柜顶层', h: 1, w: 0, s: 0 },
  water:   { name: '饮水机后', h: 0, w: 0, s: 0 },
  case:    { name: '行李箱',   h: 0, w: 0, s: 1 },
  hook:    { name: '门后挂钩', h: 1, w: 0, s: 1 }
};
const SPOT_IDS = Object.keys(SPOTS);
const FOOD_IDS = ['drawer', 'case', 'books'];

const CLUE_TEXT = {
  'h1': '高度：那东西在高处——得踮脚，最好再踩个凳子。',
  'h0': '高度：那东西在低处——蹲下去，视线贴着地面。',
  'w1': '方位：在靠窗的那半边。风从窗缝灌进来，凉的。',
  'w0': '方位：在靠门的那半边。走廊的光从门缝漏进来。',
  's1': '材质：外面裹着软的——布、被子、毛巾之类。',
  's0': '材质：敲上去是硬的——木板、铁皮、塑料箱。'
};
const ATTR_LABEL = { h: '高度', w: '方位', s: '材质' };
const ATTR_TEXT = {
  h: { '1': '高处', '0': '低处' },
  w: { '1': '靠窗', '0': '靠门' },
  s: { '1': '软的', '0': '硬的' }
};

const COST = { search: 50, talk: 30, observe: 20, confess: 25, whisper: 25, skill: 20 };

// 方言口令（不泄露线索，只是气氛）
const MAX_GAIN = { praise: 2, followed: 3, learned: 2, hungry: 3 };
function bumpTask(by, gain, n) {
  if (!by || !gain) return 0;
  const cap = MAX_GAIN[gain] || 3;
  by.task[gain] = Math.min(cap, (by.task[gain] || 0) + (n || 1));
  return by.task[gain];
}

const DIALECT_LINES = [
  '莫慌嘛，黑起个灯算哪样事，慢慢摸。',
  '哪个在偷吃？动静小点嘛，我听到起咯。',
  '你们几个搞快点，莫要磨磨唧唧的。',
  '灯嘛，肯定藏得深，慢慢找，莫得慌。'
];

const rooms = new Map();

/* ───────────────────────── 工具 ───────────────────────── */

const now = () => Date.now();
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const uid = (n) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[rnd(abc.length)];
  return s;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function cleanText(t) {
  return String(t || '').replace(/[<>&]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function newCode() {
  let c = uid(4);
  while (rooms.has(c)) c = uid(4);
  return c;
}

/* ───────────────────────── 房间与玩家 ───────────────────────── */

function makePlayer(name, isBot) {
  return {
    id: isBot ? 'bot_' + uid(6) : uid(8),
    name, isBot: !!isBot,
    role: null,
    time: BUDGET,
    clues: new Set(),
    searched: new Set(),
    ended: false,
    voted: null,
    msgUsed: false,
    muted: false,          // 龙王降雨没照做：这一轮不能投票
    pubClues: new Set(),   // 被指认时已经公开过的属性，别重复
    lastSpot: null,
    task: {
      praise: 0,          // 粉毛：被夸
      admits: 0,          // 学霸：承认作业没写完
      followed: 0,        // 龙王：跟着喊
      learned: 0,         // 贵州：学着说
      hungry: 0,          // 猪：说饿了
      whisperDone: false, // 弗洛洛：暗号传出去了
      foodFound: false,   // 猪：找到外卖
      skillUsed: false,   // 每局一次的公开技能
      botPct: 0
    },
    privateLog: []
  };
}

function makeRoom(hostName, mode) {
  const room = {
    code: newCode(),
    mode: mode === 'hunt' ? 'hunt' : mode === 'code' ? 'code' : 'search',
    createdAt: now(),
    hostId: null,
    phase: 'lobby',
    round: 1,
    endsAt: 0,
    players: [],
    lamp: pick(SPOT_IDS),
    food: pick(FOOD_IDS),
    feed: [],          // 公共消息 {t,text,kind}
    votes: new Map(),
    picks: new Map(),
    owl: null,
    call: null,        // 公开口令窗口 { by, kind, label, reactText, until, reactors, botAt, mute }
    excluded: new Set(), // 学霸划掉 / 粉毛排除的点
    confess: null,
    found: false,
    foundBy: null,
    result: null,
    clients: new Map(), // pid -> res
    dirty: true
  };
  const host = makePlayer(hostName || '房主', false);
  room.players.push(host);
  room.hostId = host.id;
  rooms.set(room.code, room);
  return room;
}

const roomFull = (r) => r.players.filter(p => !p.isBot).length >= 6;
const humans = (r) => r.players.filter(p => !p.isBot);
const alive = (r) => r.players.filter(p => p.role);

function logP(room, text, kind = 'info') {
  room.feed.push({ t: now(), text, kind });
  if (room.feed.length > 80) room.feed.shift();
}
function plog(p, text) {
  p.privateLog.push({ t: now(), text });
  if (p.privateLog.length > 40) p.privateLog.shift();
}

function broadcast(room) {
  room.dirty = false;
  for (const [pid, res] of room.clients) {
    const p = room.players.find(x => x.id === pid);
    if (!p) continue;
    try {
      res.write('event: state\ndata: ' + JSON.stringify(snap(room, p)) + '\n\n');
    } catch (_) { room.clients.delete(pid); }
  }
}

/* ───────────────────────── 序列化 ───────────────────────── */

function clueList(p) {
  return [...p.clues].map(k => ({ key: k, attr: ATTR_LABEL[k[0]], value: ATTR_TEXT[k[0]][k[1]], text: CLUE_TEXT[k] }));
}

function taskPct(p) {
  const t = p.task || {};
  const ratio = (a, b) => Math.round(clamp((a || 0) / b, 0, 1) * 100);
  switch (p.role) {
    case 'pink': return ratio(t.praise, 2);
    case 'nerd': return ratio(t.admits, 3);
    case 'dragon': return ratio(t.followed, 3);
    case 'flo': return t.whisperDone ? 100 : 0;
    case 'gz': return ratio(t.learned, 2);
    case 'pig': return t.foodFound ? 100 : ratio(t.hungry, 3);
    default: return 0;
  }
}
const taskDone = (p) => taskPct(p) >= 100;

function snap(room, me) {
  const others = room.players.map(p => ({
    id: p.id, name: p.name, role: p.role, isBot: p.isBot,
    ended: !!p.ended, voted: !!p.voted, online: room.clients.has(p.id),
    pct: p.isBot ? Math.round(p.task.botPct) : null
  }));
  const base = {
    srvNow: now(),
    room: {
      code: room.code, phase: room.phase, round: room.round,
      endsAt: room.endsAt, hostId: room.hostId, found: room.found,
      foundBy: room.foundBy, spotNames: Object.fromEntries(SPOT_IDS.map(k => [k, SPOTS[k].name])),
      spotAttrs: Object.fromEntries(SPOT_IDS.map(k => [k, [ATTR_TEXT.h[SPOTS[k].h], ATTR_TEXT.w[SPOTS[k].w], ATTR_TEXT.s[SPOTS[k].s]]])),
      excluded: [...room.excluded],
      myLampClue: null
    },
    me: {
      id: me.id, name: me.name, role: me.role, isBot: me.isBot,
      time: me.time, budget: BUDGET, ended: me.ended, msgUsed: me.msgUsed,
      clues: clueList(me), searched: [...me.searched],
      task: { praise: me.task.praise, admits: me.task.admits, followed: me.task.followed, learned: me.task.learned, hungry: me.task.hungry, whisperDone: me.task.whisperDone, foodFound: me.task.foodFound, skillUsed: me.task.skillUsed },
      muted: !!me.muted,
      taskPct: taskPct(me),
      log: me.privateLog.slice(-12)
    },
    players: others,
    feed: room.feed.slice(-40),
    roles: ROLES,
    costs: COST,
    vote: null, owl: null, pick: null, call: null, confess: null,
    result: null
  };

  base.room.mode = room.mode;
  if (room.mode === 'hunt' && room.hunt) {
    base.hunt = huntSnap(room, me);
    if (room.phase === 'end') base.result = room.result;
    return base;
  }
  if (room.mode === 'code' && room.cd) {
    const cd = room.cd;
    const w = WAVES[cd.wave - 1] || WAVES[0];
    const frag = cd.frags.get(me.id) || { t: '' };
    const mine = cd.picks.get(me.id) || null;
    base.code = {
      wave: cd.wave, total: WAVES.length, phase: cd.phase,
      ghost: w.ghost,
      threat: THREATS[cd.threatIdx], door: DOORS[cd.doorIdx],
      chars: CODE_CHARS,
      frag: frag.t,
      notes: (cd.notes.get(me.id) || []).slice(-4),
      pick: mine ? { skill: mine.skill, guess: mine.guess } : null,
      submitted: cd.picks.size, people: room.players.length,
      skillUsed: !!me.task.skillUsed,
      reveal: cd.phase === 'reveal' ? cd.reveal : null,
      verdict: cd.phase === 'reveal' ? cd.verdict : null,
      ach: (me.ach || []).map(id => ({ id, name: ACH[id] })),
      correct: me.codeCorrect || 0
    };
  }

  if (room.phase === 'vote') {
    base.vote = { open: true, myTarget: me.voted || null, votedCount: room.players.filter(p => p.voted).length, total: room.players.length };
  }
  if (room.phase === 'owl') {
    base.owl = {
      open: true,
      closed: room.owl.closed.map(id => (room.players.find(p => p.id === id) || {}).name),
      meClosed: room.owl.closed.includes(me.id),
      deadline: room.owl.deadline
    };
  }
  if (room.phase === 'pick') {
    base.pick = { open: true, mySpot: room.picks.get(me.id) || null, pickedCount: room.picks.size, total: room.players.length };
  }
  if (room.call && room.call.until > now()) {
    const by = room.players.find(p => p.id === room.call.by) || {};
    base.call = {
      open: true, by: by.name || '', kind: room.call.kind,
      label: room.call.label, reactText: room.call.reactText,
      deadline: room.call.until, mine: room.call.reactors.includes(me.id),
      count: room.call.reactors.length
    };
  }
  if (room.confess && room.confess.deadline > now() && room.confess.target === me.id) {
    base.confess = {
      open: true, from: (room.players.find(p => p.id === room.confess.asker) || {}).name,
      deadline: room.confess.deadline
    };
  }
  if (room.phase === 'end') base.result = room.result;
  return base;
}

/* ───────────────────────── 开局与回合 ───────────────────────── */

function fillBots(room) {
  const taken = new Set(room.players.map(p => p.role));
  for (const rid of ROLE_IDS) {
    if (taken.has(rid)) continue;
    const b = makePlayer(ROLES[rid].who, true);
    b.role = rid;
    room.players.push(b);
  }
}

function startRound(room) {
  room.phase = 'round';
  room.endsAt = now() + ROUND_MS;
  room.votes.clear();
  for (const p of room.players) {
    p.time = BUDGET;
    p.ended = false;
    p.voted = null;
    p.msgUsed = false;
  }
  logP(room, `第 ${room.round} 轮开始。${ROUND_MS / 1000} 秒，各自动手。`, 'phase');
  // NPC 在后台悄悄翻找
  for (const b of room.players.filter(p => p.isBot)) {
    b.searched.add(pick(SPOT_IDS));
    b.task.botPct = clamp(b.task.botPct + rnd(22) + 8, 0, 100);
    if (Math.random() < 0.5) {
      const s = SPOTS[pick(SPOT_IDS)];
      b.clues.add(pick(['h', 'w', 's']) + pick(['0', '1']));
    }
  }
  // NPC 偶尔也会放技能，别让口令窗口只在真人手里出现
  const fresh = room.players.filter(p => p.isBot && !p.task.skillUsed);
  if (fresh.length && Math.random() < 0.4) {
    const b = pick(fresh);
    const others = room.players.filter(x => x.id !== b.id);
    const arg = b.role === 'flo' ? pick(others).id
      : b.role === 'dragon' ? pick(['喝水', '拍桌', '抱头']) : null;
    actSkill(room, b, arg);
  }
  broadcast(room);
}

function endRound(room) {
  if (room.phase !== 'round') return;
  room.phase = 'vote';
  room.endsAt = now() + VOTE_MS;
  room.votes.clear();
  for (const b of room.players.filter(p => p.isBot)) {
    const cand = room.players.filter(p => p.id !== b.id);
    b.voted = pick(cand).id;
    room.votes.set(b.id, b.voted);
  }
  logP(room, `第 ${room.round} 轮结束。${VOTE_MS / 1000} 秒：指认一个最可疑的人。`, 'phase');
  broadcast(room);
}

function clueKeyOfSpot(sid) {
  const s = SPOTS[sid];
  return ['h', 'w', 's'].map(k => k + s[k]);
}

function revealOneClue(room, target, toPublic) {
  const known = [...target.clues];
  if (!known.length) {
    // 没线索就给一条他翻过的点的属性
    const searched = [...target.searched];
    if (searched.length) {
      const s = SPOTS[pick(searched)];
      const a = pick(['h', 'w', 's']);
      known.push(a + s[a]);
    }
  }
  if (!known.length) return null;
  const k = pick(known);
  if (toPublic) logP(room, `${target.name} 被指认后交出一条线索 — ${CLUE_TEXT[k]}`, 'clue');
  return k;
}

function accuseClue(room, t) {
  switch (t.role) {
    case 'pink': {
      const cands = SPOT_IDS.filter(id => id !== room.lamp && !room.excluded.has(id));
      if (!cands.length) { logP(room, `${t.name} 耸耸肩：「都被划完了，我说什么都不算数了。」`, 'vote'); return; }
      const sid = pick(cands);
      room.excluded.add(sid);
      logP(room, `${t.name}：「${SPOTS[sid].name}？我确定那儿没有。」（这个点被排除）`, 'clue');
      return;
    }
    case 'nerd':
      if (!publicAttrClue(room, t, `${t.name} 推了推眼镜：「最像藏灯的地方，我先说一点——`)) {
        logP(room, `${t.name} 把纸翻烂了，什么也说不出来。`, 'vote');
      }
      return;
    case 'flo':
      if (!publicAttrClue(room, t, `${t.name} 压低声音：「它在……`)) {
        logP(room, `${t.name} 只说了一句听不懂的中二台词。`, 'vote');
      }
      return;
    case 'gz':
      if (!publicAttrClue(room, t, `${t.name} 用方言慢悠悠地说（重复两遍）：「灯嘛——`)) {
        logP(room, `${t.name} 用方言说了半天，没人听懂。`, 'vote');
      }
      return;
    case 'dragon': {
      const others = room.players.filter(p => p.id !== t.id);
      if (!others.length) return;
      const x = pick(others);
      logP(room, `${t.name} 点指 ${x.name}：「你老实说，到这会儿你翻过哪儿了？」`, 'vote');
      const where = [...x.searched].slice(-1)[0];
      logP(room, `${x.name}：「${where ? SPOTS[where].name : '我什么都没翻'}。」`, 'vote');
      return;
    }
    case 'pig': {
      const near = nearFood(room);
      logP(room, `${t.name} 抽了抽鼻子：「灯离外卖${near ? '不' : '很'}远。」`, 'clue');
      return;
    }
    default:
      revealOneClue(room, t, true);
  }
}

function resolveVote(room) {
  if (room.phase !== 'vote') return;
  const tally = new Map();
  for (const [, target] of room.votes) tally.set(target, (tally.get(target) || 0) + 1);
  let top = null, best = -1;
  for (const [id, n] of tally) if (n > best) { best = n; top = id; }
  if (top) {
    const t = room.players.find(p => p.id === top);
    if (t) {
      logP(room, `投票结果：${t.name} 被指认（${best} 票）。`, 'vote');
      accuseClue(room, t);
      t.time = Math.min(t.time, 120);
    }
  } else {
    logP(room, '这轮没人被指认。', 'vote');
  }
  room.votes.clear();
  for (const p of room.players) p.muted = false;

  if (room.result) return finishIfNeeded(room);
  if (room.round < 3) { room.round++; startRound(room); return; }
  startOwl(room);
}

function startOwl(room) {
  room.phase = 'owl';
  room.endsAt = now() + OWL_MS;
  room.owl = { closed: [], deadline: room.endsAt, botAt: new Map() };
  for (const b of room.players.filter(p => p.isBot)) {
    room.owl.botAt.set(b.id, now() + 1200 + rnd(6000));
  }
  logP(room, '走廊的脚步声近了。所有人闭眼装睡，谁最后一个闭眼，名字就被记在本子上。', 'phase');
  broadcast(room);
}

function resolveOwl(room) {
  if (room.phase !== 'owl') return;
  const last = room.owl.closed[room.owl.closed.length - 1];
  const lp = last ? room.players.find(p => p.id === last) : null;
  if (lp) logP(room, `${lp.name} 最后一个闭眼——宿管的手电在门口停了一下。`, 'vote');
  else logP(room, '谁都没闭眼，宿管的手电扫了进来。', 'vote');
  room.owl = null;
  startPick(room);
}

function startPick(room) {
  room.phase = 'pick';
  room.endsAt = now() + PICK_MS;
  room.picks.clear();
  logP(room, `最后一次机会：每人指一个地方。只要有一人指对，全宿舍存活。`, 'phase');
  broadcast(room);
}

function resolvePick(room) {
  if (room.phase !== 'pick') return;
  for (const b of room.players.filter(p => p.isBot)) {
    if (!room.picks.has(b.id)) room.picks.set(b.id, pick(SPOT_IDS));
  }
  const hits = [];
  for (const [pid, sid] of room.picks) {
    if (sid === room.lamp) { const p = room.players.find(x => x.id === pid); if (p) hits.push(p.name); }
  }
  finish(room, hits.length > 0, { picks: hits });
}

function finish(room, win, extra = {}) {
  if (room.phase === 'end') return;
  room.phase = 'end';
  room.endsAt = 0;
  const players = room.players.map(p => ({
    id: p.id, name: p.name, role: p.role, isBot: p.isBot,
    pct: p.isBot ? Math.round(p.task.botPct) : taskPct(p),
    done: p.isBot ? p.task.botPct >= 100 : taskDone(p),
    taskText: p.role ? ROLES[p.role].task : ''
  })).sort((a, b) => b.pct - a.pct);
  const mvp = players[0] || null;
  room.result = {
    win: !!win,
    lamp: room.lamp,
    lampName: SPOTS[room.lamp].name,
    lampClue: clueKeyOfSpot(room.lamp).map(k => ATTR_TEXT[k[0]][k[1]]),
    found: room.found,
    foundBy: room.foundBy,
    hits: extra.picks || [],
    players, mvp: mvp ? mvp.name : null,
    mvpId: mvp ? mvp.id : null,
    ...extra
  };
  logP(room, win ? '灯找到了。这一夜，221 活下来了。' : '灯没找到。走廊的脚步声停在了门口。', 'phase');
  broadcast(room);
}

function finishIfNeeded(room) {
  if (room.found) finish(room, true);
}

/* ───────────────────────── 行动 ───────────────────────── */

function spend(p, cost) {
  if (p.time < cost) return false;
  p.time -= cost;
  return true;
}

function actSearch(room, p, sid) {
  if (!SPOTS[sid]) return '没有这个地方';
  if (p.searched.has(sid)) return '这里已经翻过了';
  if (!spend(p, COST.search)) return '行动预算不够了';
  p.searched.add(sid);
  if (sid === room.lamp) {
    room.found = true;
    room.foundBy = p.name;
    logP(room, `${p.name} 掀开${SPOTS[sid].name}——备用小夜灯在这里。`, 'clue');
    finish(room, true);
    return null;
  }
  const attrs = ['h', 'w', 's'].map(k => k + SPOTS[sid][k]);
  const fresh = attrs.filter(k => !p.clues.has(k));
  if (fresh.length) {
    const k = pick(fresh);
    p.clues.add(k);
    plog(p, `翻开${SPOTS[sid].name}，你摸到了：${CLUE_TEXT[k]}`);
  } else {
    plog(p, `${SPOTS[sid].name} 翻过了，没有新东西。`);
  }
  p.lastSpot = sid;
  if (sid === room.food) {
    p.task.foodFound = true;
    plog(p, `等等——这袋子还是温的。外卖藏匿点就是${SPOTS[sid].name}。`);
  }
  return null;
}

function actTalk(room, p, targetId) {
  const t = room.players.find(x => x.id === targetId);
  if (!t) return '找不到这个人';
  if (!spend(p, COST.talk)) return '行动预算不够了';
  plog(p, `你和 ${t.name} 压低声音说了几句。`);
  if (t.isBot) {
    if (Math.random() < 0.4 && t.clues.size) plog(p, `${t.name} 嘟囔了一句：${CLUE_TEXT[pick([...t.clues])]}`);
  } else if (t.clues.size && Math.random() < 0.5) {
    const k = pick([...t.clues]);
    p.clues.add(k);
    plog(p, `${t.name} 说漏了一句：${CLUE_TEXT[k]}`);
  }
  return null;
}

function actObserve(room, p, targetId) {
  const t = room.players.find(x => x.id === targetId);
  if (!t) return '找不到这个人';
  if (!spend(p, COST.observe)) return '行动预算不够了';
  plog(p, `你盯着 ${t.name} 看了一会儿：他的任务完成度约 ${t.isBot ? Math.round(t.task.botPct) : taskPct(t)}%。`);
  if (t.muted) plog(p, `${t.name} 上一轮没接龙王的令，这一轮不能投票。`);
  return null;
}

function actTask(room, p, targetId, extra) {
  const t = room.players.find(x => x.id === targetId);
  switch (p.role) {
    case 'nerd': {
      if (!t) return '要找个人问';
      if (!spend(p, COST.confess)) return '行动预算不够了';
      if (t.isBot) {
        if (Math.random() < 0.6) { p.task.admits++; plog(p, `${t.name} 支支吾吾：作业……没写完。(${p.task.admits}/3)`); }
        else plog(p, `${t.name} 嘴硬：我写完了。`);
        return null;
      }
      if (room.confess) return '现在正有人被追问';
      room.confess = { asker: p.id, target: t.id, deadline: now() + 15000 };
      plog(p, `你问 ${t.name}：作业写完了吗？`);
      return null;
    }
    case 'flo': {
      if (!t) return '要找个人传';
      if (!spend(p, COST.whisper)) return '行动预算不够了';
      if (p.task.whisperDone) return '暗号已经传出去了';
      p.task.whisperDone = true;
      plog(p, `你把暗号悄悄告诉了 ${t.name}。`);
      plog(t, `${p.name} 凑过来，对你说了句暗号：「菠萝」。`);
      return null;
    }
    case 'pig': {
      return '外卖得靠翻：三个有盖子的地方，闻一闻再搜';
    }
    default:
      return '这不是你的专属动作，用公开技能吧';
  }
}

/* ───────── 公开技能与口令（每个身份每局一次） ───────── */

function openCall(room, p, kind, label, reactText, opt = {}) {
  room.call = {
    by: p.id, kind, label, reactText,
    until: now() + (opt.ms || CALL_MS),
    reactors: [],
    mute: !!opt.mute,
    botAt: new Map()
  };
  for (const b of room.players.filter(x => x.isBot)) {
    room.call.botAt.set(b.id, now() + 900 + rnd(5200));
  }
  logP(room, label, 'phase');
  broadcast(room);
}

function settleCall(room) {
  const c = room.call;
  if (!c) return;
  const by = room.players.find(p => p.id === c.by);
  if (c.mute) {
    for (const p of room.players) {
      if (p.id === c.by || c.reactors.includes(p.id)) continue;
      if (p.isBot) continue;
      p.muted = true;
      plog(p, '你没接龙王的令——这一轮你不能投票。');
    }
    logP(room, `没接令的人，这一轮不能投票。`, 'vote');
  }
  if (by) plog(by, `口令窗口关了，${c.reactors.length} 个人应了你。`);
  room.call = null;
  broadcast(room);
}

function nearFood(room) {
  const a = SPOTS[room.lamp], b = SPOTS[room.food];
  const d = (a.h !== b.h ? 1 : 0) + (a.w !== b.w ? 1 : 0) + (a.s !== b.s ? 1 : 0);
  return d <= 1;
}

function publicAttrClue(room, p, prefix, pool) {
  const cands = (pool || ['h', 'w']).filter(a => !p.pubClues.has(a));
  if (!cands.length) return null;
  const a = pick(cands);
  p.pubClues.add(a);
  const k = a + SPOTS[room.lamp][a];
  logP(room, `${prefix}${CLUE_TEXT[k]}`, 'clue');
  return k;
}

function actSkill(room, p, arg) {
  if (!p.role) return '先挑个身份';
  if (p.task.skillUsed) return '技能一局只能用一次';
  if (room.call && room.call.until > now()) return '场上已经有一个口令了';
  const before = p.time;
  switch (p.role) {
    case 'pink': {
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      const attrs = ['h', 'w', 's'].map(a => a + SPOTS[room.lamp][a]).filter(k => !p.clues.has(k));
      if (attrs.length) {
        const k = pick(attrs);
        p.clues.add(k);
        plog(p, `闪光灯照在你头发上，反光扫过房间——你顺手看清了：${CLUE_TEXT[k]}`);
      }
      const where = p.lastSpot ? SPOTS[p.lastSpot].name : pick(SPOT_IDS.map(id => SPOTS[id].name));
      logP(room, `${p.name} 把头发撩到手机闪光灯前——整间宿舍亮了一下，所有人都看清她站在 ${where} 附近。`, 'phase');
      openCall(room, p, 'praise', `${p.name} 甩了甩头发：「亮的吧？」`, '这头发真亮');
      plog(p, `他们说一句「你头发真亮」，你的任务就往前走一格。`);
      return null;
    }
    case 'nerd': {
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      const cands = SPOT_IDS.filter(id => id !== room.lamp && !room.excluded.has(id));
      if (!cands.length) return '能划的都被划掉了';
      const sid = pick(cands);
      room.excluded.add(sid);
      logP(room, `${p.name} 借着最后一点电，在纸上划掉一个位置：${SPOTS[sid].name} 绝对不是灯。`, 'clue');
      return null;
    }
    case 'dragon': {
      const act = ['喝水', '拍桌', '抱头'].includes(arg) ? arg : '喝水';
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      openCall(room, p, 'rain', `${p.name} 一站：「龙王降雨！所有人 ${act}！」`, `龙王驾到，照做（${act}）`, { mute: true });
      plog(p, '没照做的人，这一轮不能投票。');
      return null;
    }
    case 'flo': {
      const t = room.players.find(x => x.id === arg);
      if (!t) return '要选一个室友';
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      plog(p, `你贴着 ${t.name} 的耳朵：交换一条任务提示——他的秘密任务是「${ROLES[t.role] ? ROLES[t.role].task : '还没挑身份'}」。`);
      plog(t, `${p.name} 凑到你耳边低语：他的秘密任务是「${ROLES[p.role].task}」。`);
      logP(room, `${p.name} 和 ${t.name} 凑在角落里说了好一阵悄悄话。`, 'say');
      return null;
    }
    case 'gz': {
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      const line = pick(DIALECT_LINES);
      openCall(room, p, 'dialect', `${p.name} 突然用家乡话喊了一句：「${line}」`, '学一句方言');
      plog(p, '跟着学的人越多，你越接近完成任务。');
      return null;
    }
    case 'pig': {
      if (!spend(p, COST.skill)) return '行动预算不够了';
      p.task.skillUsed = true;
      const near = nearFood(room);
      plog(p, `你抽了抽鼻子：灯离外卖${near ? '不' : '很'}远。`);
      openCall(room, p, 'hungry', `${p.name} 嗅了嗅空气：「谁饿了？我闻到点味道。」`, '饿了');
      plog(p, '说「饿了」的人凑够 3 个，你的任务就成了。');
      return null;
    }
    default:
      return '这个身份没有技能';
  }
}

function actReact(room, p) {
  const c = room.call;
  if (!c || c.until <= now()) return '口令已经过了';
  if (c.by === p.id) return '这是你自己喊的';
  if (c.reactors.includes(p.id)) return '你已经应过了';
  c.reactors.push(p.id);
  const by = room.players.find(x => x.id === c.by);
  const gain = { praise: 'praise', rain: 'followed', dialect: 'learned', hungry: 'hungry' }[c.kind];
  if (by && gain) {
    const got = bumpTask(by, gain);
    plog(by, `${p.name} 应了声「${c.reactText}」。（${got} / ${MAX_GAIN[gain] || 3}）`);
  }
  logP(room, `${p.name}：${c.reactText}`, 'say');
  return null;
}

function actChat(room, p, text) {
  const msg = cleanText(text);
  if (!msg) return '说点什么';
  if (p.msgUsed) return '这轮已经说过一句了';
  p.msgUsed = true;
  logP(room, `${p.name}：${msg}`, 'say');
  return null;
}

function actVote(room, p, targetId) {
  if (room.phase !== 'vote') return '现在不是投票时间';
  if (p.muted) return '你没接龙王的令，这一轮不能投票';
  const t = room.players.find(x => x.id === targetId && x.id !== p.id);
  if (!t) return '不能投给自己';
  p.voted = t.id;
  room.votes.set(p.id, t.id);
  return null;
}

function actCloseEyes(room, p) {
  if (room.phase !== 'owl') return '现在不用闭眼';
  if (room.owl.closed.includes(p.id)) return '已经闭上了';
  room.owl.closed.push(p.id);
  logP(room, `${p.name} 闭上了眼睛。`, 'say');
  return null;
}

function actPick(room, p, sid) {
  if (room.phase !== 'pick') return '现在不是指认时间';
  if (!SPOTS[sid]) return '没有这个地方';
  room.picks.set(p.id, sid);
  plog(p, `你指了${SPOTS[sid].name}。`);
  return null;
}

function actConfessAnswer(room, p, yes) {
  if (!room.confess || room.confess.target !== p.id) return '没有人问你';
  const asker = room.players.find(x => x.id === room.confess.asker);
  if (yes) {
    if (asker) { asker.task.admits++; plog(asker, `${p.name} 承认了：作业没写完。(${asker.task.admits}/3)`); }
    logP(room, `${p.name} 低声说：……没写完。`, 'say');
  } else {
    if (asker) plog(asker, `${p.name} 说写完了。`);
    logP(room, `${p.name} 嘴硬：写完了。`, 'say');
  }
  room.confess = null;
  return null;
}

/* ───────────────────────── 结算小游戏 ───────────────────────── */

function tickCall(room) {
  const c = room.call;
  if (!c) return;
  for (const [bid, at] of c.botAt) {
    if (at > now()) continue;
    if (c.by === bid) continue;
    if (!c.reactors.includes(bid)) {
      c.reactors.push(bid);
      const b = room.players.find(p => p.id === bid);
      const by = room.players.find(p => p.id === c.by);
      const gain = { praise: 'praise', rain: 'followed', dialect: 'learned', hungry: 'hungry' }[c.kind];
      if (b) bumpTask(by, gain);
      if (b) logP(room, `${b.name}：${c.reactText}`, 'say');
    }
  }
  if (now() >= c.until) settleCall(room);
}

function autoConfess(room) {
  if (!room.confess) return;
  if (room.confess.deadline > now()) return;
  const t = room.players.find(p => p.id === room.confess.target);
  const a = room.players.find(p => p.id === room.confess.asker);
  if (t && a) {
    if (t.isBot && Math.random() < 0.5) { a.task.admits++; logP(room, `${t.name} 磨蹭了一会儿，还是承认了。`, 'say'); }
    else logP(room, `${t.name} 没吭声。`, 'say');
  }
  room.confess = null;
}

/* ───────────────────────── 心跳 ───────────────────────── */

function tickRoom(room) {
  const t = now();
  if (room.mode === 'hunt') {
    tickHunt(room, t);
    return;
  }
  if (room.mode === 'code') {
    if (room.phase === 'code') tickCode(room, t);
    broadcast(room);
    return;
  }
  if (room.confess) autoConfess(room);
  if (room.call) tickCall(room);

  if (room.phase === 'round') {
    const hs = humans(room);
    if (hs.length && hs.every(p => p.ended) && room.endsAt - t > 1500) room.endsAt = Math.min(room.endsAt, t + 1200);
    if (t >= room.endsAt) endRound(room);
  } else if (room.phase === 'vote') {
    const all = room.players.every(p => p.voted);
    if (all && room.endsAt - t > 1200) room.endsAt = Math.min(room.endsAt, t + 1000);
    if (t >= room.endsAt) resolveVote(room);
  } else if (room.phase === 'owl') {
    for (const [bid, at] of room.owl.botAt) {
      if (at <= t && !room.owl.closed.includes(bid)) {
        room.owl.closed.push(bid);
        const b = room.players.find(p => p.id === bid);
        if (b) logP(room, `${b.name} 闭上了眼睛。`, 'say');
      }
    }
    if (t >= room.endsAt || room.owl.closed.length === room.players.length) resolveOwl(room);
  } else if (room.phase === 'pick') {
    const hs = humans(room);
    if (hs.length && hs.every(p => room.picks.has(p.id)) && room.endsAt - t > 1200) {
      room.endsAt = Math.min(room.endsAt, t + 1200);
    }
    if (t >= room.endsAt) resolvePick(room);
  }

  broadcast(room);
}

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (room.phase === 'lobby') {
      if (room.clients.size === 0 && t - room.createdAt > 20 * 60_000) rooms.delete(room.code);
      continue;
    }
    tickRoom(room);
    if (room.phase === 'end' && room.clients.size === 0) {
      room.emptySince = room.emptySince || t;
      if (t - room.emptySince > 10 * 60_000) rooms.delete(room.code);
    }
  }
}, 1000);

// 大逃杀：10Hz 推进 + 广播（移动要跟手）
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.mode !== 'hunt') continue;
    if (room.phase !== 'hunt' && room.phase !== 'suspect' && room.phase !== 'reveal') continue;
    try { tickRoom(room); broadcast(room); } catch (e) { console.error('[hunt]', e.message); }
  }
}, 100);

/* ══════════════════ 大逃杀：查寝大逃杀 ══════════════════ */

const HUNT_W = 1000, HUNT_H = 620;
const HUNT_RUN_MS = Number(process.env.D221_HUNT_MS || 90_000);
const HUNT_SUSPECT_MS = Number(process.env.D221_SUSPECT_MS || 20_000);
const HUNT_REVEAL_MS = Number(process.env.D221_REVEAL_MS2 || 8_000);
const HUNT_SPEED = 270;           // 单位/秒
const HUNT_SPEED_GHOST = 300;
const HUNT_PICK_R = 30;
const HUNT_STICKER_R = 230;

// 房间布局：走廊横穿中间，上排 5 间、下排 5 间
const HUNT_AREAS = [
  { id:'corridor', name:'走廊',   x:40,  y:268, w:920, h:96,  kind:'corridor' },
  { id:'pink',     name:'粉毛房', x:60,  y:60,  w:170, h:200, kind:'room' },
  { id:'nerd',     name:'学霸房', x:250, y:60,  w:170, h:200, kind:'room' },
  { id:'dragon',   name:'龙王房', x:440, y:60,  w:170, h:200, kind:'room' },
  { id:'laundry',  name:'洗衣房', x:630, y:60,  w:150, h:200, kind:'public' },
  { id:'boiler',   name:'开水间', x:800, y:60,  w:150, h:200, kind:'public' },
  { id:'flo',      name:'弗洛洛房', x:60, y:372, w:170, h:190, kind:'room' },
  { id:'gz',       name:'贵州房', x:250, y:372, w:170, h:190, kind:'room' },
  { id:'pig',      name:'猪房',   x:440, y:372, w:170, h:190, kind:'room' },
  { id:'food',     name:'外卖架', x:630, y:372, w:150, h:190, kind:'public' },
  { id:'panel',    name:'电闸区', x:800, y:372, w:150, h:190, kind:'public' }
];
const HUNT_TASKS = [
  { id:'board',    name:'公告栏',   role:'nerd',   x:520, y:316 },
  { id:'foodrack', name:'外卖架',   role:'pig',    x:705, y:470 },
  { id:'switch',   name:'电闸',     role:'dragon', x:875, y:470 },
  { id:'laundry',  name:'洗衣机',   role:'pink',   x:705, y:160 },
  { id:'boiler',   name:'开水机',   role:'gz',     x:875, y:160 },
  { id:'cabinet',  name:'柜墙',     role:'flo',    x:145, y:470 }
];
const HUNT_TASK_NEAR = 70;
const HUNT_TASK_STEPS = 3;
const HUNT_REPAIR_STEPS = 4;
const HUNT_SKILL = {
  pink:  { name:'反光',   cd:0, desc:'原地发光 3 秒：鬼在你附近会被照出粉色轮廓' },
  nerd:  { name:'划重点', cd:0, desc:'10 秒内全队看见所有碎片的亮点' },
  dragon:{ name:'降雨',   cd:0, desc:'把一间房变成雨区，里面的人滑倒 2 秒' },
  flo:   { name:'结界',   cd:0, desc:'放一个假人 6 秒，鬼碰到假人会暴露' },
  gz:    { name:'酸汤',   cd:0, desc:'扔一碗酸汤，半径内的人减速 3 秒' },
  pig:   { name:'嗅觉',   cd:0, desc:'3 秒内箭头指向最近的碎片和外卖' }
};

function inRect(x, y, a, pad = 0) {
  return x >= a.x - pad && x <= a.x + a.w + pad && y >= a.y - pad && y <= a.y + a.h + pad;
}
function areaAt(x, y) {
  for (const a of HUNT_AREAS) if (inRect(x, y, a, -2)) return a;
  return null;
}
function walkable(x, y) {
  return !!areaAt(x, y);
}
// 把点拉回可走区域
function clampWalk(x, y) {
  x = Math.max(20, Math.min(HUNT_W - 20, x));
  y = Math.max(30, Math.min(HUNT_H - 20, y));
  if (walkable(x, y)) return { x, y };
  let best = null, bd = 1e9;
  for (const a of HUNT_AREAS) {
    const cx = Math.max(a.x + 14, Math.min(a.x + a.w - 14, x));
    const cy = Math.max(a.y + 14, Math.min(a.y + a.h - 14, y));
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bd) { bd = d; best = { x: cx, y: cy }; }
  }
  return best || { x: HUNT_W / 2, y: HUNT_H / 2 };
}
function spawnPoint(i, n) {
  const a = HUNT_AREAS[0];
  return { x: 160 + Math.round((i / Math.max(1, n - 1)) * 660), y: a.y + 46 };
}

function huntNew(room) {
  room.hunt = {
    frags: [],               // {id,x,y,taken}
    puzzle: new Set(),       // 已拼出的碎片种类
    ghost: null,             // pid
    ghostExposedUntil: 0,
    ghostRushUntil: 0,
    lights: true,
    locked: [],             // {id,until}
    decoys: [],             // {x,y,until,by}
    zones: [],              // {x,y,r,kind,until,by}
    noises: [],             // {x,y,until,by}
    broke: 0,               // 破坏的任务点数量
    brokeIds: [],
    misRemoved: 0,
    removed: [],            // {pid,name,wasGhost,round}
    exposeNerdUntil: 0,
    scent: new Map(),       // pid -> until
    rain: null,
    brokeProgress: new Map(),
    tasks: Object.fromEntries(HUNT_TASKS.map(t => [t.id, { p: 0, done: false, broken: false, repair: 0, by: null }])),
    fixSteps: new Map(),
    lastMove: new Map()
  };
}

function huntStart(room) {
  huntNew(room);
  const ps = room.players;
  ps.forEach((p, i) => {
    const sp = spawnPoint(i, ps.length);
    p.hx = sp.x; p.hy = sp.y;
    p.alive = true;
    p.hidden = 0;
    p.stunUntil = 0;
    p.slowUntil = 0;
    p.stickerUsed = false;
    p.stickerTarget = null;
    p.huntSkillUsed = false;
    p.clues = new Set();
    p.slip = 0;
  });
  const ghost = pick(ps.map(p => p.id));
  room.hunt.ghost = ghost;
  room.phase = 'hunt';
  room.round = 1;
  room.endsAt = now() + HUNT_RUN_MS;
  room.result = null;
  huntSpawnFrags(room);
  logP(room, '灯灭了。六个人挤在走廊里，谁都不许出声。', 'phase');
  logP(room, '走廊尽头贴着一张纸：查寝期间禁止交谈、禁止串门——但没人守规矩。', 'info');
  for (const p of ps) {
    if (p.isBot) continue;
    plog(p, p.id === ghost ? '你是查寝鬼：装作室友，别被贴纸投出去。' : '你是室友：做完任务、捡碎片，把鬼贴出去。');
  }
}

function huntSpawnFrags(room) {
  const types = ['巡查表·时刻', '巡查表·楼层', '巡查表·名册', '破绽·粉色手电', '破绽·湿脚印', '破绽·敲门节奏'];
  room.hunt.frags = types.map((t, i) => {
    let pos = null;
    for (let k = 0; k < 40; k++) {
      const a = HUNT_AREAS[1 + Math.floor(Math.random() * (HUNT_AREAS.length - 1))];
      const x = a.x + 26 + Math.random() * (a.w - 52);
      const y = a.y + 26 + Math.random() * (a.h - 52);
      if (walkable(x, y)) { pos = { x, y }; break; }
    }
    pos = pos || { x: 200 + i * 100, y: 316 };
    return { i, t, x: pos.x, y: pos.y, taken: false };
  });
}

function huntSnap(room, me) {
  const h = room.hunt;
  const exposed = now() < h.ghostExposedUntil;
  const hiddenOk = me.hidden && now() < me.hidden;
  return {
    phase: room.phase,
    round: room.round,
    endsAt: room.endsAt,
    w: HUNT_W, h: HUNT_H,
    areas: HUNT_AREAS,
    tasks: HUNT_TASKS.map(t => {
      const st = h.tasks[t.id] || { p:0, done:false, broken:false };
      return { id:t.id, name:t.name, role:t.role, x:t.x, y:t.y, p: st.p, done: st.done, broken: st.broken, by: st.by, near: HUNT_TASK_NEAR };
    }),
    taskDone: Object.values(h.tasks).filter(x => x.done).length,
    myTaskId: (HUNT_TASKS.find(t => t.role === me.role) || {}).id || null,
    lights: h.lights,
    locked: h.locked.filter(l => l.until > now()).map(l => l.id),
    frags: h.frags.filter(f => !f.taken).map(f => ({ i:f.i, t:f.t, x:f.x, y:f.y })),
    decoys: h.decoys.filter(d => d.until > now()),
    zones: h.zones.filter(z => z.until > now()),
    noises: h.noises.filter(n => n.until > now()),
    puzzle: h.puzzle.size,
    broke: h.broke,
    misRemoved: h.misRemoved,
    removed: h.removed,
    isGhost: h.ghost === me.id,
    ghostExposed: exposed,
    ghostId: exposed ? h.ghost : null,
    skill: { name: (ROLES[me.role] || {}).name || '', skill: ROLES[me.role] ? ROLES[me.role].skill : '', desc: ROLES[me.role] ? HUNT_SKILL[me.role].desc : '', used: !!me.huntSkillUsed },
    showFrags: now() < h.exposeNerdUntil || now() < h.scent.get(me.id),
    me: { id: me.id, x: me.hx, y: me.hy, alive: me.alive, hidden: hiddenOk ? 1 : 0, stun: now() < me.stunUntil, slow: now() < me.slowUntil, stickerUsed: !!me.stickerUsed, clues: [...me.clues] },
    people: room.players.map(p => ({
      id: p.id, name: p.name, role: p.role, isBot: p.isBot, alive: p.alive,
      x: !p.alive ? -999 : (p.hidden && now() < p.hidden && p.id !== me.id && h.ghost !== me.id ? -888 : p.hx),
      y: !p.alive ? -999 : (p.hidden && now() < p.hidden && p.id !== me.id && h.ghost !== me.id ? -888 : p.hy),
      hidden: !!(p.hidden && now() < p.hidden),
      sticker: p.stickerTarget || null,
      ghost: exposed && p.id === h.ghost
    }))
  };
}

/* ── 动作 ── */

function huntMove(room, p, x, y) {
  if (room.phase !== 'hunt' && room.phase !== 'suspect') return { error: '现在不能跑动' };
  if (!p.alive) return { error: '你已经出局了' };
  const t = now();
  if (t < p.stunUntil) return { error: '你被绊住了' };
  const last = room.hunt.lastMove.get(p.id) || t;
  const dt = Math.min(400, Math.max(16, t - last));
  const sp = (p.id === room.hunt.ghost ? HUNT_SPEED_GHOST : HUNT_SPEED) * (t < p.slowUntil ? 0.55 : 1) * (room.phase === 'suspect' ? 0.55 : 1);
  const maxD = sp * dt / 1000 + 26;
  const dx = Number(x) - p.hx, dy = Number(y) - p.hy;
  const d = Math.hypot(dx, dy);
  let nx = Number(x), ny = Number(y);
  if (!isFinite(nx) || !isFinite(ny)) return { error: 'bad pos' };
  if (d > maxD) { const k = maxD / d; nx = p.hx + dx * k; ny = p.hy + dy * k; }
  const c = clampWalk(nx, ny);
  p.hx = c.x; p.hy = c.y;
  room.hunt.lastMove.set(p.id, t);
  return { ok: true, x: p.hx, y: p.hy };
}

function huntAct(room, p, kind, payload = {}) {
  const t = now();
  const h = room.hunt;
  if (room.phase !== 'hunt' && kind !== 'wall') return { error: '这一阶段不能动' };
  if (!p.alive) return { error: '你已经出局了' };
  const isGhost = h.ghost === p.id;

  if (kind === 'wall') {
    h.noises.push({ x: p.hx, y: p.hy, until: t + 2600, by: p.name });
    logP(room, `${p.name} 敲了敲墙。`, 'say');
    return { ok: true };
  }
  if (kind === 'light') {
    const near = HUNT_TASKS.some(k => Math.hypot(k.x - p.hx, k.y - p.hy) < 90);
    if (!near) return { error: '离电闸太远了' };
    h.lights = !h.lights;
    logP(room, h.lights ? '有人把灯打开了。' : '有人拉下了电闸。', 'phase');
    return { ok: true, lights: h.lights };
  }
  if (kind === 'hide') {
    p.hidden = t + 6000;
    return { ok: true };
  }
  if (kind === 'throw') {
    if (t < p.slowUntil) return { error: '你还没站稳' };
    let target = null, bd = 1e9;
    for (const o of room.players) {
      if (o.id === p.id || !o.alive) continue;
      const d = Math.hypot(o.hx - p.hx, o.hy - p.hy);
      if (d < 240 && d < bd) { bd = d; target = o; }
    }
    if (!target) return { error: '附近没人，拖鞋扔空了' };
    target.stunUntil = t + 2000;
    logP(room, `${p.name} 扔了一只拖鞋，砸中了 ${target.name}。`, 'say');
    return { ok: true, target: target.name };
  }
  if (kind === 'task') {
    const task = HUNT_TASKS.find(k => Math.hypot(k.x - p.hx, k.y - p.hy) < HUNT_TASK_NEAR);
    if (!task) return { error: '离任务点太远了' };
    const st = h.tasks[task.id];
    if (st.broken) return { error: `${task.name} 被弄坏了，先修好（按「修理」）` };
    if (st.done) return { error: '这个任务已经做完了' };
    st.p += 1;
    if (st.p >= HUNT_TASK_STEPS) {
      st.done = true;
      st.p = HUNT_TASK_STEPS;
      st.by = p.name;
      if (task.role === p.role) plog(p, `${task.name} 做完了——这是你的本职任务。`);
      logP(room, `${p.name} 做完了 ${task.name}（全队任务 ${Object.values(h.tasks).filter(x => x.done).length} / 6）。`, 'info');
      const doneCount = Object.values(h.tasks).filter(x => x.done).length;
      if (doneCount % 2 === 0) {
        const f = h.frags.find(x => !x.taken);
        if (f) {
          f.taken = true;
          if (!h.puzzle.has(f.i)) h.puzzle.add(f.i);
          logP(room, `两项任务换回一块碎片（拼图 ${h.puzzle.size} / 6）。`, 'phase');
        }
      }
    } else {
      plog(p, `${task.name} 进度 ${st.p} / ${HUNT_TASK_STEPS}`);
    }
    return { ok: true, progress: st.p, done: st.done };
  }
  if (kind === 'repair') {
    const task = HUNT_TASKS.find(k => Math.hypot(k.x - p.hx, k.y - p.hy) < HUNT_TASK_NEAR && h.tasks[k.id].broken);
    if (!task) return { error: '这里没有坏掉的任务点' };
    const st = h.tasks[task.id];
    st.repair += 1;
    if (st.repair >= HUNT_REPAIR_STEPS) {
      st.repair = 0;
      st.broken = false;
      st.p = 0;
      h.brokeIds = h.brokeIds.filter(x => x !== task.id);
      h.broke = h.brokeIds.length;
      logP(room, `${p.name} 把 ${task.name} 修好了（还在坏的：${h.broke} / 3）。`, 'phase');
    } else {
      plog(p, `修理 ${task.name}… ${st.repair} / ${HUNT_REPAIR_STEPS}`);
    }
    return { ok: true, repair: st.repair };
  }
  if (kind === 'skill') {
    if (p.huntSkillUsed) return { error: '技能一局只能用一次' };
    p.huntSkillUsed = true;
    const role = p.role;
    if (role === 'pink') {
      h.ghostExposedUntil = t + 3000;
      logP(room, `${p.name} 的头发亮了起来——附近的影子被照出了粉色轮廓。`, 'phase');
    } else if (role === 'nerd') {
      h.exposeNerdUntil = t + 10000;
      logP(room, `${p.name} 在地图上划出了重点：碎片位置全队可见，10 秒。`, 'phase');
    } else if (role === 'dragon') {
      const a = areaAt(p.hx, p.hy);
      h.zones.push({ x: p.hx, y: p.hy, r: 190, kind: 'rain', until: t + 6000, by: p.name });
      for (const o of room.players) {
        if (!o.alive) continue;
        if (Math.hypot(o.hx - p.hx, o.hy - p.hy) < 190) o.stunUntil = Math.max(o.stunUntil, t + 2000);
      }
      logP(room, `${p.name} 在${a ? a.name : '走廊'}里下起了雨，周围的人全滑倒了。`, 'phase');
    } else if (role === 'flo') {
      h.decoys.push({ x: p.hx, y: p.hy, until: t + 6000, by: p.name, id: p.id });
      logP(room, `${p.name} 摆了一个假人。`, 'phase');
    } else if (role === 'gz') {
      h.zones.push({ x: p.hx, y: p.hy, r: 150, kind: 'soup', until: t + 5000, by: p.name });
      for (const o of room.players) {
        if (!o.alive) continue;
        if (Math.hypot(o.hx - p.hx, o.hy - p.hy) < 150) o.slowUntil = Math.max(o.slowUntil, t + 3000);
      }
      logP(room, `${p.name} 甩出一碗酸汤，味道让人走不动。`, 'phase');
    } else if (role === 'pig') {
      h.scent.set(p.id, t + 6000);
      for (const o of room.players) if (!o.isBot) h.scent.set(o.id, t + 3000);
      logP(room, `${p.name} 嗅了嗅空气，指明了碎片和外卖的方向。`, 'phase');
    }
    return { ok: true };
  }
  if (isGhost) {
    if (kind === 'dark') {
      h.lights = false;
      logP(room, '走廊的灯突然灭了。', 'phase');
      return { ok: true };
    }
    if (kind === 'rush') {
      h.ghostRushUntil = t + 3000;
      return { ok: true };
    }
    if (kind === 'lock') {
      const a = areaAt(p.hx, p.hy);
      if (!a) return { error: '得站在门口' };
      h.locked.push({ id: a.id, until: t + 12000 });
      logP(room, `${a.name}的门被锁上了。`, 'phase');
      return { ok: true };
    }
    if (kind === 'break') {
      const task = HUNT_TASKS.find(k => Math.hypot(k.x - p.hx, k.y - p.hy) < 80 && !h.tasks[k.id].broken);
      if (!task) return { error: '这里没有能破坏的东西' };
      const st = h.tasks[task.id];
      if (t - (st.lastBreak || 0) < 1200) return { error: '手还没稳住，等一下' };
      st.lastBreak = t;
      const prog = (h.brokeProgress.get(task.id) || 0) + 1;
      h.brokeProgress.set(task.id, prog);
      if (prog >= 4) {
        h.brokeProgress.set(task.id, 0);
        st.broken = true;
        st.done = false;
        st.p = 0;
        st.by = null;
        if (!h.brokeIds.includes(task.id)) h.brokeIds.push(task.id);
        h.broke = h.brokeIds.length;
        logP(room, `${task.name} 被弄坏了（${h.broke} / 3）。`, 'phase');
        if (h.broke >= 3) huntFinish(room, 'ghost', '三个任务点全被破坏，宿管直接记了整层楼');
      } else {
        plog(p, `正在破坏 ${task.name}… ${prog} / 4`);
      }
      return { ok: true, progress: prog };
    }
  }
  return { error: '这个动作现在用不了' };
}

function huntSticker(room, p, targetId) {
  if (room.phase !== 'suspect') return { error: '还没到贴纸阶段' };
  if (!p.alive) return { error: '你已经出局了' };
  if (p.stickerUsed) return { error: '这一轮你已经贴过一张了' };
  const t = room.players.find(x => x.id === targetId);
  if (!t || !t.alive) return { error: '找不到这个人' };
  if (t.id === p.id) return { error: '不能贴自己' };
  if (Math.hypot(t.hx - p.hx, t.hy - p.hy) > HUNT_STICKER_R) return { error: '离得太远了，得走到他面前' };
  p.stickerUsed = true;
  p.stickerTarget = t.id;
  room.votes.set(p.id, t.id);
  logP(room, `${p.name} 在 ${t.name} 额头上贴了一张「?」贴纸。`, 'say');
  return { ok: true };
}

/* ── 阶段 ── */

function huntPhaseHunt(room, t) {
  const h = room.hunt;
  // 拾取碎片
  for (const p of room.players) {
    if (!p.alive) continue;
    for (const f of h.frags) {
      if (f.taken) continue;
      if (Math.hypot(f.x - p.hx, f.y - p.hy) < HUNT_PICK_R) {
        f.taken = true;
        if (!h.puzzle.has(f.i)) {
          h.puzzle.add(f.i);
          logP(room, `${p.name} 捡到一块碎片（拼图 ${h.puzzle.size} / 6）。`, 'info');
        }
        p.clues.add(f.t);
      }
    }
    // 鬼撞假人
    if (p.id === h.ghost) {
      for (const d of h.decoys) {
        if (d.until > t && Math.hypot(d.x - p.hx, d.y - p.hy) < 34) {
          h.ghostExposedUntil = t + 3000;
          logP(room, '鬼撞上了假人，轮廓暴露了 3 秒。', 'phase');
        }
      }
    }
  }
  // 拼图完成
  if (h.puzzle.size >= 6 && !h.puzzleDone) {
    h.puzzleDone = true;
    h.ghostExposedUntil = t + 3000;
    logP(room, '巡查表拼完整了：宿管五分钟后到，鬼的轮廓暴露 3 秒。', 'phase');
  }
  // 机器人
  for (const p of room.players) {
    if (!p.isBot || !p.alive) continue;
    huntBot(room, p, t);
  }
}

function huntBot(room, p, t) {
  const h = room.hunt;
  const isGhost = h.ghost === p.id;
  if (t < p.stunUntil) return;
  p.botTarget = p.botTarget || null;
  if (!p.botTarget || Math.hypot(p.botTarget.x - p.hx, p.botTarget.y - p.hy) < 26) {
    if (isGhost) {
      const task = HUNT_TASKS.find(k => !h.brokeIds.includes(k.id));
      p.botTarget = task ? { x: task.x, y: task.y } : { x: 500, y: 316 };
    } else {
      const f = h.frags.filter(x => !x.taken);
      p.botTarget = f.length ? { x: f[0].x, y: f[0].y } : { x: 200 + Math.random() * 600, y: 300 };
    }
  }
  const dx = p.botTarget.x - p.hx, dy = p.botTarget.y - p.hy;
  const d = Math.hypot(dx, dy) || 1;
  const sp = (isGhost ? HUNT_SPEED_GHOST : HUNT_SPEED) * 0.62;
  const step = sp * 0.12;
  const c = clampWalk(p.hx + dx / d * step, p.hy + dy / d * step);
  p.hx = c.x; p.hy = c.y;
  if (isGhost && Math.hypot(p.botTarget.x - p.hx, p.botTarget.y - p.hy) < 70 && Math.random() < 0.2) {
    huntAct(room, p, 'break');
  }
}

function huntResolve(room, t) {
  const h = room.hunt;
  const tally = new Map();
  for (const [, target] of room.votes) tally.set(target, (tally.get(target) || 0) + 1);
  let top = 0, winners = [];
  for (const [id, n] of tally) {
    if (n > top) { top = n; winners = [id]; }
    else if (n === top) winners.push(id);
  }
  if (top === 0) {
    logP(room, '没人贴纸。这一轮就这么过去了。', 'phase');
    return { removed: null, tie: true };
  }
  if (winners.length > 1) {
    logP(room, `平票（${winners.map(id => (room.players.find(p => p.id === id) || {}).name).join('、')}），宿管懒得管，这一轮没人被带走。`, 'phase');
    return { removed: null, tie: true };
  }
  const p = room.players.find(x => x.id === winners[0]);
  if (!p) return { removed: null, tie: true };
  p.alive = false;
  const wasGhost = h.ghost === p.id;
  h.removed.push({ id: p.id, name: p.name, wasGhost, round: room.round });
  logP(room, `${p.name} 被贴纸贴到最多票，宿管把人带走了——他是${wasGhost ? '查寝鬼' : '室友'}。`, 'phase');
  if (!wasGhost) h.misRemoved++;
  return { removed: { id: p.id, name: p.name, wasGhost }, tie: false };
}

function huntFinish(room, who, why) {
  room.phase = 'end';
  room.result = {
    mode: 'hunt',
    win: who === 'room',
    ghostId: room.hunt.ghost,
    ghostName: (room.players.find(p => p.id === room.hunt.ghost) || {}).name || '',
    rounds: room.round,
    broke: room.hunt.broke,
    misRemoved: room.hunt.misRemoved,
    puzzle: room.hunt.puzzle.size,
    why,
    rows: room.players.map(p => ({
      id: p.id, name: p.name, role: p.role, roleName: (ROLES[p.role] || {}).name || '', isBot: p.isBot,
      ghost: p.id === room.hunt.ghost, alive: p.alive, clues: p.clues.size
    }))
  };
  logP(room, why, 'phase');
}

function huntNextRound(room) {
  const h = room.hunt;
  room.round += 1;
  room.votes.clear();
  for (const p of room.players) { p.stickerUsed = false; p.stickerTarget = null; }
  huntSpawnFrags(room);
  h.locked = [];
  h.ghostRushUntil = 0;
  room.phase = 'hunt';
  room.endsAt = now() + HUNT_RUN_MS;
  logP(room, `第 ${room.round} 轮开始，还剩 ${room.players.filter(p => p.alive).length} 个人。`, 'phase');
}

function tickHunt(room, t) {
  const h = room.hunt;
  if (!h) return;
  if (room.phase === 'hunt') {
    huntPhaseHunt(room, t);
    if (t >= room.endsAt) {
      room.phase = 'suspect';
      room.endsAt = t + HUNT_SUSPECT_MS;
      room.votes.clear();
      for (const p of room.players) { p.stickerUsed = false; p.stickerTarget = null; }
      logP(room, '跑图结束，开始贴纸。走到你想怀疑的人面前，贴一张。', 'phase');
    }
  } else if (room.phase === 'suspect') {
    for (const p of room.players) {
      if (p.isBot && p.alive && !p.stickerUsed && Math.random() < 0.25) {
        const pool = room.players.filter(x => x.alive && x.id !== p.id);
        const target = pool[Math.floor(Math.random() * pool.length)];
        if (target) huntSticker(room, p, target.id);
      }
    }
    const aliveHumans = room.players.filter(p => p.alive && !p.isBot);
    const allVoted = aliveHumans.length > 0 && aliveHumans.every(p => p.stickerUsed);
    if (t >= room.endsAt || (allVoted && room.endsAt - t > 900)) {
      const res = huntResolve(room, t);
      room.hunt.lastResolve = res;
      room.phase = 'reveal';
      room.endsAt = t + HUNT_REVEAL_MS;
      if (res.removed && res.removed.wasGhost) {
        huntFinish(room, 'room', '查寝鬼被贴纸投了出去，室友赢了。');
      } else if (room.hunt.misRemoved >= 2) {
        huntFinish(room, 'ghost', '误投了两个自己人，鬼赢了。');
      }
    }
  } else if (room.phase === 'reveal') {
    if (t >= room.endsAt) {
      if (room.round >= 3) {
        huntFinish(room, 'ghost', '三轮过去鬼还没被找出来，鬼赢了。');
      } else {
        huntNextRound(room);
      }
    }
  }
}

/* ───────────────────────── 暗号版：查寝塔防 ───────────────────────── */

const CODE_BRIEF_MS = Number(process.env.D221_BRIEF_MS || 6_000);
const CODE_CHOOSE_MS = Number(process.env.D221_CHOOSE_MS || 25_000);
const CODE_REVEAL_MS = Number(process.env.D221_REVEAL_MS || 9_000);

const THREATS = ['无', '小', '中', '大'];          // 下标越大越危险
const DOORS = ['倒塌', '破损', '受损', '完好'];     // 下标越大越完好

const ACH = {
  pink_chaos:       '错乱里的清醒 · 在暗号错乱的一波里答对',
  nerd_streak:      '连中两元 · 连续两波答对',
  dragon_broadcast: '龙王预报 · 广播的第三位是真的',
  flo_intel:        '情报贩子 · 靠队友的碎片答对',
  gz_alone:         '独醒 · 全队只有你答对',
  pig_pure:         '纯推理 · 破解成功且这波没用技能'
};

// 每波 6 条碎片：至少 2 条单独没用，至少 1 条接近完整，合起来唯一
const WAVES = [
  {
    ghost: '夜巡宿管', code: '查寝夜巡', threat: 1,
    frags: [
      { t: '暗号是四字词，四个字都跟今晚的事有关。', c: [] },
      { t: '第一位是「查」。', c: ['查'] },
      { t: '第三位是「夜」。', c: ['夜'] },
      { t: '第二位不是「管」。', c: ['管'] },
      { t: '暗号后两个字是「夜巡」。', c: ['夜', '巡'] },
      { t: '暗号里有「寝」字。', c: ['寝'] }
    ]
  },
  {
    ghost: '跳闸黑影', code: '断电查鬼', threat: 2,
    frags: [
      { t: '暗号四个字都和这次停电有关。', c: [] },
      { t: '第一位是「断」。', c: ['断'] },
      { t: '第二位是「电」。', c: ['电'] },
      { t: '第三位不是「鬼」。', c: ['鬼'] },
      { t: '暗号前两个字是一个词，后两个字是「查鬼」。', c: ['查', '鬼'] },
      { t: '暗号里有「断」，也有「鬼」。', c: ['断', '鬼'] }
    ]
  },
  {
    ghost: '偷外卖的手', code: '外卖被偷', threat: 2,
    frags: [
      { t: '暗号四个字，都是今晚可能发生的事。', c: [] },
      { t: '第一位是「外」。', c: ['外'] },
      { t: '第三位是「被」。', c: ['被'] },
      { t: '最后一位不是「吃」。', c: ['吃'] },
      { t: '暗号里有「偷」，在最后一位。', c: ['偷'] },
      { t: '暗号里没有「鬼」字。', c: ['鬼'] }
    ]
  },
  {
    ghost: '查寝加强版', code: '熬夜被抓', threat: 3,
    frags: [
      { t: '这波暗号跟作息有关。', c: [] },
      { t: '第一位是「熬」。', c: ['熬'] },
      { t: '第三位是「被」。', c: ['被'] },
      { t: '第二位不是「夜」。', c: ['夜'] },
      { t: '暗号最后两个字是「被抓」。', c: ['被', '抓'] },
      { t: '暗号里有一个字是「夜」。', c: ['夜'] }
    ]
  },
  {
    ghost: '终极宿管', code: '宿管来了', threat: 3,
    frags: [
      { t: '暗号是今晚最不想听到的一句话。', c: [] },
      { t: '第一位是「宿」。', c: ['宿'] },
      { t: '第二位是「管」。', c: ['管'] },
      { t: '第三位是「来」。', c: ['来'] },
      { t: '最后一位是「了」。', c: ['了'] },
      { t: '暗号里没有「鬼」字。', c: ['鬼'] }
    ]
  }
];

const CODE_CHARS = [...new Set(WAVES.flatMap(w => [...w.code]))];  // 输入用的候选字

function startCodeGame(room) {
  room.phase = 'code';
  room.round = 1;
  room.feed.length = 0;
  room.result = null;
  room.cd = {
    wave: 0, phase: 'brief', threatIdx: 1, doorIdx: 3,
    frags: new Map(), picks: new Map(), notes: new Map(),
    reveal: null, verdict: null, waveLog: []
  };
  for (const p of room.players) {
    p.ach = [];
    p.codeCorrect = 0;
    p.streak = 0;
    p.task.skillUsed = false;
    p.privateLog.length = 0;
  }
  logP(room, '宿管上楼了。门还完好，但每一波都会更凶。', 'phase');
  startWave(room, 1);
}

function startWave(room, n) {
  const w = WAVES[n - 1];
  room.cd.wave = n;
  room.cd.phase = 'brief';
  room.cd.picks.clear();
  room.cd.notes.clear();
  room.cd.reveal = null;
  room.cd.verdict = null;
  room.cd.threatIdx = clamp(w.threat, 0, THREATS.length - 1);
  room.round = n;
  room.endsAt = now() + CODE_BRIEF_MS;

  // 碎片打乱后发给每个人（每人只拿一条）
  const order = WAVES[n - 1].frags.map((f, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const ps = room.players.slice();
  for (let i = ps.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [ps[i], ps[j]] = [ps[j], ps[i]];
  }
  room.cd.frags.clear();
  ps.forEach((p, i) => {
    const f = w.frags[order[i % order.length]];
    room.cd.frags.set(p.id, f);
    p.privateLog.length = 0;
    p.botAt = 0;
  });
  for (const b of room.players.filter(p => p.isBot)) {
    b.botAt = now() + 1200 + rnd(Math.max(1200, CODE_CHOOSE_MS - 4000));
  }
  logP(room, `第 ${n} 波 · 鬼叫「${w.ghost}」，威胁「${THREATS[room.cd.threatIdx]}」。`, 'phase');
}

function beginChoose(room) {
  room.cd.phase = 'choose';
  room.endsAt = now() + CODE_CHOOSE_MS;
  logP(room, '暗号碎片已经发到每个人手机上。25 秒，同时交答案。', 'phase');
}

function codeSubmit(room, p, body) {
  const cd = room.cd;
  if (!cd) return '现在不是暗号波';
  if (cd.phase !== 'choose') return cd.phase === 'brief' ? '先看碎片' : '这一波已经结算了';
  if (cd.picks.has(p.id)) return '你已经交过了，不能改';

  const useSkill = !!body.skill;
  if (useSkill && p.task.skillUsed) return '技能这局已经用过了';

  const guess = String(body.guess == null ? '' : body.guess).replace(/[\s·,，。]/g, '').slice(0, 4);
  cd.picks.set(p.id, { skill: useSkill, guess, at: now() });

  if (useSkill) {
    p.task.skillUsed = true;
    codeSkill(room, p);
  }
  const hs = humans(room);
  if (hs.length && hs.every(x => cd.picks.has(x.id))) room.endsAt = Math.min(room.endsAt, now() + 900);
  return null;
}

function codeSkill(room, p) {
  const w = WAVES[room.cd.wave - 1];
  const code = w.code;
  const frag = room.cd.frags.get(p.id) || { t: '', c: [] };
  const notes = room.cd.notes.get(p.id) || [];
  const push = (s) => { notes.push(s); room.cd.notes.set(p.id, notes); plog(p, s); };

  switch (p.role) {
    case 'pink': {
      const missing = [...code].filter(ch => !frag.c.includes(ch));
      push(missing.length
        ? `粉毛反光：暗号里有一整个字你的碎片没提到——「${missing[0]}」。`
        : '粉毛反光：你的碎片已经把四个字全盖住了。');
      break;
    }
    case 'nerd':
      push(`重点划圈：第二位是「${code[1]}」。`);
      break;
    case 'dragon':
      push(`龙王降雨：第三位是「${code[2]}」。`);
      logP(room, `龙王广播：「我算出来了，第三位是『${code[2]}』。」`, 'say');
      break;
    case 'gz':
      push(`方言加密：第四位是「${code[3]}」。`);
      break;
    case 'flo': {
      const others = room.players.filter(x => x.id !== p.id);
      const target = others.length ? pick(others) : null;
      if (target) {
        const tf = room.cd.frags.get(target.id) || { t: '（什么都没有）' };
        push(`悄悄话结界：${target.name} 的碎片是「${tf.t}」`);
      }
      break;
    }
    case 'pig': {
      const off = frag.c.find(ch => ![...code].includes(ch));
      push(off
        ? `吃货嗅觉：你碎片里的「${off}」不在暗号里。`
        : '吃货嗅觉：你碎片里的字，全都在暗号里。');
      break;
    }
    default:
      push('你的技能没有可以广播的信息。');
  }
}

function resolveWave(room) {
  const cd = room.cd;
  const w = WAVES[cd.wave - 1];
  const players = room.players.slice();

  // 没交的按「保留 + 空答案」处理
  for (const p of players) {
    if (!cd.picks.has(p.id)) cd.picks.set(p.id, { skill: false, guess: '', at: now() });
  }

  const rows = players.map(p => {
    const pickv = cd.picks.get(p.id);
    return {
      id: p.id, name: p.name, role: p.role, roleName: p.role ? ROLES[p.role].name : '',
      isBot: p.isBot, skill: !!pickv.skill,
      correct: pickv.guess === w.code
    };
  });

  const correctCount = rows.filter(r => r.correct).length;
  const skillCount = rows.filter(r => r.skill).length;
  const step = { break: [1, 1], none: [0, 0], chaos: [-1, -1] }[
    correctCount >= 4 ? 'break' : correctCount === 3 ? 'none' : 'chaos'
  ];
  const kind = correctCount >= 4 ? 'break' : correctCount === 3 ? 'none' : 'chaos';

  // 先算暗号，再算技能减伤
  cd.threatIdx = clamp(cd.threatIdx - step[0], 0, THREATS.length - 1);
  cd.doorIdx = clamp(cd.doorIdx + step[1], 0, DOORS.length - 1);
  let overflow = 0;
  for (let i = 0; i < skillCount; i++) {
    if (cd.threatIdx > 0) cd.threatIdx--;
    else overflow++;
  }
  cd.doorIdx = clamp(cd.doorIdx + overflow, 0, DOORS.length - 1);

  // 成绩与成就
  for (const r of rows) {
    const p = players.find(x => x.id === r.id);
    if (!p) continue;
    if (r.correct) { p.codeCorrect++; p.streak++; } else p.streak = 0;
    if (r.correct && kind === 'chaos' && p.role === 'pink') award(p, 'pink_chaos');
    if (p.streak >= 2) award(p, 'nerd_streak');
    if (r.skill && p.role === 'dragon') award(p, 'dragon_broadcast');
    if (r.correct && p.role === 'flo' && r.skill) award(p, 'flo_intel');
    if (r.correct && kind === 'break' && p.role === 'pig' && !r.skill) award(p, 'pig_pure');
  }
  const correctOnes = rows.filter(r => r.correct);
  if (correctOnes.length === 1) {
    const only = players.find(x => x.id === correctOnes[0].id);
    if (only) award(only, 'gz_alone');
  }

  const skillNote = skillCount
    ? ` ${skillCount} 个人用了技能，再抵掉 ${skillCount} 档` + (overflow ? `（多出来的 ${overflow} 档转成门回复）` : '') + '。'
    : '没人用技能。';
  const verdictText = (kind === 'break'
    ? `暗号破解成功（${correctCount} / 6 对）。威胁降一档。`
    : kind === 'none'
      ? `暗号对上了但不够数（${correctCount} / 6 对）。这一波照常算。`
      : `暗号错乱（只有 ${correctCount} / 6 对）。威胁升一档，门被撞了一下。`) + skillNote;

  cd.reveal = { wave: cd.wave, code: w.code, kind, correctCount, rows };
  cd.verdict = { kind, text: verdictText, threat: THREATS[cd.threatIdx], door: DOORS[cd.doorIdx] };
  cd.waveLog.push({ wave: cd.wave, kind, correctCount, threat: THREATS[cd.threatIdx], door: DOORS[cd.doorIdx] });
  cd.phase = 'reveal';
  room.endsAt = now() + CODE_REVEAL_MS;
  logP(room, verdictText, kind === 'break' ? 'good' : kind === 'chaos' ? 'bad' : 'info');
  if (kind === 'chaos' && cd.doorIdx === 0) logP(room, '门被撞塌了。', 'bad');
}

function award(p, id) {
  if (!p.ach) p.ach = [];
  if (p.ach.includes(id)) return;
  p.ach.push(id);
  plog(p, `解锁成就：${ACH[id]}`);
}

function nextWaveOrEnd(room) {
  const cd = room.cd;
  if (cd.doorIdx <= 0) return finishCode(room, false, '门被撞塌了');
  if (cd.wave >= WAVES.length) return finishCode(room, true, '五波都撑过去了');
  startWave(room, cd.wave + 1);
}

function finishCode(room, win, reason) {
  if (room.phase === 'end') return;
  room.phase = 'end';
  room.endsAt = 0;
  const players = room.players.map(p => ({
    id: p.id, name: p.name, role: p.role, roleName: p.role ? ROLES[p.role].name : '',
    isBot: p.isBot, correct: p.codeCorrect || 0,
    ach: (p.ach || []).map(id => ({ id, name: ACH[id] }))
  })).sort((a, b) => (b.ach.length - a.ach.length) || (b.correct - a.correct));
  const mvp = players[0] || null;
  room.result = {
    mode: 'code', win: !!win, reason,
    waves: room.cd.wave, door: DOORS[room.cd.doorIdx], threat: THREATS[room.cd.threatIdx],
    log: room.cd.waveLog, players,
    mvp: mvp ? mvp.name : null, mvpId: mvp ? mvp.id : null
  };
  logP(room, win ? '天亮了。宿管骂骂咧咧地下楼了。' : '门倒了。明早的通报上有你们六个的名字。', 'phase');
  broadcast(room);
}

function tickCode(room, t) {
  const cd = room.cd;
  if (!cd) return;
  if (cd.phase === 'brief') {
    if (t >= room.endsAt) beginChoose(room);
    return;
  }
  if (cd.phase === 'choose') {
    for (const b of room.players.filter(p => p.isBot && !cd.picks.has(p.id))) {
      if (b.botAt && t >= b.botAt) {
        const frag = cd.frags.get(b.id) || { c: [] };
        const code = WAVES[cd.wave - 1].code;
        const cover = frag.c.filter(ch => [...code].includes(ch)).length;
        const skill = !b.task.skillUsed && Math.random() < 0.45;
        const right = Math.random() < clamp(0.16 + cover * 0.17, 0.16, 0.82);
        codeSubmit(room, b, { skill, guess: right ? code : '不知道' });
      }
    }
    if (t >= room.endsAt) resolveWave(room);
    return;
  }
  if (cd.phase === 'reveal') {
    if (t >= room.endsAt) nextWaveOrEnd(room);
  }
}

/* ───────────────────────── HTTP ───────────────────────── */

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 8192) req.destroy(); });
  req.on('end', () => {
    try { cb(JSON.parse(data || '{}')); } catch (_) { cb({}); }
  });
}

function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase().trim());
}

const ACTIONS = {
  create(body) {
    const room = makeRoom(body.name, body.mode);
    return { ok: true, code: room.code, pid: room.hostId };
  },
  join(body) {
    const room = findRoom(body.code);
    if (!room) return { error: '房间不存在' };
    if (room.phase !== 'lobby') return { error: '这一局已经开始了' };
    if (roomFull(room)) return { error: '房间满了' };
    const p = makePlayer(body.name || '室友', false);
    room.players.push(p);
    broadcast(room);
    return { ok: true, code: room.code, pid: p.id };
  },
  resume(body) {
    const room = findRoom(body.code);
    if (!room) return { error: '房间不存在' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '这个座位不在了' };
    if (p.isBot) return { error: '这个座位已经交给 NPC 了' };
    return { ok: true, code: room.code, pid: p.id };
  },
  leave(body) {
    const room = findRoom(body.code);
    if (!room) return { ok: true };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { ok: true };
    const res = room.clients.get(p.id);
    if (res) { try { res.end(); } catch (_) {} room.clients.delete(p.id); }

    if (room.phase === 'lobby') {
      room.players = room.players.filter(x => x.id !== p.id);
      if (room.hostId === p.id) {
        const next = room.players.find(x => !x.isBot);
        room.hostId = next ? next.id : null;
      }
      if (!room.players.some(x => !x.isBot)) { rooms.delete(room.code); return { ok: true, closed: true }; }
      logP(room, `${p.name} 离开了房间。`, 'say');
      broadcast(room);
      return { ok: true };
    }

    // 已经开局：座位交给 NPC，别让这一局卡住
    p.isBot = true;
    p.online = false;
    logP(room, `${p.name} 掉线了，位置交给 NPC。`, 'say');
    broadcast(room);
    return { ok: true };
  },
  state(body) {
    const room = findRoom(body.code);
    if (!room) return { error: '房间不存在' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '不在房间里' };
    return snap(room, p);
  },
  role(body) {
    const room = findRoom(body.code);
    if (!room || room.phase !== 'lobby') return { error: '现在不能选身份' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '不在房间里' };
    if (!ROLE_IDS.includes(body.role)) return { error: '没有这个身份' };
    if (room.players.some(x => x.id !== p.id && x.role === body.role)) return { error: '这个身份被占了' };
    p.role = body.role;
    broadcast(room);
    return { ok: true };
  },
  start(body) {
    const room = findRoom(body.code);
    if (!room || room.phase !== 'lobby') return { error: '现在不能开始' };
    if (room.hostId !== body.pid) return { error: '只有房主能开局' };
    const hs = humans(room);
    if (hs.length < 2) return { error: '至少 2 个人' };
    if (hs.some(p => !p.role)) return { error: '还有人没挑身份' };
    fillBots(room);
    room.round = 1;
    room.lamp = pick(SPOT_IDS);
    room.food = pick(FOOD_IDS);
    room.feed.length = 0;
    room.found = false;
    room.result = null;
    for (const p of room.players) { p.clues.clear(); p.searched.clear(); p.privateLog.length = 0; }
    if (room.mode === 'code') {
      logP(room, '宿舍楼安静下来了，只有查寝的脚步一层层往上。', 'phase');
      startCodeGame(room);
      broadcast(room);
      return { ok: true };
    }

    if (room.mode === 'hunt') {
      huntStart(room);
      broadcast(room);
      return { ok: true };
    }
    logP(room, '断电了。楼道里传来别的宿舍的骂声，然后是脚步声。', 'phase');
    startRound(room);
    return { ok: true };
  },
  act(body) {
    const room = findRoom(body.code);
    if (!room || room.phase !== 'round') return { error: '现在不能行动' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '不在房间里' };
    if (p.ended) return { error: '你已经结束本轮了' };
    let err = null;
    if (body.kind === 'search') err = actSearch(room, p, body.spot);
    else if (body.kind === 'talk') err = actTalk(room, p, body.target);
    else if (body.kind === 'observe') err = actObserve(room, p, body.target);
    else if (body.kind === 'task') err = actTask(room, p, body.target, body);
    else return { error: '未知动作' };
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  chat(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    if (room.phase !== 'round') return { error: '现在不是说话的时候' };
    const err = actChat(room, p, body.text);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  endRound(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    if (room.phase !== 'round') return { error: '现在不是行动时间' };
    p.ended = true;
    logP(room, `${p.name} 停手了。`, 'say');
    broadcast(room);
    return { ok: true };
  },
  vote(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    const err = actVote(room, p, body.target);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  eyes(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    const err = actCloseEyes(room, p);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  pick(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    const err = actPick(room, p, body.spot);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  skill(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    if (room.phase !== 'round') return { error: '现在不能放技能' };
    if (p.ended) return { error: '你这轮已经收手了' };
    const err = actSkill(room, p, body.arg);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  code(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    if (room.mode !== 'code') return { error: '这不是暗号版' };
    if (room.phase !== 'code') return { error: '这一局已经结束了' };
    const err = codeSubmit(room, p, body);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  react(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    const err = actReact(room, p);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  confess(body) {
    const room = findRoom(body.code);
    const p = room && room.players.find(x => x.id === body.pid);
    if (!room || !p) return { error: '不在房间里' };
    const err = actConfessAnswer(room, p, !!body.yes);
    if (err) return { error: err };
    broadcast(room);
    return { ok: true };
  },
  hunt(body) {
    const room = findRoom(body.code);
    if (!room || room.mode !== 'hunt' || !room.hunt) return { error: '这不是大逃杀的房间' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '不在房间里' };
    const kind = String(body.kind || '');
    if (kind === 'move') {
      const r = huntMove(room, p, Number(body.x), Number(body.y));
      broadcast(room);
      return r;
    }
    if (kind === 'act') {
      const r = huntAct(room, p, String(body.act || ''), body);
      broadcast(room);
      return r;
    }
    if (kind === 'sticker') {
      const r = huntSticker(room, p, String(body.target || ''));
      broadcast(room);
      return r;
    }
    return { error: '不认识的动作' };
  },
  again(body) {
    const room = findRoom(body.code);
    if (!room) return { error: '房间不存在' };
    const p = room.players.find(x => x.id === body.pid);
    if (!p) return { error: '不在房间里' };
    room.phase = 'lobby';
    room.round = 1;
    room.result = null;
    room.cd = null;
    room.found = false;
    room.foundBy = null;
    room.votes.clear();
    room.picks.clear();
    room.owl = null;
    room.call = null;
    room.confess = null;
    room.excluded.clear();
    room.hunt = null;
    for (const x of room.players) {
      x.time = BUDGET; x.ended = false; x.voted = null; x.msgUsed = false;
      x.muted = false; x.lastSpot = null; x.pubClues.clear();
      x.clues.clear(); x.searched.clear(); x.privateLog.length = 0;
      Object.assign(x.task, { praise: 0, admits: 0, followed: 0, learned: 0, hungry: 0, whisperDone: false, foodFound: false, skillUsed: false, botPct: 0 });
    }
    room.players = room.players.filter(x => !x.isBot);
    logP(room, '再来一夜：回大厅重新挑身份。', 'phase');
    broadcast(room);
    return { ok: true };
  }
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'play.html' : decodeURIComponent(pathname.slice(1));
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>404</h1><p><a href="/">回大厅</a></p>'); }
    const ext = path.extname(full).toLowerCase();
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const HITS = [];
function note(from, pathname) {
  const ip = (from || '').replace('::ffff:', '');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  HITS.push(t + '  ' + ip + '  ' + pathname);
  if (HITS.length > 300) HITS.shift();
  if (!process.env.D221_QUIET) console.log('[hit] ' + ip + '  ' + pathname);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  if (pathname.startsWith('/api/') || pathname === '/events') note(req.socket.remoteAddress, pathname);

  if (pathname === '/events') {
    const room = findRoom(url.searchParams.get('room'));
    const pid = url.searchParams.get('pid');
    if (!room) { res.writeHead(404); return res.end('no room'); }
    const p = room.players.find(x => x.id === pid);
    if (!p) { res.writeHead(404); return res.end('no player'); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1500\n\n');
    room.clients.set(pid, res);
    room.dirty = true;
    try { res.write('event: state\ndata: ' + JSON.stringify(snap(room, p)) + '\n\n'); } catch (_) {}
    broadcast(room);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(hb); if (room.clients.get(pid) === res) room.clients.delete(pid); });
    return;
  }

  if (pathname === '/api/ping') {
    return sendJson(res, { ok: true, rooms: rooms.size, now: Date.now(), host: req.headers.host || '' });
  }

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5);
    const fn = ACTIONS[name];
    if (!fn) return sendJson(res, { error: 'no such action' }, 404);
    return readBody(req, (body) => {
      let out;
      try { out = fn(body || {}); } catch (e) { out = { error: 'server error: ' + e.message }; }
      sendJson(res, out, out.error ? 400 : 200);
    });
  }

  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) for (const n of list) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  console.log('221 宿舍 · 联机服务器已启动');
  console.log('  本机：  http://127.0.0.1:' + PORT + '/');
  for (const ip of ips) console.log('  局域网： http://' + ip + ':' + PORT + '/');
});
