'use strict';
/* ============================================================
 * 车间布局规划 · SLP 小游戏 —— 主逻辑
 * 数据（工艺流程 / 场地 / 参数）在 data.js 中修改
 * ============================================================ */

// ---------- 画布 ----------
const CELL = 36, PAD = 30;
const CANVAS_W = PAD * 2 + FLOOR.w * CELL;
const CANVAS_H = PAD * 2 + FLOOR.h * CELL;
const canvas = document.getElementById('floor');
const ctx = canvas.getContext('2d');
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

// ---------- 状态 ----------
const state = {
  mode: 'place',            // 'place' 摆放 | 'route' 路线
  placed: new Map(),        // id -> {id, x, y, w, h}
  selected: null,           // 选中的工作台 id
  pick: null,               // 拾取中的 {id, rot}
  ghost: null,              // 预览 {id, x, y, w, h, ok}
  drag: null,               // {id, ox, oy, sx, sy, moved}
  mouse: null,              // 鼠标所在格 {x, y}
  routes: new Map(),        // linkIndex -> {cells, len}
  routeLink: null,          // 正在规划的链接 index
  waypoints: [],            // 正在绘制的路径格
  score: null,
  anim: { on: false, acc: new Map(), parts: [] },
};

const $ = id => document.getElementById(id);
const stepById = id => STEPS.find(s => s.id === id);
const intensity = f => f >= 4 ? 'A' : f >= 2 ? 'E' : 'I';
const linkName = i => stepById(LINKS[i].from).short + ' → ' + stepById(LINKS[i].to).short;
const maxTime = Math.max(...STEPS.filter(s => s.time > 0).map(s => s.time));

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- 几何工具 ----------
const gx = c => PAD + c * CELL + CELL / 2;
const gy = c => PAD + c * CELL + CELL / 2;
const stCx = st => PAD + (st.x + st.w / 2) * CELL;
const stCy = st => PAD + (st.y + st.h / 2) * CELL;

// 画布可能被 CSS 缩放，鼠标坐标需换算回画布内部坐标
function canvasScale() {
  const w = canvas.getBoundingClientRect ? canvas.getBoundingClientRect().width : canvas.width;
  return (w && canvas.width) ? w / canvas.width : 1;
}
function cellOf(px, py) {
  const s = canvasScale();
  return { x: Math.floor((px / s - PAD) / CELL), y: Math.floor((py / s - PAD) / CELL) };
}
function inFloor(c) { return c.x >= 0 && c.y >= 0 && c.x < FLOOR.w && c.y < FLOOR.h; }
function cellInRect(c, r) { return c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h; }
function stationAtCell(c) { for (const st of state.placed.values()) if (cellInRect(c, st)) return st; return null; }
function stationFree(c) { return inFloor(c) && !stationAtCell(c); }

// 摆放合法性：不重叠、不出界、与其他工作台保持 MIN_GAP 通道
function placementValid(id, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > FLOOR.w || y + h > FLOOR.h) return '超出场地边界';
  for (const st of state.placed.values()) {
    if (st.id === id) continue;
    if (x - MIN_GAP < st.x + st.w && x + w + MIN_GAP > st.x &&
        y - MIN_GAP < st.y + st.h && y + h + MIN_GAP > st.y)
      return '与「' + stepById(st.id).short + '」太近（需保留 ' + MIN_GAP + 'm 通道）';
  }
  return null;
}

// 工作台四周相邻的可用格（路线进出口候选）
function adjacentCells(st) {
  const out = [];
  for (let y = st.y - 1; y <= st.y + st.h; y++) {
    for (let x = st.x - 1; x <= st.x + st.w; x++) {
      if (x >= st.x && x < st.x + st.w && y >= st.y && y < st.y + st.h) continue; // 自身
      const c = { x, y };
      if (stationFree(c)) out.push(c);
    }
  }
  return out;
}
function isAdjacentCell(c, st) {
  return !cellInRect(c, st) &&
    c.x >= st.x - 1 && c.x <= st.x + st.w &&
    c.y >= st.y - 1 && c.y <= st.y + st.h;
}
function pickAdjacent(st, toward) {
  let best = null, bd = Infinity;
  for (const c of adjacentCells(st)) {
    const d = (c.x - toward.x) ** 2 + (c.y - toward.y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

// ---------- 最短路径搜索（Dijkstra，网格很小直接 O(V²)） ----------
function routeCellSet(exclude) {
  const s = new Set();
  for (const [i, r] of state.routes) {
    if (i === exclude) continue;
    for (const c of r.cells) s.add(c.y * FLOOR.w + c.x);
  }
  return s;
}

// 返回 from → to 的路径格序列（不含工作台自身格）；preferRoutes 时优先走已有路线（形成共享通道）
function shortestPath(from, to, preferRoutes) {
  if (!from || !to) return null;
  const W = FLOOR.w, H = FLOOR.h, N = W * H;
  const blocked = new Uint8Array(N);
  for (const st of state.placed.values())
    for (let y = st.y; y < st.y + st.h; y++)
      for (let x = st.x; x < st.x + st.w; x++)
        blocked[y * W + x] = 1;
  const srcs = adjacentCells(from);
  if (!srcs.length) return null;
  const targets = new Set(adjacentCells(to).map(c => c.y * W + c.x));
  const shared = preferRoutes ? routeCellSet(-1) : null;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  for (const c of srcs) dist[c.y * W + c.x] = 1;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) return null;
    done[u] = 1;
    if (targets.has(u)) {
      const cells = [];
      while (u >= 0) { cells.push({ x: u % W, y: (u / W) | 0 }); u = prev[u]; }
      cells.reverse();
      return cells;
    }
    const ux = u % W, uy = (u / W) | 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = ux + dx, ny = uy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const v = ny * W + nx;
      if (blocked[v] || done[v]) continue;
      const w = (preferRoutes && shared.has(v)) ? 0.55 : 1;
      const nd = dist[u] + w;
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; }
    }
  }
}

// 理论最短距离（含进出工作台的各 1 步）
function boundLen(i) {
  const link = LINKS[i];
  const cells = shortestPath(state.placed.get(link.from), state.placed.get(link.to), false);
  return cells ? cells.length + 1 : Infinity;
}

// ---------- 搬运时长 ----------
// 每趟搬运时长 = 装卸时间 + 往返距离 ÷ 搬运速度（roundTrip 时距离 ×2）
const tripTime = len => HANDLING.fixedTime + (HANDLING.roundTrip ? 2 : 1) * len / HANDLING.speed;
// 每件成品在一条路线上的搬运时长 = 物流量 × 每趟时长
const linkUnitTime = i => {
  const r = state.routes.get(i);
  return r ? LINKS[i].flow * tripTime(r.len) : 0;
};

// ---------- 摆放操作 ----------
function placeAt(id, x, y) {
  const def = stepById(id);
  const rot = state.pick ? state.pick.rot : false;
  const w = rot ? def.size[1] : def.size[0];
  const h = rot ? def.size[0] : def.size[1];
  const err = placementValid(id, x, y, w, h);
  if (err) { toast('❌ ' + err); return; }
  state.placed.set(id, { id, x, y, w, h });
  state.pick = null;
  state.selected = id;
  refreshPanels();
  toast('✅ 已放置「' + def.short + '」' + (def.time > 0 ? '（标准时间 ' + def.time + 's/件）' : ''));
  if (state.placed.size === STEPS.length)
    toast('🎉 全部工作台已就位！切换到「规划物流路线」开始连线吧');
}

function rotateStation(id) {
  const st = state.placed.get(id);
  if (!st) return;
  const w = st.h, h = st.w;
  const err = placementValid(id, st.x, st.y, w, h);
  if (err) { toast('❌ 旋转后：' + err); return; }
  st.w = w; st.h = h;
  removeRoutesOf(id, '已旋转「' + stepById(id).short + '」，相关路线已清除');
  refreshPanels();
}

function deleteStation(id) {
  state.placed.delete(id);
  removeRoutesOf(id, null);
  if (state.selected === id) state.selected = null;
  refreshPanels();
  toast('已删除「' + stepById(id).short + '」');
}

function removeRoutesOf(id, msg) {
  let removed = false;
  for (const i of [...state.routes.keys()])
    if (LINKS[i].from === id || LINKS[i].to === id) { state.routes.delete(i); removed = true; }
  if (removed && msg) toast(msg);
}

// ---------- 路线绘制 ----------
function routeClick(c) {
  if (state.routeLink == null) {
    const st = stationAtCell(c);
    if (st) {
      for (let i = 0; i < LINKS.length; i++) {
        if (!state.routes.has(i) && LINKS[i].from === st.id) {
          state.routeLink = i;
          state.waypoints = [];
          refreshPanels();
          toast('开始规划：' + linkName(i) + '，请点击起点工作台或其相邻通道');
          return;
        }
      }
    }
    toast('请先在右侧「物流路线清单」中选择一条未规划路线');
    return;
  }
  const i = state.routeLink;
  const link = LINKS[i];
  const from = state.placed.get(link.from);
  const to = state.placed.get(link.to);
  if (!from || !to) { toast('请先放置相关工作台'); state.routeLink = null; return; }

  if (!state.waypoints.length) {
    const st = stationAtCell(c);
    if (st) {
      if (st.id === link.from) { state.waypoints.push(pickAdjacent(from, c)); return; }
      toast('请先点击起点「' + stepById(link.from).short + '」');
      return;
    }
    if (isAdjacentCell(c, from)) { state.waypoints.push({ x: c.x, y: c.y }); return; }
    toast('请点击起点「' + stepById(link.from).short + '」或其相邻通道格');
    return;
  }

  const last = state.waypoints[state.waypoints.length - 1];
  const st = stationAtCell(c);
  if (st) {
    if (st.id === link.to) {
      if (isAdjacentCell(last, to)) { completeRoute(); return; } // 已贴着终点，直接完成
      const t = pickAdjacent(to, last);
      if (pushSegment(t)) completeRoute();
      else toast('无法直达终点，请绕行');
      return;
    }
    if (st.id === link.from) { toast('路径不能回到起点工作台'); return; }
    toast('路径不能穿过工作台');
    return;
  }
  if (isAdjacentCell(c, to) && stationFree(c)) {
    if (pushSegment(c)) completeRoute();
    return;
  }
  if (!stationFree(c)) { toast('该格不可用'); return; }
  pushSegment(c);
}

function pushSegment(cell) {
  const last = state.waypoints[state.waypoints.length - 1];
  if (!last) return false;
  if (cell.x === last.x && cell.y === last.y) return false;
  if (cell.x !== last.x && cell.y !== last.y) { toast('路径只能沿水平或垂直方向逐格延伸'); return false; }
  const dx = Math.sign(cell.x - last.x), dy = Math.sign(cell.y - last.y);
  const cells = [];
  let x = last.x, y = last.y;
  while (x !== cell.x || y !== cell.y) {
    x += dx; y += dy;
    const c = { x, y };
    if (!stationFree(c)) { toast('路径不能穿过工作台或超出场地'); return false; }
    cells.push(c);
  }
  state.waypoints.push(...cells);
  return true;
}

function completeRoute() {
  const i = state.routeLink;
  const len = state.waypoints.length + 1;
  state.routes.set(i, { cells: state.waypoints, len });
  state.routeLink = null;
  state.waypoints = [];
  refreshPanels();
  toast('✅ 路线完成：' + linkName(i) + ' = ' + len + ' m · ' + (LINKS[i].flow * tripTime(len)).toFixed(1) + ' s/件');
}

function autoRoute(i) {
  const link = LINKS[i];
  const cells = shortestPath(state.placed.get(link.from), state.placed.get(link.to), true);
  if (!cells) { toast('❌ 无法找到可行路线（可能被堵死）'); return false; }
  state.routes.set(i, { cells, len: cells.length + 1 });
  refreshPanels();
  return true;
}

function startDraw(i) {
  setMode('route');
  toggleDrawer(false); // 收起面板，方便在地面画线
  state.routeLink = i;
  state.waypoints = [];
  if (state.routes.has(i)) {
    state.routes.delete(i);
    toast('已清除原路线，请重新绘制：' + linkName(i));
  } else {
    toast('开始规划：' + linkName(i) + ' —— 点击起点工作台 → 逐格画线 → 点击终点工作台');
  }
  refreshPanels();
}

// ---------- 模式 ----------
function setMode(m) {
  state.mode = m;
  state.routeLink = null;
  state.waypoints = [];
  state.pick = null;
  state.ghost = null;
  state.drag = null;
  state.selected = null;
  $('btnPlace').classList.toggle('active', m === 'place');
  $('btnRoute').classList.toggle('active', m === 'route');
  $('hintbar').textContent = m === 'place'
    ? '🏗 摆放模式：点击下方卡片拾取工作台 → 在场地点击放下；拖动已放置的工作台可移动，按 R / 右键旋转，Del 删除。'
    : '🛣 路线模式：在右侧清单选择一条路线（或直接点击其起点工作台）→ 点击起点 → 逐格点击（只能横 / 竖）→ 点击终点完成；退格撤销，Esc 取消。';
  refreshPanels();
}

// ---------- 面板刷新 ----------
function refreshPanels() {
  refreshPalette();
  refreshLinkList();
  refreshScore();
  refreshAdvice();
  refreshDetail();
  refreshHud();
}

function refreshHud() {
  const st = STEPS.filter(s => s.time > 0).reduce((a, b) => b.time > a.time ? b : a);
  $('bottleneck').textContent =
    '⏱ 瓶颈工序：' + st.short + '（' + st.time + 's/件）→ 理论节拍 ' + st.time + 's → 产能上限 ' +
    Math.round(3600 / st.time) + ' 件/小时';
  const sc = state.score;
  $('hud').textContent = '已放置 ' + state.placed.size + '/' + STEPS.length +
    ' · 路线 ' + state.routes.size + '/' + LINKS.length +
    (sc && sc.planned ? ' · 搬运效率 ' + Math.round(sc.timeEff) + '% · 需搬运工 ' + sc.handlers + ' 人' : '');
}

function refreshPalette() {
  const el = $('paletteCards');
  el.innerHTML = '';
  for (const s of STEPS) {
    const placed = state.placed.has(s.id);
    const picked = state.pick && state.pick.id === s.id;
    const card = document.createElement('div');
    card.className = 'card' + (placed ? ' placed' : '') + (picked ? ' picked' : '');
    card.innerHTML =
      '<div class="cname"><span class="chip" style="background:' + s.color + '"></span>' + s.icon + ' ' + s.name + '</div>' +
      '<div class="cmeta">设备：' + s.equip + (s.time > 0 ? ' · 标准时间 ' + s.time + 's/件' : '') + '</div>' +
      '<div class="csize">占地 ' + s.size[0] + 'm × ' + s.size[1] + 'm（' + (s.size[0] * s.size[1]) + '㎡）' +
      (picked && state.pick.rot ? ' · 已旋转' : '') + '</div>';
    if (!placed) {
      card.addEventListener('click', () => {
        state.pick = (state.pick && state.pick.id === s.id) ? null : { id: s.id, rot: false };
        state.selected = null;
        refreshPalette();
        refreshDetail();
        if (state.pick) toast('已拾取「' + s.short + '」，请在场地中点击放置（按 R 旋转）');
      });
    }
    el.appendChild(card);
  }
}

function refreshLinkList() {
  const el = $('linkList');
  el.innerHTML = '';
  LINKS.forEach((link, i) => {
    const from = stepById(link.from), to = stepById(link.to);
    const fp = state.placed.has(link.from), tp = state.placed.has(link.to);
    const r = state.routes.get(i);
    const it = intensity(link.flow);
    let status, cls;
    if (!fp || !tp) { status = '需先放置' + (fp ? '' : ' ' + from.short) + (tp ? '' : ' ' + to.short); cls = 'warn'; }
    else if (r) {
      status = '已规划 · ' + r.len + ' m · ' + (LINKS[i].flow * tripTime(r.len)).toFixed(1) + ' s/件';
      cls = 'ok';
    }
    else { status = '未规划'; cls = 'bad'; }

    const row = document.createElement('div');
    row.className = 'link-row' + (state.routeLink === i ? ' active' : '');
    row.innerHTML =
      '<span class="itag it-' + it.toLowerCase() + '">' + it + '</span>' +
      '<span class="lname">' + from.short + ' → ' + to.short + '</span>' +
      '<span class="lflow">×' + link.flow + '</span>' +
      '<span class="lstatus ' + cls + '">' + status + '</span>' +
      '<span class="lbtns"></span>';
    const btns = row.querySelector('.lbtns');
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.className = 'mini';
      b.textContent = label;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };
    if (fp && tp) {
      if (r) {
        btns.appendChild(mk('重画', () => startDraw(i)));
        btns.appendChild(mk('自动', () => { autoRoute(i); toast('已自动规划：' + linkName(i)); }));
        btns.appendChild(mk('删除', () => { state.routes.delete(i); refreshPanels(); toast('已删除路线：' + linkName(i)); }));
      } else {
        btns.appendChild(mk('规划', () => startDraw(i)));
        btns.appendChild(mk('自动', () => { autoRoute(i); toast('已自动规划：' + linkName(i)); }));
      }
    }
    if (r) {
      const trip = tripTime(r.len);
      row.title = '每趟：装卸 ' + HANDLING.fixedTime + 's + 往返 ' +
        ((HANDLING.roundTrip ? 2 : 1) * r.len / HANDLING.speed).toFixed(1) + 's = ' + trip.toFixed(1) + 's；物流量 ×' + LINKS[i].flow +
        ' → 每件 ' + (LINKS[i].flow * trip).toFixed(1) + 's';
    }
    row.addEventListener('click', () => { if (fp && tp) startDraw(i); else toast('请先放置相关工作台'); });
    el.appendChild(row);
  });
}

function refreshScore() {
  let planned = 0, actual = 0, boundSum = 0, actualTime = 0, boundTime = 0;
  for (let i = 0; i < LINKS.length; i++) {
    const r = state.routes.get(i);
    if (!r) continue;
    planned++;
    actual += LINKS[i].flow * r.len;
    actualTime += LINKS[i].flow * tripTime(r.len);
    const b = boundLen(i);
    if (isFinite(b)) {
      boundSum += LINKS[i].flow * b;
      boundTime += LINKS[i].flow * tripTime(b);
    }
  }
  const eff = actual > 0 ? boundSum / actual * 100 : 0;
  const timeEff = actualTime > 0 ? boundTime / actualTime * 100 : 0;
  const handlers = actualTime > 0 ? Math.ceil(actualTime / maxTime) : 0;
  state.score = { planned, actual, boundSum, eff, actualTime, boundTime, timeEff, handlers };
  $('scPlanned').textContent = planned + '/' + LINKS.length;
  $('scActual').textContent = planned ? String(Math.round(actual)) : '—';
  $('scEff').textContent = planned ? Math.round(eff) + '%' : '0%';
  $('scTime').textContent = planned ? actualTime.toFixed(1) + ' s' : '—';
  $('scTimeBound').textContent = planned ? boundTime.toFixed(1) + ' s' : '—';
  $('scTimeEff').textContent = planned ? Math.round(timeEff) + '%' : '0%';
  $('scHandlers').textContent = planned
    ? '👷 需搬运工 ' + handlers + ' 人（每件搬运 ' + actualTime.toFixed(1) + 's ÷ 节拍 ' + maxTime + 's）'
    : '👷 规划路线后自动估算所需搬运工人数';
}

function refreshAdvice() {
  const ul = $('adviceList');
  const items = [];
  const sc = state.score || { planned: 0, eff: 0 };
  for (let i = 0; i < LINKS.length; i++) {
    const r = state.routes.get(i);
    if (!r) continue;
    const b = boundLen(i);
    if (isFinite(b) && r.len > b * 1.5) {
      const now = LINKS[i].flow * tripTime(r.len);
      const best = LINKS[i].flow * tripTime(b);
      items.push('「' + linkName(i) + '」搬运 ' + now.toFixed(1) + 's/件，最短仅 ' + best.toFixed(1) + 's/件 —— 摆近可省 ' + (now - best).toFixed(1) + 's');
    }
  }
  for (let i = 0; i < LINKS.length; i++) {
    if (state.routes.has(i)) continue;
    const link = LINKS[i];
    if (!state.placed.has(link.from) || !state.placed.has(link.to)) continue;
    if (link.flow >= 4)
      items.push('高物流量（A 级）路线「' + linkName(i) + '」尚未规划，优先处理！');
  }
  if (!state.placed.size) items.push('从下方拾取工作台，在场地中摆放（尽量把 A 级相关工序放在一起）');
  if (sc.planned === LINKS.length && sc.timeEff >= 99.999) items.push('🎉 完美布局！所有路线都达到理论最短搬运时长');
  else if (sc.planned > 0 && sc.timeEff < 60) items.push('整体搬运效率偏低（' + Math.round(sc.timeEff) + '%），把高流量工序相邻摆放可大幅减少搬运时长');
  if (sc.planned > 0 && sc.handlers >= 2) items.push('当前布局需要 ' + sc.handlers + ' 名搬运工（节拍 ' + maxTime + 's），优化布局可减少人力');
  if (!items.length) items.push(sc.planned ? '布局不错，继续优化或点击「运行演示」查看物流' : '先放置工作台，再规划物流路线');
  ul.innerHTML = items.map(t => '<li>' + t + '</li>').join('');
}

function refreshDetail() {
  const el = $('stationDetail');
  const id = state.selected;
  if (id && state.placed.has(id)) {
    const st = state.placed.get(id);
    const def = stepById(id);
    el.innerHTML =
      '<div class="dname" style="color:' + def.color + '">' + def.icon + ' ' + def.name + '</div>' +
      '<div class="dmeta">所属支线：' + def.line + '<br>设备：' + def.equip +
      '<br>标准时间：' + (def.time > 0 ? def.time + ' s/件' : '—') +
      '<br>占地：' + st.w + 'm × ' + st.h + 'm（' + (st.w * st.h) + '㎡）' +
      '<br>位置：第 ' + (st.x + 1) + '~' + (st.x + st.w) + ' 列，第 ' + (st.y + 1) + '~' + (st.y + st.h) + ' 行</div>' +
      '<div class="dbtns"><button class="btn" id="dRotate">🔄 旋转</button><button class="btn danger" id="dDelete">🗑 删除</button></div>';
    $('dRotate').addEventListener('click', () => rotateStation(id));
    $('dDelete').addEventListener('click', () => deleteStation(id));
  } else if (state.pick) {
    const def = stepById(state.pick.id);
    el.innerHTML =
      '<div class="dname" style="color:' + def.color + '">' + def.icon + ' ' + def.name + '</div>' +
      '<div class="dmeta">已拾取，点击场地放置<br>设备：' + def.equip +
      '<br>标准时间：' + (def.time > 0 ? def.time + ' s/件' : '—') +
      '<br>占地：' + def.size[0] + 'm × ' + def.size[1] + 'm（旋转后互换）</div>' +
      '<div class="dbtns"><button class="btn" id="dRotatePick">🔄 旋转（R）</button></div>';
    $('dRotatePick').addEventListener('click', () => { state.pick.rot = !state.pick.rot; refreshPanels(); });
  } else {
    el.innerHTML = '<div class="dmeta">在场地中点击任意工作台查看详情；<br>点击左侧流程图节点可快速定位 / 拾取。</div>';
  }
}

// ---------- 工艺流程 SVG ----------
function buildFlowDiagram(container, onNodeClick) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 1050 480');
  const defs = document.createElementNS(NS, 'defs');
  const marker = document.createElementNS(NS, 'marker');
  marker.setAttribute('id', 'arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
  marker.setAttribute('orient', 'auto-start-reverse');
  const mp = document.createElementNS(NS, 'path');
  mp.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  mp.setAttribute('fill', '#64748b');
  marker.appendChild(mp);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const trim = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const tx = Math.abs(dx) > 0 ? 75 / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 0 ? 33 / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty, 1);
    return [ax + dx * t, ay + dy * t];
  };

  // 连线（先画，节点覆盖线端）
  for (const link of LINKS) {
    const a = stepById(link.from), b = stepById(link.to);
    const pts = [a.pos, ...(link.path || []), b.pos];
    const poly = [];
    for (let k = 0; k < pts.length - 1; k++) {
      let sx = pts[k][0], sy = pts[k][1], ex = pts[k + 1][0], ey = pts[k + 1][1];
      if (k === 0) [sx, sy] = trim(sx, sy, ex, ey);
      if (k === pts.length - 2) [ex, ey] = trim(ex, ey, sx, sy);
      poly.push([sx, sy, ex, ey]);
    }
    for (let k = 0; k < poly.length; k++) {
      const [sx, sy, ex, ey] = poly[k];
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', sx); line.setAttribute('y1', sy);
      line.setAttribute('x2', ex); line.setAttribute('y2', ey);
      line.setAttribute('stroke', '#94a3b8');
      line.setAttribute('stroke-width', '2');
      if (k === poly.length - 1) line.setAttribute('marker-end', 'url(#arrow)');
      svg.appendChild(line);
    }
    // 流量标签
    const lbl = link.lbl || [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2];
    const g = document.createElementNS(NS, 'g');
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', lbl[0] - 30); r.setAttribute('y', lbl[1] - 11);
    r.setAttribute('width', '60'); r.setAttribute('height', '22');
    r.setAttribute('rx', '11');
    r.setAttribute('fill', '#ffffff'); r.setAttribute('stroke', '#cbd5e1');
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', lbl[0]); t.setAttribute('y', lbl[1] + 4);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-size', '11');
    t.setAttribute('fill', '#334155');
    t.textContent = '×' + link.flow + ' ' + intensity(link.flow);
    g.appendChild(r); g.appendChild(t);
    svg.appendChild(g);
  }

  // 节点
  for (const s of STEPS) {
    const g = document.createElementNS(NS, 'g');
    g.style.cursor = 'pointer';
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', s.pos[0] - 75); r.setAttribute('y', s.pos[1] - 33);
    r.setAttribute('width', '150'); r.setAttribute('height', '66');
    r.setAttribute('rx', '8');
    r.setAttribute('fill', s.color);
    r.setAttribute('stroke', 'rgba(0,0,0,0.18)');
    g.appendChild(r);
    const t1 = document.createElementNS(NS, 'text');
    t1.setAttribute('x', s.pos[0] - 58); t1.setAttribute('y', s.pos[1] - 8);
    t1.setAttribute('font-size', '15'); t1.setAttribute('font-weight', 'bold');
    t1.setAttribute('fill', '#ffffff');
    t1.textContent = s.icon + ' ' + s.name;
    const t2 = document.createElementNS(NS, 'text');
    t2.setAttribute('x', s.pos[0] - 58); t2.setAttribute('y', s.pos[1] + 10);
    t2.setAttribute('font-size', '12'); t2.setAttribute('fill', 'rgba(255,255,255,0.9)');
    t2.textContent = s.time > 0 ? '设备：' + s.equip : '库区';
    const t3 = document.createElementNS(NS, 'text');
    t3.setAttribute('x', s.pos[0] - 58); t3.setAttribute('y', s.pos[1] + 26);
    t3.setAttribute('font-size', '12'); t3.setAttribute('fill', 'rgba(255,255,255,0.9)');
    t3.textContent = (s.time > 0 ? '⏱ ' + s.time + 's/件 · ' : '') + s.size[0] + '×' + s.size[1] + 'm';
    g.appendChild(t1); g.appendChild(t2); g.appendChild(t3);
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (onNodeClick) onNodeClick(s.id);
    });
    const title = document.createElementNS(NS, 'title');
    title.textContent = s.name;
    g.appendChild(title);
    svg.appendChild(g);
  }
  container.appendChild(svg);
  return svg;
}

// 支线图例（只生成一次）
function buildLineLegend() {
  const legend = $('lineLegend');
  legend.innerHTML = '';
  const lines = [];
  for (const s of STEPS) if (!lines.some(l => l.name === s.line)) lines.push({ name: s.line, color: s.color });
  for (const l of lines) {
    const sp = document.createElement('span');
    sp.innerHTML = '<span class="dot" style="background:' + l.color + '"></span>' + l.line;
    legend.appendChild(sp);
  }
}

// ---------- 流程图放大 & 二级面板 ----------
let drawerOpen = false;
let modalOpen = false;

function openDiagramModal() {
  const wrap = $('modalFlow');
  wrap.innerHTML = '';
  buildFlowDiagram(wrap, id => { closeDiagramModal(); focusStep(id); });
  $('diagramModal').classList.add('open');
  modalOpen = true;
}

function closeDiagramModal() {
  $('diagramModal').classList.remove('open');
  modalOpen = false;
}

function toggleDrawer(force) {
  drawerOpen = typeof force === 'boolean' ? force : !drawerOpen;
  $('drawer').classList.toggle('open', drawerOpen);
  return drawerOpen;
}

const TAB_MAP = { score: 'paneScore', route: 'paneRoute', detail: 'paneDetail', advice: 'paneAdvice', help: 'paneHelp' };
const TAB_BTN = { score: 'tabScore', route: 'tabRoute', detail: 'tabDetail', advice: 'tabAdvice', help: 'tabHelp' };
function showTab(name) {
  for (const k of Object.keys(TAB_MAP)) {
    $(TAB_MAP[k]).classList.toggle('open', k === name);
    $(TAB_BTN[k]).classList.toggle('active', k === name);
  }
}

function initDiagram() {
  const svg = buildFlowDiagram($('flowSvg'), () => openDiagramModal());
  svg.addEventListener('click', () => openDiagramModal());
  buildLineLegend();
}

function bindPanel() {
  $('btnDrawer').addEventListener('click', () => toggleDrawer());
  $('drawerClose').addEventListener('click', () => toggleDrawer(false));
  $('modalClose').addEventListener('click', closeDiagramModal);
  $('diagramModal').addEventListener('click', e => { if (e.target === $('diagramModal')) closeDiagramModal(); });
  for (const k of Object.keys(TAB_BTN)) $(TAB_BTN[k]).addEventListener('click', () => showTab(k));
}

function focusStep(id) {
  setMode('place');
  toggleDrawer(false);
  if (state.placed.has(id)) {
    state.selected = id;
    toast('已定位「' + stepById(id).name + '」（场地中金色框）');
  } else {
    state.pick = { id, rot: false };
    toast('已拾取「' + stepById(id).short + '」，请在场地中点击放置');
  }
  refreshPanels();
}

// ---------- 画布渲染 ----------
function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFloor() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  const fw = FLOOR.w * CELL, fh = FLOOR.h * CELL;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(PAD, PAD, fw, fh);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= FLOOR.w; i++) { ctx.moveTo(PAD + i * CELL, PAD); ctx.lineTo(PAD + i * CELL, PAD + fh); }
  for (let j = 0; j <= FLOOR.h; j++) { ctx.moveTo(PAD, PAD + j * CELL); ctx.lineTo(PAD + fw, PAD + j * CELL); }
  ctx.stroke();
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 4;
  ctx.strokeRect(PAD, PAD, fw, fh);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i <= FLOOR.w; i += 2) ctx.fillText(String(i), PAD + i * CELL, PAD - 8);
  ctx.textAlign = 'right';
  for (let j = 0; j <= FLOOR.h; j += 2) ctx.fillText(String(j), PAD - 6, PAD + j * CELL + 4);
}

function routePoly(i) {
  const link = LINKS[i], r = state.routes.get(i);
  const f = state.placed.get(link.from), t = state.placed.get(link.to);
  if (!r || !f || !t) return null;
  const pts = [{ x: stCx(f), y: stCy(f) }];
  for (const c of r.cells) pts.push({ x: gx(c.x), y: gy(c.y) });
  pts.push({ x: stCx(t), y: stCy(t) });
  return pts;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function drawArrow(mx, my, ang, color) {
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(6, 0); ctx.lineTo(-4, 4); ctx.lineTo(-4, -4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawRoutes() {
  for (let i = 0; i < LINKS.length; i++) {
    const r = state.routes.get(i);
    if (!r) continue;
    const color = stepById(LINKS[i].from).color;
    if (state.drag && (LINKS[i].from === state.drag.id || LINKS[i].to === state.drag.id)) continue;
    // 通道底色
    ctx.fillStyle = hexA(color, 0.08);
    for (const c of r.cells) ctx.fillRect(PAD + c.x * CELL, PAD + c.y * CELL, CELL, CELL);
    const pts = routePoly(i);
    if (!pts) continue;
    ctx.strokeStyle = hexA(color, 0.9);
    ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();
    // 方向箭头（隔段绘制）
    for (let k = 1; k < pts.length; k += 2) {
      const mx = (pts[k - 1].x + pts[k].x) / 2;
      const my = (pts[k - 1].y + pts[k].y) / 2;
      const ang = Math.atan2(pts[k].y - pts[k - 1].y, pts[k].x - pts[k - 1].x);
      drawArrow(mx, my, ang, color);
    }
  }
}

function drawWaypoints() {
  if (state.mode !== 'route' || state.routeLink == null || !state.waypoints.length) return;
  const link = LINKS[state.routeLink];
  const f = state.placed.get(link.from);
  if (!f) return;
  const pts = [{ x: stCx(f), y: stCy(f) }];
  for (const c of state.waypoints) pts.push({ x: gx(c.x), y: gy(c.y) });
  if (state.mouse) pts.push({ x: gx(state.mouse.x), y: gy(state.mouse.y) });
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f59e0b';
  for (const c of state.waypoints) {
    ctx.beginPath();
    ctx.arc(gx(c.x), gy(c.y), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStations() {
  for (const st of state.placed.values()) {
    const def = stepById(st.id);
    const x = PAD + st.x * CELL, y = PAD + st.y * CELL, w = st.w * CELL, h = st.h * CELL;
    ctx.fillStyle = def.color;
    rr(x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    rr(x, y, w, h, 6);
    ctx.stroke();

    let hl = null;
    if (state.selected === st.id) hl = '#f59e0b';
    else if (state.drag && state.drag.id === st.id) hl = placementValid(st.id, st.x, st.y, st.w, st.h) ? '#dc2626' : '#16a34a';
    else if (state.mode === 'route' && state.routeLink != null) {
      if (LINKS[state.routeLink].from === st.id) hl = '#16a34a';
      else if (LINKS[state.routeLink].to === st.id) hl = '#ef4444';
    }
    if (hl) {
      ctx.strokeStyle = hl;
      ctx.lineWidth = 3;
      rr(x + 2, y + 2, w - 4, h - 4, 5);
      ctx.stroke();
    }

    // 瓶颈星标
    if (def.time > 0 && def.time === maxTime) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('★', x + w - 4, y + 16);
    }

    // 文字
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.font = 'bold 13px "Segoe UI","Microsoft YaHei",sans-serif';
    ctx.strokeText(def.short, x + w / 2, y + h / 2 - 4);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(def.short, x + w / 2, y + h / 2 - 4);
    ctx.font = '10px "Segoe UI","Microsoft YaHei",sans-serif';
    const sub = def.time > 0 ? '⏱' + def.time + 's/件' : '库区';
    ctx.strokeText(sub, x + w / 2, y + h / 2 + 12);
    ctx.fillText(sub, x + w / 2, y + h / 2 + 12);
  }
}

function drawGhost() {
  if (!state.ghost) return;
  const g = state.ghost;
  const x = PAD + g.x * CELL, y = PAD + g.y * CELL, w = g.w * CELL, h = g.h * CELL;
  ctx.fillStyle = g.ok ? 'rgba(22,163,74,0.16)' : 'rgba(220,38,38,0.16)';
  rr(x, y, w, h, 6);
  ctx.fill();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = g.ok ? '#16a34a' : '#dc2626';
  ctx.lineWidth = 2;
  rr(x, y, w, h, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = g.ok ? 'rgba(22,163,74,0.9)' : 'rgba(220,38,38,0.9)';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(stepById(g.id).short, x + w / 2, y + h / 2 + 4);
}

// ---------- 物料流动画 ----------
function pointAlong(pts, t) {
  if (pts.length < 2) return pts[0];
  let total = 0;
  const seg = [];
  for (let k = 1; k < pts.length; k++) {
    const d = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y);
    seg.push(d);
    total += d;
  }
  let target = t * total;
  for (let k = 0; k < seg.length; k++) {
    if (target <= seg[k] || k === seg.length - 1) {
      const f = seg[k] > 0 ? target / seg[k] : 0;
      return {
        x: pts[k].x + (pts[k + 1].x - pts[k].x) * f,
        y: pts[k].y + (pts[k + 1].y - pts[k].y) * f
      };
    }
    target -= seg[k];
  }
  return pts[pts.length - 1];
}

function updateParticles(dt) {
  const parts = state.anim.parts;
  for (let i = 0; i < LINKS.length; i++) {
    if (!state.routes.has(i)) continue;
    const interval = 2200 / LINKS[i].flow;
    const acc = (state.anim.acc.get(i) || 0) + dt;
    let a = acc;
    while (a >= interval) {
      a -= interval;
      if (parts.length < 90)
        parts.push({ i, t: 0, dur: Math.max(800, tripTime(state.routes.get(i).len) * 80) });
    }
    state.anim.acc.set(i, a);
  }
  // 动画速度与搬运时长成正比：路线越长、装卸越久，粒子走得越慢
  for (let k = parts.length - 1; k >= 0; k--) {
    parts[k].t += dt / parts[k].dur;
    if (parts[k].t >= 1) parts.splice(k, 1);
  }
}

function drawParticles() {
  for (const p of state.anim.parts) {
    const pts = routePoly(p.i);
    if (!pts) continue;
    const pt = pointAlong(pts, p.t);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = stepById(LINKS[p.i].from).color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ---------- 主循环 ----------
let lastTime = performance.now();
function tick(now) {
  const dt = Math.min(60, now - lastTime);
  lastTime = now;
  drawFloor();
  drawRoutes();
  drawWaypoints();
  drawStations();
  drawGhost();
  if (state.anim.on) {
    updateParticles(dt);
    drawParticles();
  }
  requestAnimationFrame(tick);
}

// ---------- 交互 ----------
canvas.addEventListener('mousedown', e => {
  const c = cellOf(e.offsetX, e.offsetY);
  state.mouse = c;
  if (state.mode === 'place') {
    if (state.pick) {
      placeAt(state.pick.id, c.x, c.y);
      return;
    }
    const st = stationAtCell(c);
    if (st) {
      state.selected = st.id;
      state.drag = { id: st.id, ox: c.x - st.x, oy: c.y - st.y, sx: st.x, sy: st.y, moved: false };
    } else {
      state.selected = null;
    }
    refreshPanels();
  } else {
    routeClick(c);
  }
});

canvas.addEventListener('mousemove', e => {
  state.mouse = cellOf(e.offsetX, e.offsetY);
  if (state.drag) {
    const d = state.drag, st = state.placed.get(d.id);
    const nx = state.mouse.x - d.ox, ny = state.mouse.y - d.oy;
    if (nx !== st.x || ny !== st.y) d.moved = true;
    st.x = nx; st.y = ny;
  }
  updateGhost();
});

canvas.addEventListener('mouseup', () => {
  if (state.drag) {
    const d = state.drag, st = state.placed.get(d.id);
    const err = placementValid(d.id, st.x, st.y, st.w, st.h);
    if (err) {
      st.x = d.sx; st.y = d.sy;
      toast('❌ ' + err);
    } else if (d.moved) {
      removeRoutesOf(d.id, '已移动「' + stepById(d.id).short + '」，相关路线已清除');
    }
    state.drag = null;
    refreshPanels();
  }
});

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const c = cellOf(e.offsetX, e.offsetY);
  const st = stationAtCell(c);
  if (state.mode === 'place' && st) rotateStation(st.id);
  else if (state.pick) { state.pick = null; refreshPanels(); }
});

canvas.addEventListener('mouseleave', () => {
  state.mouse = null;
  state.ghost = null;
});

function updateGhost() {
  if (state.pick && state.mouse) {
    const def = stepById(state.pick.id);
    const w = state.pick.rot ? def.size[1] : def.size[0];
    const h = state.pick.rot ? def.size[0] : def.size[1];
    const ok = !placementValid(state.pick.id, state.mouse.x, state.mouse.y, w, h);
    state.ghost = { id: state.pick.id, x: state.mouse.x, y: state.mouse.y, w, h, ok };
  } else {
    state.ghost = null;
  }
}

// ---------- 键盘与按钮 ----------
window.addEventListener('keydown', e => {
  if (e.key === '1') setMode('place');
  else if (e.key === '2') setMode('route');
  else if (e.key === '3') toggleDrawer();
  else if (e.key === 'r' || e.key === 'R') {
    if (state.pick) {
      state.pick.rot = !state.pick.rot;
      toast(state.pick.rot ? '已旋转（宽高互换）' : '已恢复原方向');
      refreshPanels();
    } else if (state.selected) {
      rotateStation(state.selected);
    }
  } else if (e.key === 'Escape') {
    if (modalOpen) { closeDiagramModal(); return; }
    if (drawerOpen) { toggleDrawer(false); return; }
    state.pick = null; state.routeLink = null; state.waypoints = []; state.drag = null;
    toast('已取消当前操作');
    refreshPanels();
  } else if (e.key === 'Delete') {
    if (state.selected) deleteStation(state.selected);
  } else if (e.key === 'Backspace') {
    if (state.mode === 'route' && state.waypoints.length) {
      state.waypoints.pop();
      toast('已撤销一步');
    }
  }
});

$('btnPlace').addEventListener('click', () => setMode('place'));
$('btnRoute').addEventListener('click', () => setMode('route'));
$('btnRotate').addEventListener('click', () => {
  if (state.pick) { state.pick.rot = !state.pick.rot; refreshPanels(); }
  else if (state.selected) rotateStation(state.selected);
  else toast('请先拾取或选中一个工作台');
});
$('btnAutoAll').addEventListener('click', () => {
  let n = 0;
  for (let i = 0; i < LINKS.length; i++)
    if (!state.routes.has(i) && state.placed.has(LINKS[i].from) && state.placed.has(LINKS[i].to))
      if (autoRoute(i)) n++;
  toast(n ? '⚡ 已自动规划 ' + n + ' 条路线' : '暂无可自动规划的路线（请先放置工作台）');
});
$('btnClearRoutes').addEventListener('click', () => {
  if (!state.routes.size) { toast('当前没有已规划的路线'); return; }
  state.routes.clear();
  refreshPanels();
  toast('已清空所有路线');
});
$('btnAnim').addEventListener('click', () => {
  state.anim.on = !state.anim.on;
  state.anim.parts = [];
  state.anim.acc.clear();
  $('btnAnim').textContent = state.anim.on ? '⏸ 停止演示' : '▶ 运行演示';
  $('btnAnim').classList.toggle('active', state.anim.on);
});
$('btnExport').addEventListener('click', () => {
  const data = {
    product: PRODUCT.name,
    floor: FLOOR,
    stations: [...state.placed.values()],
    routes: [...state.routes.entries()].map(([i, r]) => ({
      link: i, from: LINKS[i].from, to: LINKS[i].to, cells: r.cells, len: r.len
    })),
    score: state.score,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'slp-layout.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
  toast('💾 布局已导出 slp-layout.json');
});
$('btnReset').addEventListener('click', () => {
  if (!confirm('确定重置吗？所有摆放与路线都会被清除。')) return;
  state.placed.clear();
  state.routes.clear();
  state.selected = null;
  state.pick = null;
  state.anim.on = false;
  state.anim.parts = [];
  $('btnAnim').textContent = '▶ 运行演示';
  $('btnAnim').classList.remove('active');
  setMode('place');
  toast('已重置，重新开始吧！');
});

// ---------- 初始化 ----------
$('scFoot').innerHTML = '搬运时长 = Σ 物流量 ×（装卸 ' + HANDLING.fixedTime + 's + 距离 ÷ ' +
  HANDLING.speed + ' m/s' + (HANDLING.roundTrip ? '，含空车返回 ×2' : '') + '），单位「秒/件」；<br>' +
  '搬运效率 = 最短 ÷ 实际 × 100%；需搬运工 = ⌈每件搬运时长 ÷ 瓶颈节拍⌉。';
initDiagram();
bindPanel();
setMode('place');
requestAnimationFrame(tick);
toast('👋 欢迎！先拾取工作台摆放；评分与路线在「📊 评分 / 路线」面板（快捷键 3）');
