'use strict';
/* ============================================================
 * 数据文件：产品的工艺流程、标准时间、场地与工作台参数
 * 想改参数？只需要改这个文件！
 * ============================================================ */

// —— 产品信息 ——
const PRODUCT = {
  name: '儿童玩具小汽车',
  desc: '车身线与底盘线两条支线汇入总装，再检测、包装入库',
};

// —— 场地：宽 × 高（单位：米；1 格 = 1m × 1m）——
const FLOOR = { w: 28, h: 16 };

// —— 摆放规则：工作台之间至少保留的通道宽度（格）——
const MIN_GAP = 1;

/* —— 搬运参数（路线距离 → 搬运时长）——
 * fixedTime : 每趟装卸/取放时间（秒）
 * speed     : 搬运速度（米/秒，手推车水平）
 * roundTrip : 每趟是否含空车返回（true 时距离按 ×2 计）
 * 每趟搬运时长 = fixedTime + 距离 ÷ speed（×2 若含返程）
 * 每件成品在该路线的搬运时长 = 物流量 flow × 每趟时长 */
const HANDLING = {
  fixedTime: 5,
  speed: 0.8,
  roundTrip: true,
};

/* —— 工序（工作台）定义 ——
 * id    : 唯一编号（LINKS 中引用）
 * name  : 工序全名（流程图/卡片显示）
 * short : 短名（场地画布上显示）
 * icon  : 单字图标
 * equip : 所用设备
 * time  : 标准时间（秒/件；仓库为 0）
 * size  : 占地 [宽, 高]（米，即格数）
 * color : 显示颜色
 * line  : 所属支线
 * pos   : 左侧工艺流程图中节点的中心坐标（SVG） */
const STEPS = [
  { id: 'RM', name: '原材料库',           short: '原材料库', icon: '仓', equip: '—',      time: 0,  size: [6, 4], color: '#94a3b8', line: '库区',   pos: [95, 60] },
  { id: 'A1', name: '注塑成型（车身）',   short: '注塑·车身', icon: '注', equip: '注塑机', time: 25, size: [4, 3], color: '#f4a261', line: '车身线', pos: [225, 103] },
  { id: 'A2', name: '车身涂装',           short: '涂装',     icon: '涂', equip: '喷漆台', time: 30, size: [3, 3], color: '#e76f51', line: '车身线', pos: [455, 103] },
  { id: 'A3', name: '车身贴标',           short: '贴标',     icon: '标', equip: '移印机', time: 15, size: [2, 2], color: '#e9c46a', line: '车身线', pos: [685, 103] },
  { id: 'B1', name: '注塑成型（底盘·车轮）', short: '注塑·底盘', icon: '注', equip: '注塑机', time: 20, size: [4, 3], color: '#2a9d8f', line: '底盘线', pos: [225, 263] },
  { id: 'B2', name: '车轮装配',           short: '车轮装配', icon: '轮', equip: '压装机', time: 15, size: [3, 2], color: '#264653', line: '底盘线', pos: [455, 263] },
  { id: 'B3', name: '底盘总成',           short: '底盘总成', icon: '底', equip: '装配台', time: 20, size: [3, 3], color: '#90be6d', line: '底盘线', pos: [685, 263] },
  { id: 'C1', name: '总装配',             short: '总装配',   icon: '总', equip: '装配台', time: 40, size: [4, 4], color: '#8338ec', line: '总装线', pos: [225, 423] },
  { id: 'C2', name: '功能检测',           short: '功能检测', icon: '检', equip: '检测台', time: 20, size: [3, 3], color: '#3a86ff', line: '总装线', pos: [455, 423] },
  { id: 'C3', name: '包装',               short: '包装',     icon: '包', equip: '包装台', time: 15, size: [3, 3], color: '#ec4899', line: '总装线', pos: [685, 423] },
  { id: 'FG', name: '成品库',             short: '成品库',   icon: '成', equip: '—',      time: 0,  size: [6, 4], color: '#6b7280', line: '库区',   pos: [900, 423] },
];

/* —— 工艺流程（物流链接）——
 * from/to : 对应 STEPS 中的 id；路线只能按这里的顺序规划
 * flow    : 每生产 1 件成品该路线上的物流量（如 4 个车轮 → 4）
 * path    : （可选）流程图中这条连线的折线拐点
 * lbl     : （可选）流量标签位置
 * 物流强度等级：≥4 → A（绝对重要），2~3 → E（特别重要），1 → I（重要） */
const LINKS = [
  { from: 'RM', to: 'A1', flow: 1, path: [[95, 93], [95, 120]], lbl: [118, 116] },
  { from: 'RM', to: 'B1', flow: 1, path: [[95, 93], [95, 180]], lbl: [134, 205] },
  { from: 'A1', to: 'A2', flow: 1 },
  { from: 'A2', to: 'A3', flow: 1 },
  { from: 'A3', to: 'C1', flow: 1, path: [[610, 120], [595, 120], [595, 375], [300, 385]], lbl: [570, 150] },
  { from: 'B1', to: 'B2', flow: 4 },
  { from: 'B2', to: 'B3', flow: 1 },
  { from: 'B3', to: 'C1', flow: 1, lbl: [570, 303] },
  { from: 'C1', to: 'C2', flow: 1 },
  { from: 'C2', to: 'C3', flow: 1 },
  { from: 'C3', to: 'FG', flow: 1 },
];
