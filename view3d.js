import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// 各地图对应的 3D 模型文件
const MAP_MODELS = {
  steel: 'assets/DreamcoreFactory_New.fbx',   // 钢铁厂
  electronic: 'assets/E-Market_New.fbx',      // 电子城
};
// 【已弃用】旧版本用来配置各地图「绕 X 轴躺平角度」的固定值。
// 现在 loadModel() 会根据模型原始包围盒中最短的轴自动躺平（把它转到 Y 轴），
// 不再依赖这里的固定角度，保留常量仅为向前兼容旧引用。
const MAP_LAY_X = {
  steel: 0,
  electronic: 0,
};
let currentMapKey = 'steel';          // 当前地图，默认钢铁厂
const MODEL_URL = MAP_MODELS.steel;   // 兼容旧引用

// 模型水平朝向（绕 Y 轴），单位弧度。在原先 180° 基础上再转 180°，即 0°（正对）。
// 可在控制台用 modelYaw(0) / modelYaw(180) 实时切换调试。
let MODEL_YAW = Math.PI; // 新版模型（DreamcoreFactory_New / E-Market_New）需绕 Y 轴 180° 才与参考图对齐

// ===== 3D 模型可视化变换（供左下角「3D 模型」面板使用）=====
// 记录用户对模型施加的旋转/镜像/偏移增量。每次修改后调用 applyModelXform 重算 modelObject。
// - rotYaw90 / rotPitch90 / rotRoll90：绕 UE Z / X / Y 轴的 90° 步进旋转次数（可为负、可累加）
// - flipX / flipY / flipZ：镜像因子（+1 或 -1），沿 UE X / Y / Z 轴翻转
// - offsetX / offsetY / offsetZ：UE 单位（cm）的位置偏移
// 【按地图独立保存】每个地图的模型尺寸/朝向都不同，调整互不影响；
// 切换地图时会自动读取该地图自己的一套参数并刷新面板显示。
//
// 【各地图默认参数】在页面上用面板调好后，执行控制台命令 modelXformCode()
// 导出代码替换下面这张表即可固化。面板的「重置」会回到这里的默认值。
function makeBlankModelXform() {
  return {
    rotYaw90: 0, rotPitch90: 0, rotRoll90: 0,
    flipX: 1, flipY: 1, flipZ: 1,
    offsetX: 0, offsetY: 0, offsetZ: 0,
  };
}
const MODEL_XFORM_DEFAULTS = {
  // 钢铁厂 DreamcoreFactory_New.fbx：绕 UE X 轴 270°（= -90°）摆正，再沿 UE X/Y 平移对位
  steel:      { rotYaw90: 0, rotPitch90: 3, rotRoll90: 0, flipX: 1, flipY: 1, flipZ: 1, offsetX: 2460, offsetY: 30, offsetZ: 0 },
  // 电子城 E-Market_New.fbx：同样绕 UE X 轴 270° 摆正，沿 UE X 平移 600 对位
  electronic: { rotYaw90: 0, rotPitch90: 3, rotRoll90: 0, flipX: 1, flipY: 1, flipZ: 1, offsetX: 600,  offsetY: 0,  offsetZ: 0 },
};
// 按地图取默认参数的副本（未登记的地图返回全零默认）
function makeDefaultModelXform(mapKey) {
  const d = MODEL_XFORM_DEFAULTS[mapKey];
  return d ? Object.assign(makeBlankModelXform(), d) : makeBlankModelXform();
}
const MODEL_XFORMS = {
  steel: makeDefaultModelXform('steel'),
  electronic: makeDefaultModelXform('electronic'),
};
// 取当前地图的变换对象（地图 key 未登记时懒创建，保证不会返回 undefined）
function curModelXform() {
  if (!MODEL_XFORMS[currentMapKey]) MODEL_XFORMS[currentMapKey] = makeDefaultModelXform(currentMapKey);
  return MODEL_XFORMS[currentMapKey];
}

// 把当前地图的 MODEL_XFORM 应用到 modelObject。模型加载时也会调用一次以初始化。
function applyModelXform() {
  if (!modelObject) return;
  const X = curModelXform();
  // 旋转：从 MODEL_YAW（绕 UE Z）开始，再叠加用户的 3 个 90° 步进（绕 Z / X / Y）
  const qBase = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), MODEL_YAW);
  const qYaw90   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), X.rotYaw90   * Math.PI / 2);
  const qPitch90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), X.rotPitch90 * Math.PI / 2);
  const qRoll90  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), X.rotRoll90  * Math.PI / 2);
  // 组合顺序：先水平（Z），再垂直（X），最后前后（Y）
  const q = new THREE.Quaternion()
    .multiply(qYaw90).multiply(qPitch90).multiply(qRoll90).multiply(qBase);
  modelObject.quaternion.copy(q);
  // 镜像通过 scale 负值实现
  modelObject.scale.set(X.flipX, X.flipY, X.flipZ);
  // 偏移
  modelObject.position.set(X.offsetX, X.offsetY, X.offsetZ);
  modelObject.updateMatrixWorld(true);
}

// ===== 3D 模型显示状态（显隐 / 透明度）=====
// 与 MODEL_XFORMS（按地图独立的位姿）不同，这两项是全局视图设置，切换地图后保持。
let modelVisible = true;    // 模型是否显示
let modelOpacity = 1;       // 模型不透明度 0~1（<1 时自动开启材质透明）

// 应用模型显隐与透明度。模型加载完成、以及面板操作时都会调用。
function applyModelDisplay() {
  if (!modelObject) return;
  modelObject.visible = modelVisible;
  const op = Math.max(0, Math.min(1, modelOpacity));
  modelObject.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (!m) return;
      // 记录材质原始的 transparent/depthWrite，便于恢复到完全不透明状态
      if (m.__origTransparent === undefined) {
        m.__origTransparent = !!m.transparent;
        m.__origDepthWrite = m.depthWrite !== false;
      }
      if (op >= 1) {
        m.transparent = m.__origTransparent;
        m.opacity = 1;
        m.depthWrite = m.__origDepthWrite;
      } else {
        m.transparent = true;
        m.opacity = op;
        // 半透明时关闭深度写入，避免自身面片互相遮挡产生的斑驳
        m.depthWrite = false;
      }
      m.needsUpdate = true;
    });
  });
}

// 把当前地图的偏移值同步到面板输入框（切换地图 / 重置后调用）
function syncModelPanelInputs() {
  const X = curModelXform();
  const map = { modelOffX: 'offsetX', modelOffY: 'offsetY', modelOffZ: 'offsetZ' };
  Object.keys(map).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = String(X[map[id]]);
  });
}

// ===== 初始视角配置 =====
// 调好视角后按 P 键，把控制台打印的参数填到这里即可固定初始视角。
// pos: 相机世界坐标 [x, y, z]；yaw/pitch: 朝向角度（单位：度）。
// 保持为 null 时使用自动俯视视角（接近 2D 俯视截图）。
let INITIAL_VIEW = { pos: [3761.8, 21953.7, -8996.0], yaw: -0.0, pitch: -82.40 };
// 例如：{ pos: [0, 5000, 100], yaw: 0, pitch: -89 }
// INITIAL_VIEW 是针对旧 factory.fbx 尺寸手调的固定视角，新模型/UE 坐标空间下已不适用，
// 一律走「按当前模型包围盒自适应的俯视视角」。
let useInitialView = false;

// 记录初始视角，供按 R 复位
let initialState = null;

let initialized = false;
let renderer, scene, camera;
let perspCamera = null, orthoCamera = null;
let projectionMode = 'persp';    // 'persp' | 'ortho'
let orthoZoom = 1;               // 正交视口缩放（越大越小的视野 = 放大画面）
let ueRoot = null;               // UE 坐标空间根节点，所有资源作为它的子对象
let rafId = null;
let running = false;
let clock;

// ===== 相机朝向状态（UE 风格飞行控制）=====
let yaw = 0;      // 绕世界 Y 轴
let pitch = 0;    // 绕相机 X 轴
let moveSpeed = 1000;   // 每秒移动距离，frameModel 中按模型尺寸设置
let panScale = 1;       // 中键平移比例
let dollyStep = 500;    // 滚轮前进步长

// 基准值（frameModel 按模型尺寸算出），实际速度 = 基准 × 用户倍率
let baseMoveSpeed = 1000;
let basePanScale = 1;
let baseDollyStep = 500;
// 用户通过界面滑块调节的灵敏度倍率
let moveMul = 1;
let panMul = 1;
let zoomMul = 1;

// ===== 场景点位（3D）配置与状态 =====
// 数据来源：scenepoints.js（window.SCENE_POINTS[mapId][类别] = [[x, y, z], ...]），
// 由 UE 关卡按 Actor 蓝图类名采集，因此「场景点位只对当前选中的难度档位生效」。
// 各类别的 icon 复用 UE 工程里的小地图图标（已导出到 assets/）。
// iconScale：图标相对基准尺寸 markerSize 的倍率（副本入口放大到 2 倍，其余为 1 倍）。
// iconTint ：图标染色（Sprite 材质 color，与贴图颜色相乘）；不填则保持贴图原色。
const SCENE_CATEGORIES = [
  {
    key: 'extraction', name: '撤离点',
    icon: 'assets/extraction.png', iconScale: 1,
    // 触发范围：BP_EvacuationFinalLeavePoint 的 SphereLarge
    // SphereRadius=150 × 组件缩放 1.2 = 180（cm）
    ring: 180, ringColor: '#2ee66b',
  },
  {
    key: 'entry', name: '副本入口',
    icon: 'assets/EnterDoor.png', iconScale: 2, iconTint: '#2ee66b',
    ring: 0, ringColor: '#ffd166',
  },
  {
    key: 'chest_spawn', name: '宝箱点位',
    icon: 'assets/Box.png', iconScale: 1,
    ring: 0, ringColor: '#4dd2ff',
  },
  {
    key: 'born', name: '出生点位',
    icon: 'assets/Born.png', iconScale: 1, iconTint: '#2ee66b',
    ring: 0, ringColor: '#a55eea',
  },
];
// 运行时状态：{ [key]: { group, visible, markers[] } }
const sceneState = {};
SCENE_CATEGORIES.forEach((c) => {
  sceneState[c.key] = { group: null, visible: false, markers: [] };
});
// 当前应显示哪个难度档位的场景点位：
//   地图筛选选了具体 map_id → 用它；选「全部」→ 用当前地图的第一个档位
function currentSceneMapId() {
  if (heatMapFilter !== 'all') return Number(heatMapFilter);
  const ids = Object.keys(HEAT_MAP_TO_LEVEL).map(Number)
    .filter((id) => HEAT_MAP_TO_LEVEL[id] === currentMapKey);
  return ids.length ? ids[0] : null;
}
// 取某类别在当前难度下的点位数组
function sceneRaw(key) {
  const mid = currentSceneMapId();
  if (mid === null) return [];
  const all = window.SCENE_POINTS || {};
  const b = all[mid] || all[String(mid)];
  return (b && b[key]) || [];
}

// UE 坐标与场景坐标之间的整体校正偏移（单位同 UE，cm）。正常情况下应保持为 0。
// 对不齐时可在浏览器控制台调试：
//   ueOffset(x, y, z)    —— 直接设置偏移并重建场景点位
//   ueOffset()           —— 打印当前偏移值
let UE_OFFSET = { x: 0, y: 0, z: 0 };
let modelObject = null;           // 模型根对象，用于射线拾取
let markerSize = 200;             // 场景点位图标尺寸，frameModel 中按模型尺寸设置
const sceneTextures = {};         // icon 路径 -> THREE.Texture（复用）
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// ===== 2D 参考图平面（把小地图叠进 3D 场景用于对齐）=====
// 进入 3D 视图后，把当前地图的小地图贴图作为一块水平平面铺在模型下方，
// 按 outdoor_mini_map_center / ortho_width 精确定位，半透明显示。
//
// 【只读】参考图不可被选中、不可拖动 —— 它的位置/尺寸由 MAP_META 精确决定，
// 手动移动会破坏与数据点的对齐关系。界面上只提供「显隐」与「透明度」两个开关
// （右上角「参考图」面板）。
//
// 如需临时调试对齐，可用控制台命令：
//   refShow(true/false)  显隐        refOpacity(0~1)   透明度
//   refScale(s)          整体缩放     refSize(w,h)      直接设定平面宽高
//   refMove(x,y,z)       设定位置     refRotate(deg)    绕 UE Z 轴设定角度
//   refFlipX() / refFlipY()          水平/竖直镜像翻转
//   refDir(0~3) / refRot180()        穷举方向组合
//   refPrint()           打印当前参数
let refPlane = null;              // THREE.Group：外层控 Z 旋转，内层 mesh 承载贴图
let refMesh = null;               // 贴图 mesh
let refTexture = null;
// refParams：参考图在 UE 坐标空间里的姿态 —— x/y/z 是 UE 世界坐标（cm），rotY 是绕 UE Z 轴的角度（度）
// 【已实测确认的方向组合】rotY=180 + flipY=-1（即 refDir 的 #1「仅上下翻」）：
// 此组合下玩家数据点与小地图上的建筑完全吻合。可用控制台 refDir() / refRot180() 重新穷举验证。
// flipX=-1：配合 MIRROR_X（数据点同步做 X 镜像），实现「2D 图 + 热力点位」整体左右翻转。
const refParams = { x: 0, y: 0, z: 0, rotY: 180, w: 0, h: 0, flipX: -1, flipY: -1, opacity: 0.6, visible: true };

// ===== 各地图小地图的 UE 元数据（对应 DA_CodeEvacuationMinimapConfig.MapGroupMinimapInfoMap）=====
// 数据点位不与 3D 模型相关，只与 2D 小地图相关。按游戏项目官方约定：
//   image up    == UE -Y   （小地图图片"上方" = UE 的 -Y）
//   image right == UE +X   （小地图图片"右方" = UE 的 +X）
// 每个地图组需要三个字段（可从 UE 项目 DA 资产里查到）：
//   orthoWidth : SceneCapture2D 的正交宽度（cm），等于图片横向所覆盖的 UE 距离
//   centerX/Y  : 图片中心对应的 UE 世界坐标（outdoor_mini_map_center 的 X/Y）
// 【钢铁厂 902】/【电子城 903】的具体数值请从 DA_CodeEvacuationMinimapConfig 里查后填入，
// 未填时会退化为「按 refParams 尺寸粗略匹配」（等价于旧逻辑）。
const MAP_META = {
  // 钢铁厂 902（来自 DA_CodeEvacuationMinimapConfig · MapGroupMinimapInfoMap[902]）
  //   OrthoWidth = 15000 cm；OutdoorMiniMapCenter = (X=1240, Y=865, Z=0)
  steel:      { orthoWidth: 15000, centerX: 1240,     centerY: 865   },
  // 电子城 903（来自 DA_CodeEvacuationMinimapConfig · MapGroupMinimapInfoMap[903]）
  //   OrthoWidth = 11000 cm；OutdoorMiniMapCenter = (X=307.226, Y=-1232, Z=0)
  electronic: { orthoWidth: 11000, centerX: 307.226,  centerY: -1232 },
};

// ===== 热力图「地图筛选」（按上报数据里的 map_id 过滤）=====
// 数据源 heatdata.js 每项为 [x, y, z, mapId]。mapId 对应关卡难度分档：
const HEAT_MAP_NAMES = {
  39: '新秀电子城', 35: '高手电子城', 36: '精英电子城',
  40: '高手钢铁厂', 41: '精英钢铁厂', 42: '大师钢铁厂',
  48: '怪物教学顺风耳', 49: '怪物教学小跟班',
};
// 各 map_id 归属哪张 3D 地图（地图筛选下拉只列出当前地图的档位）
//   电子城：39 新秀 / 35 高手 / 36 精英 / 48 怪物教学顺风耳 / 49 怪物教学小跟班
//   钢铁厂：40 高手 / 41 精英 / 42 大师
const HEAT_MAP_TO_LEVEL = {
  39: 'electronic', 35: 'electronic', 36: 'electronic',
  48: 'electronic', 49: 'electronic',
  40: 'steel', 41: 'steel', 42: 'steel',
};
let heatMapFilter = 'all';   // 'all'（当前地图全部档位）或具体 map_id 数字

// ===== 数据时间轴（按事件时间 dtEventTime 过滤）=====
// 数据点第 5 个字段 p[4] = 「相对 window.HEAT_TIME_BASE 的秒偏移」（由 csv2heatdata.py 写入）；
// window.HEAT_TIME_BASE 为该数据集最早事件的 Unix 时间戳（秒）。缺字段或 <0 视为未知时间。
let timeFilterEnabled = false;  // 「按照时间显示」，默认「否」（玩家端默认直接显示全部数据）
let timeUnitSec = 43200;        // 时间单位（秒）：21600=6h / 43200=12h / 86400=1天
let timeWindowStart = 0;        // 当前时间窗起点（相对 base 的秒偏移）
let dataTimeMin = 0;            // 数据集最早事件（相对偏移）
let dataTimeMax = 0;            // 数据集最晚事件（相对偏移）
let dataAlignedMin = 0;         // 时间轴起点 = 首日 00:00（相对偏移，通常为负）
let dataAlignedMax = 0;         // 时间轴终点 = 终日 24:00（次日 00:00，相对偏移）
let hasTimeData = false;        // 数据是否带有效时间字段
let timeStepIndex = 0;          // 当前时间轴档位（0-based，窗口起点 = dataAlignedMin + index*unit）

function heatTimeBase() { return Number(window.HEAT_TIME_BASE) || 0; }

// 「无时间」哨兵值：用极大负数标记，避免与「早于基准的合法负偏移」（如快照数据早于 base 几十秒）混淆
const TIME_NONE = -1e9;

// 判断某点是否落在当前时间窗内。未启用时间过滤 / 无时间数据 / 点无时间 → 恒 true。
function inTimeWindow(p) {
  if (!timeFilterEnabled || !hasTimeData) return true;
  const t = Number(p[4]);
  if (!isFinite(t) || t <= TIME_NONE) return true;   // 未知时间的点始终显示
  return t >= timeWindowStart && t < timeWindowStart + timeUnitSec;
}

// 按 heatMapFilter + 时间窗过滤原始点数组（每项 [x,y,z,mapId,(tOffset)]）
// heatMapFilter = 'all' 时，只保留「属于当前 3D 地图」的档位，避免把另一张图的数据画进来
function filterByMapId(raw) {
  if (heatMapFilter === 'all') {
    return raw.filter((p) => HEAT_MAP_TO_LEVEL[Number(p[3])] === currentMapKey && inTimeWindow(p));
  }
  const want = Number(heatMapFilter);
  return raw.filter((p) => Number(p[3]) === want && inTimeWindow(p));
}

// 统计数据里各 map_id 的点数（用于在下拉里标注数量）
// 遍历 HEAT_DATA 的全部类别，避免用兼容数组导致重复计数
function countHeatMapIds() {
  const stat = {};
  const data = window.HEAT_DATA || {};
  Object.keys(data).forEach((k) => {
    const arr = data[k];
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const m = Number(arr[i][3]);
      if (!isNaN(m)) stat[m] = (stat[m] || 0) + 1;
    }
  });
  return stat;
}

const keys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false };

// 鼠标交互状态
let rotating = false;   // 左键 / 右键：旋转视角
let panning = false;    // 中键：平移
let lastX = 0, lastY = 0;
let downX = 0, downY = 0, downBtn = -1; // 按下时的位置/按键，用于区分单击与拖动

const container = document.getElementById('view3d');
const canvas = document.getElementById('canvas3d');
const loaderEl = document.getElementById('loader3d');
const loaderText = document.getElementById('loader3dText');
const refPanel = document.getElementById('refPanel');

// ===== 玩家数据（3D 标签）=====
// 从玩家日志解析出的行为事件，坐标为 UE 世界坐标（cm），与撤离点 ue 路径同一坐标系，
// 载入时经 modelObject.localToWorld 映射到 three.js 场景。左侧「玩家数据」按钮控制显隐。
let labelRenderer = null;           // CSS2DRenderer：渲染 HTML 文字标签
let playerGroup = null;             // 承载所有玩家数据点（sprite 圆点）
const playerLabels = [];            // 所有 CSS2DObject 文字标签，随显隐一起切换
const playerDots = [];              // 所有事件点的圆点 Sprite（与 playerLabels 一一对应，供逐个播放）
const playerPoints = [];            // 所有事件点的 three 世界坐标，供包围盒/聚焦/诊断用
let playerPathLine = null;          // 时间顺序轨迹连线（播放时按 drawRange 逐段生长）
let playerDataVisible = false;      // 当前是否显示玩家数据
let playerDotTexture = null;

// ===== 玩家行为数据（按「上报类型 + para3」细分的类别）=====
// 数据源：heatdata.js -> window.HEAT_DATA[key] = [[x, y, z, mapId], ...]
// 每个类别独立开关、独立颜色，颜色可在「数据内容」面板点色块自定义。
// 宝箱三分类（iReportType=5025，按 para3 的宝箱配置 id 判定）：
//   chest_player  para3 = 0（玩家宝箱）
//   chest_monster para3 ∈ 1040701~705 / 1040801~805 / 1040901~905 / 1041001~005（怪物宝箱）
//   chest_normal  其余 id（常规宝箱）
const BEHAVIOR_CATEGORIES = [
  { key: 'chest_player',  name: '开启玩家宝箱', color: '#ffd166' },
  { key: 'chest_monster', name: '开启怪物宝箱', color: '#f97316' },
  { key: 'chest_normal',  name: '开启常规宝箱', color: '#4dd2ff' },
  { key: 'near_death',    name: '玩家濒死',     color: '#ff9f43' },
  { key: 'rescue',        name: '救援行为',     color: '#a55eea' },
  { key: 'death',         name: '玩家死亡',     color: '#ff3b3b' },
  { key: 'kill',          name: '造成击杀',     color: '#ff5edb' },
];
// ===== 其他数据（与「玩家行为」同级的独立分组）=====
// 数据源：otherdata.js -> window.OTHER_DATA[key] = [[x, y, z, mapId, tOffset], ...]
// 结构与玩家行为点云完全一致，复用同一套散点 / 热力图 / 时间轴渲染机制。
const OTHER_CATEGORIES = [
  { key: 'snapshot', name: '一分钟快照', color: '#a29bfe' },
];
// 所有「点云类」类别（玩家行为 + 其他数据），渲染 / 过滤 / 聚焦统一遍历此列表
const POINT_CATEGORIES = BEHAVIOR_CATEGORIES.concat(OTHER_CATEGORIES);
// 运行时状态：{ [key]: { group, points3d, visible, color, built } }
const behaviorState = {};
POINT_CATEGORIES.forEach((c) => {
  behaviorState[c.key] = {
    // 面向玩家的默认：一分钟快照默认打开，其余默认关闭
    group: null, points3d: [], visible: (c.key === 'snapshot'), color: c.color, built: false,
  };
});
// 取某类别的原始数据数组（玩家行为取 HEAT_DATA，其他数据取 OTHER_DATA）
function behaviorRaw(key) {
  return (window.HEAT_DATA && window.HEAT_DATA[key])
    || (window.OTHER_DATA && window.OTHER_DATA[key])
    || [];
}

// ===== 玩家数据播放（按时间顺序逐个显示）=====
let pdPlayTimer = null;             // 播放定时器
let pdPlayIndex = 0;                // 下一个要显示的事件序号
let PD_OFFSET = { x: 0, y: 0, z: 0 }; // 玩家数据坐标校正偏移（对不齐时用 pdNudge 微调）
let PD_PATH_LIFT = 0;                 // 轨迹线额外抬升（three 世界单位），叠加在默认抬升之上，用 pdPathLift 调

// ===== UE → 模型局部坐标 适配层 =====
// 模型是 Blender 中转导出的 FBX（右手系/米），玩家数据是 UE 世界坐标（左手系/厘米），
// 二者除了模型自带的旋转外，往往还差「轴镜像 / 轴交换 / 单位缩放」。这里把 UE 坐标先按
// PD_XFORM 变换成模型局部坐标，再交给 modelObject.localToWorld 映射到 three.js 世界。
// map：模型局部 [x,y,z] 各自取 UE 的哪个轴，前缀 '-' 表示取反（镜像）。例如 ['x','-y','z'] 表示 Y 轴镜像。
// scale：映射后整体缩放（UE 单位→模型单位，通常 1；若模型是米、数据是厘米则为 0.01）。
//
// 【新策略】整个场景使用 UE 坐标空间（ueRoot 内），所以 UE 坐标 → 场景坐标就是恒等映射。
// 数据点直接以 UE 世界坐标加到 ueRoot 里即可，ueRoot 的固定旋转会完成 Z-up→Y-up 的显示。
// 保留 PD_OFFSET 微调（UE 单位 cm）用于校正数据本身的整体平移偏差。
let PD_AUTO = true;
let PD_XFORM = { map: ['x', 'y', 'z'], scale: 1 }; // 恒等（保留字段以免其它引用报错）

// ===== 左右镜像（2D 参考图 + 热力点位 同步翻转）=====
// 以小地图中心（MAP_META 的 centerX）为轴做 X 方向镜像：
//   - 参考图：通过 refParams.flipX = -1 翻转贴图（绕自身中心，中心即 centerX）
//   - 数据点：x' = 2 * centerX - x（同样绕 centerX 翻转，保证与参考图相对关系不变）
// 3D 模型不参与该镜像（模型仅作参考，可用「3D 模型」面板的左右镜像单独处理）。
// 控制台可用 mirrorX() 实时切换。
let MIRROR_X = true;

// UE 世界坐标 → ueRoot 局部坐标（含 PD_OFFSET 校正与可选的左右镜像）
// 返回值直接用于挂到 ueRoot 下的对象位置。
function ueToLocal(ev) {
  let x = ev.x;
  if (MIRROR_X) {
    const meta = MAP_META[currentMapKey] || MAP_META.steel;
    const cx = (meta && typeof meta.centerX === 'number') ? meta.centerX : 0;
    x = 2 * cx - x;
  }
  return new THREE.Vector3(
    x + PD_OFFSET.x,
    ev.y + PD_OFFSET.y,
    ev.z + PD_OFFSET.z
  );
}
// 兼容旧名字
function ueToWorld(ev) { return ueToLocal(ev); }

// 控制台切换「2D 参考图 + 热力点位」的左右镜像：mirrorX() 切换 / mirrorX(true|false) 指定
window.mirrorX = function (on) {
  MIRROR_X = (on === undefined) ? !MIRROR_X : !!on;
  // 参考图跟随：镜像开启时贴图也左右翻，保证与数据点一致
  refParams.flipX = MIRROR_X ? -1 : 1;
  applyRefPlane();
  if (modelObject) {
    rebuildBehaviors(true);
    buildPlayerData();
    rebuildScenePoints();
    applyDisplayMode();
  }
  console.log('%c[左右镜像] ' + (MIRROR_X ? '已开启' : '已关闭') +
    '（2D 参考图 + 热力点位同步翻转）', 'color:#f5c542;font-weight:bold');
  return MIRROR_X;
};

const PD_TYPES = {
  chest: { name: '户外开箱', color: 0xf5c542, cls: 'pd-chest' },
  jump:  { name: '使用跳板', color: 0x4dd2ff, cls: 'pd-jump' },
  snap:  { name: '分钟快照', color: 0x4dff88, cls: 'pd-snap' },
  abn:   { name: '异常状态', color: 0xff5d6c, cls: 'pd-abn' },
};

// 来源日志：CodeEvacuationLevelAnalyticsDebug（分钟快照 5027 / 户外开箱 5025 / 户外异常状态 5029）
// 无坐标事件（户外时长 5022、基础探针）已按位置维度剔除
const PLAYER_EVENTS = [
  { ty: 'snap',  x: -490.7, y: 4364.8, z: 33.5, s: '战斗 · 撤离' },
  { ty: 'chest', t: 114.169, id: '1040801', x: 2281.0, y: 4412.2, z: 23.0 },
  { ty: 'snap',  x: 3157.3, y: 3481.8, z: 59.6, s: '生命无敌 · 耐力停止恢复 · 隐身 · 战斗 · 撤离 · 无限眩晕' },
  { ty: 'chest', t: 150.223, id: '1040003', x: 4541.4, y: 1126.6, z: 23.0 },
  { ty: 'chest', t: 167.602, id: '1042002', x: 2836.0, y: 312.5, z: 23.0 },
  { ty: 'chest', t: 176.217, id: '1042002', x: 2513.2, y: 89.4, z: 61.4 },
  { ty: 'chest', t: 180.001, id: '1040801', x: 2500.4, y: 81.5, z: 61.4 },
  { ty: 'snap',  x: 2500.4, y: 81.5, z: 61.4, s: '战斗 · 撤离' },
  { ty: 'chest', t: 215.237, id: '1042002', x: 578.9, y: -574.1, z: 192.5 },
  { ty: 'snap',  x: -3256.0, y: -3090.2, z: 874.0, s: '耐力停止恢复 · 移动 · 奔跑 · 战斗 · 撤离' },
  { ty: 'chest', t: 243.254, id: '1042002', x: -3134.0, y: -2792.6, z: 927.5 },
  { ty: 'chest', t: 262.785, id: '1042002', x: -3528.4, y: -255.1, z: 23.0 },
  { ty: 'chest', t: 293.067, id: '1042002', x: -1513.1, y: 2371.7, z: 23.0 },
  { ty: 'snap',  x: -1400.5, y: 2915.7, z: 62.2, s: '耐力停止恢复 · 跳跃 · 移动 · 战斗 · 撤离 · 腾空中' },
  { ty: 'chest', t: 315.100, id: '1040003', x: 75.4, y: 1358.9, z: -196.8 },
  { ty: 'chest', t: 351.027, id: '1040801', x: 2529.5, y: 3631.7, z: 23.0 },
  { ty: 'snap',  x: 1916.5, y: 2356.1, z: 61.5, s: '开启宝箱 · 战斗 · 撤离' },
  { ty: 'chest', t: 360.975, id: '1042002', x: 1916.5, y: 2356.1, z: 61.5 },
  { ty: 'abn',   t: 372.263, x: 2278.2, y: 1699.7, z: 23.0, s: '撤离' },
];

function getSize() {
  return { w: container.clientWidth, h: container.clientHeight };
}

function initScene() {
  const { w, h } = getSize();
  clock = new THREE.Clock();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // 文字标签渲染器（叠在 WebGL 画布之上，用 HTML 渲染玩家数据标签）
  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(w, h);
  labelRenderer.domElement.className = 'label3d-layer';
  container.appendChild(labelRenderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0f14);
  scene.fog = new THREE.Fog(0x0b0f14, 2000, 12000);

  // ===== UE 坐标空间根节点（关键设计）=====
  // 让整个游戏世界（3D 模型 / 2D 参考图 / 数据点）都直接使用 UE 原生坐标，不做任何变换。
  // three.js 场景内部仍是 Y-up 右手系，通过给 ueRoot 一次固定的 rotation + scale 完成
  // 「UE 坐标空间 → three 显示空间」的映射：
  //   three_x = ue_x           （X 保持）
  //   three_y = ue_z           （UE 高度 Z 映射到 three 的 Y）
  //   three_z = -ue_y          （UE Y 反向，同时补偿左手→右手系手性）
  // 等价于：绕 X 轴 -90° 旋转 (0,1,0 → 0,0,-1)（应用后 UE(0,1,0) → three(0,0,-1)；UE(0,0,1) → three(0,1,0)）。
  // 所有加进 ueRoot 的对象（模型/参考图/数据点）都可以直接用 UE 世界坐标定位，永不出错。
  ueRoot = new THREE.Group();
  ueRoot.rotation.x = -Math.PI / 2;   // UE Z-up → three Y-up
  scene.add(ueRoot);

  // ===== 双相机（透视 / 正交）=====
  // 两个相机共享同一个 position / quaternion（yaw/pitch/移动逻辑操作 camera 引用），
  // 切换投影只是重新指向 perspCamera 或 orthoCamera，保证视角不跳变。
  perspCamera = new THREE.PerspectiveCamera(50, w / h, 1, 50000);
  perspCamera.position.set(1500, 1500, 1500);
  // 正交相机的 left/right/top/bottom 会在 onResize / setProjection 里根据画布和 zoom 重算
  orthoCamera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, -50000, 50000);
  orthoCamera.position.copy(perspCamera.position);
  orthoCamera.quaternion.copy(perspCamera.quaternion);
  camera = perspCamera;

  // ===== 灯光 =====
  const hemi = new THREE.HemisphereLight(0xbcd0e6, 0x2a2f38, 1.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1, 2, 1.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 10;
  key.shadow.camera.far = 20000;
  key.shadow.bias = -0.0005;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9fb4d0, 0.6);
  fill.position.set(-1, 0.6, -1);
  scene.add(fill);

  // ===== 网格地面参考 =====
  const grid = new THREE.GridHelper(20000, 40, 0x3a4452, 0x1e252e);
  grid.position.y = -1;
  scene.add(grid);

  bindControls();
  bindRefPanel();
  bindSpeedPanel();
  bindModelPanel();
  bindHeatmapPanel();
  window.addEventListener('resize', onResize);
}

// 根据用户倍率把基准速度换算成实际速度
function applySpeedMul() {
  moveSpeed = baseMoveSpeed * moveMul;
  panScale = basePanScale * panMul;
  dollyStep = baseDollyStep * zoomMul;
}

// 绑定「操控速度」面板的三个滑块
function bindSpeedPanel() {
  const bind = (sliderId, valId, setter) => {
    const slider = document.getElementById(sliderId);
    const valEl = document.getElementById(valId);
    if (!slider) return;
    const update = () => {
      const v = parseFloat(slider.value);
      setter(v);
      applySpeedMul();
      if (valEl) valEl.textContent = v.toFixed(1) + 'x';
    };
    slider.addEventListener('input', update);
    // 避免滑块拖动时触发画布交互
    slider.addEventListener('pointerdown', (e) => e.stopPropagation());
    update();
  };
  bind('speedMove', 'speedMoveVal', (v) => { moveMul = v; });
  bind('speedZoom', 'speedZoomVal', (v) => { zoomMul = v; });
  bind('speedPan', 'speedPanVal', (v) => { panMul = v; });
}

// 绑定「3D 模型」调整面板：3 个 90° 旋转按钮 + 3 个镜像按钮 + 3 个偏移输入框 + 重置
function bindModelPanel() {
  const panel = document.getElementById('modelPanel');
  if (!panel) return;
  // 面板内部所有交互都不应触发画布拾取
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  const onClick = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { fn(); applyModelXform(); });
  };

  // 以下所有调整都只作用于「当前地图」的那一套参数（curModelXform()）
  // 三个 90° 旋转（每次按累加一次，可循环 4 次回到原位）
  onClick('modelBtnRotYaw',   () => { const X = curModelXform(); X.rotYaw90   = (X.rotYaw90   + 1) % 4; });
  onClick('modelBtnRotPitch', () => { const X = curModelXform(); X.rotPitch90 = (X.rotPitch90 + 1) % 4; });
  onClick('modelBtnRotRoll',  () => { const X = curModelXform(); X.rotRoll90  = (X.rotRoll90  + 1) % 4; });

  // 三个镜像按钮（点一次翻转一次）
  onClick('modelBtnFlipX', () => { curModelXform().flipX *= -1; });
  onClick('modelBtnFlipZ', () => { curModelXform().flipZ *= -1; });
  onClick('modelBtnFlipY', () => { curModelXform().flipY *= -1; });

  // 三个偏移输入框（既支持键盘输入，也支持鼠标横向拖动整个输入框以增量调整）
  const bindOffset = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(curModelXform()[key]);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!isNaN(v)) { curModelXform()[key] = v; applyModelXform(); }
    });
    // 拖动：鼠标水平拖动整个输入框视为微调（step 由 el.step 决定，默认 10）
    let dragging = false, startX = 0, startVal = 0, step = 10;
    el.addEventListener('pointerdown', (e) => {
      // 单击输入框内不进入拖动；按住并水平拖动才触发（阈值 3px）
      if (document.activeElement === el) return;
      dragging = true;
      startX = e.clientX;
      startVal = parseFloat(el.value) || 0;
      step = parseFloat(el.step) || 10;
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < 3) return;
      const v = startVal + Math.round(dx) * step * 0.1;
      el.value = String(Math.round(v));
      curModelXform()[key] = parseFloat(el.value);
      applyModelXform();
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture && el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  };
  bindOffset('modelOffX', 'offsetX');
  bindOffset('modelOffY', 'offsetY');
  bindOffset('modelOffZ', 'offsetZ');

  // 首次绑定后同步一次，让输入框显示当前地图的默认偏移值
  syncModelPanelInputs();

  // ===== 显示模型（勾选）=====
  const chkShow = document.getElementById('modelShow');
  if (chkShow) {
    chkShow.checked = modelVisible;
    chkShow.addEventListener('change', () => {
      modelVisible = chkShow.checked;
      applyModelDisplay();
    });
  }

  // ===== 模型透明度（滑块 + 数值输入，双向同步）=====
  const opRange = document.getElementById('modelOpacityRange');
  const opInput = document.getElementById('modelOpacityInput');
  const setModelOpacity = (v, from) => {
    let val = parseFloat(v);
    if (isNaN(val)) return;
    val = Math.max(0, Math.min(1, val));
    modelOpacity = val;
    if (opRange && from !== 'range') opRange.value = String(val);
    if (opInput && from !== 'input') opInput.value = val.toFixed(2);
    applyModelDisplay();
  };
  if (opRange) {
    opRange.value = String(modelOpacity);
    opRange.addEventListener('input', () => setModelOpacity(opRange.value, 'range'));
  }
  if (opInput) {
    opInput.value = modelOpacity.toFixed(2);
    opInput.addEventListener('input', () => setModelOpacity(opInput.value, 'input'));
    opInput.addEventListener('change', () => setModelOpacity(opInput.value, 'input'));
  }

  // 重置：当前地图的位姿回默认值，并把显隐/透明度恢复为「显示 + 不透明」
  onClick('modelBtnReset', () => {
    MODEL_XFORMS[currentMapKey] = makeDefaultModelXform(currentMapKey);
    syncModelPanelInputs();
    modelVisible = true;
    modelOpacity = 1;
    if (chkShow) chkShow.checked = true;
    if (opRange) opRange.value = '1';
    if (opInput) opInput.value = '1.00';
    applyModelDisplay();
  });
}

// 重建「地图筛选」下拉：只列出属于当前 3D 地图（钢铁厂 / 电子城）的难度档位
// 切换顶部地图时会重新调用；若当前筛选值不属于新地图，自动回落到「全部」
function rebuildMapFilterOptions() {
  const sel = document.getElementById('heatMapFilter');
  if (!sel) return;
  const stat = countHeatMapIds();
  // 只保留归属当前地图、且数据里确实出现过的 map_id
  const known = Object.keys(HEAT_MAP_NAMES).map(Number);
  const ids = Object.keys(stat).map(Number)
    .filter((id) => HEAT_MAP_TO_LEVEL[id] === currentMapKey)
    .sort((a, b) => {
      const ka = known.indexOf(a), kb = known.indexOf(b);
      if (ka >= 0 && kb >= 0) return ka - kb;
      if (ka >= 0) return -1;
      if (kb >= 0) return 1;
      return a - b;
    });
  const total = ids.reduce((s, id) => s + (stat[id] || 0), 0);

  sel.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = `全部（${total}）`;
  sel.appendChild(optAll);
  ids.forEach((id) => {
    const opt = document.createElement('option');
    opt.value = String(id);
    opt.textContent = `${id} ${HEAT_MAP_NAMES[id] || '未知关卡'}（${stat[id]}）`;
    sel.appendChild(opt);
  });

  // 当前筛选值若不在新地图的档位里，回落为「全部」
  if (heatMapFilter !== 'all' && ids.indexOf(Number(heatMapFilter)) < 0) {
    heatMapFilter = 'all';
  }
  sel.value = heatMapFilter;
}

// ===== 数据时间轴：读取数据 → 同步时间范围 → 绑定交互 =====

// 扫描 HEAT_DATA 全部类别，统计有效时间偏移的 min/max，同步时间轴范围。
// 读取数据来源表格（heatdata.js）时调用一次即可。
function computeDataTimeRange() {
  const data = window.HEAT_DATA || {};
  let mn = Infinity, mx = -Infinity, found = false;
  const scan = (dataset) => {
    if (!dataset) return;
    Object.keys(dataset).forEach((k) => {
      const arr = dataset[k];
      if (!arr) return;
      for (let i = 0; i < arr.length; i++) {
        const t = Number(arr[i][4]);
        if (!isFinite(t) || t <= TIME_NONE) continue;
        if (t < mn) mn = t;
        if (t > mx) mx = t;
        found = true;
      }
    });
  };
  scan(data);
  scan(window.OTHER_DATA);
  hasTimeData = found;
  if (found) {
    dataTimeMin = mn;
    dataTimeMax = mx;
    // 时间轴对齐到自然日：起点 = 首日 00:00，终点 = 终日次日 00:00（含终日 23:59）
    dataAlignedMin = dayStartOffset(mn);
    dataAlignedMax = dayEndOffset(mx);
    timeStepIndex = 0;
    timeWindowStart = dataAlignedMin;   // 默认窗口从首日 00:00 开始（第 0 档）
  } else {
    dataTimeMin = dataTimeMax = dataAlignedMin = dataAlignedMax = timeWindowStart = 0;
    timeStepIndex = 0;
  }
}

// 把「相对偏移秒」对齐到当日 00:00，返回对齐后的相对偏移
function dayStartOffset(offsetSec) {
  const d = new Date((heatTimeBase() + offsetSec) * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.round(d.getTime() / 1000) - heatTimeBase();
}

// 把「相对偏移秒」对齐到次日 00:00（即当日 24:00，含 23:59），返回对齐后的相对偏移
function dayEndOffset(offsetSec) {
  const d = new Date((heatTimeBase() + offsetSec) * 1000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return Math.round(d.getTime() / 1000) - heatTimeBase();
}

// 把「相对偏移秒」格式化为绝对时间的各部件
function ymdHm(offsetSec) {
  const d = new Date((heatTimeBase() + offsetSec) * 1000);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: d.getFullYear(), mo: d.getMonth() + 1, day: d.getDate(),
    hm: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

// 把当前时间窗格式化为「起点 ~ 终点」区间字符串，区间长度 = 所选时间单位
//   同一天：2026/8/14 00:00 ~ 12:00
//   跨天　：2026/8/14 00:00 ~ 8/15 00:00
function formatWindowRange() {
  const s = ymdHm(timeWindowStart);
  const e = ymdHm(timeWindowStart + timeUnitSec);
  if (!s || !e) return '--';
  const startStr = `${s.y}/${s.mo}/${s.day} ${s.hm}`;
  const sameDay = s.y === e.y && s.mo === e.mo && s.day === e.day;
  const endStr = sameDay ? e.hm : `${e.mo}/${e.day} ${e.hm}`;
  return `${startStr} ~ ${endStr}`;
}

// 时间轴档位总数（滑块能停的档位数）：按时间单位把「首日 00:00 ~ 终日 24:00」切成 N 段。
// 例：数据 8/14~8/19，单位=天 → 档位停在 8/14 / 8/15 / … / 8/19（各覆盖当天 00:00~24:00）。
function timeStepCount() {
  if (!hasTimeData) return 1;
  const span = dataAlignedMax - dataAlignedMin;
  return Math.max(1, Math.round(span / timeUnitSec));
}

// 设定档位（0-based），并据此对齐窗口起点 = 首日 00:00 + index*unit
function setTimeStep(index) {
  const n = timeStepCount();
  timeStepIndex = Math.max(0, Math.min(Math.round(index) || 0, n - 1));
  timeWindowStart = dataAlignedMin + timeStepIndex * timeUnitSec;
}

// 刷新时间轴文字标签
function updateTimeAxisLabel() {
  const el = document.getElementById('timeAxisLabel');
  if (!el) return;
  if (!hasTimeData) { el.textContent = '数据无时间字段（全部显示）'; return; }
  if (!timeFilterEnabled) { el.textContent = '已关闭（全部显示）'; return; }
  el.textContent = formatWindowRange();
}

// 把档位同步到滑块：滑块按「档位」离散取值（min=0, max=N-1, step=1），并让刻度线数量与档位对齐。
function syncTimeAxisSlider() {
  const slider = document.getElementById('timeAxisRange');
  if (!slider) return;
  const n = timeStepCount();
  slider.min = '0';
  slider.max = String(Math.max(0, n - 1));
  slider.step = '1';
  slider.value = String(timeStepIndex);
  // 刻度线间距 = 100/(档位间隔数)，让每档对应一根刻度
  const track = slider.closest('.time-axis-track');
  if (track) {
    const gap = n > 1 ? (100 / (n - 1)) : 100;
    track.style.setProperty('--tick-gap', gap + '%');
  }
}

// 时间窗变化后：刷新标签 + 重建点云 / 热力图（复用现有渲染链路）
function applyTimeWindow() {
  updateTimeAxisLabel();
  syncTimeAxisSlider();
  if (modelObject) {
    rebuildBehaviors(true);
    applyDisplayMode();
    syncDataTreeUI();
  }
}

// 「按照时间显示」开关的整体禁用态（无时间数据或关闭时置灰时间单位/时间轴）
function refreshTimeAxisEnabled() {
  const disabled = !timeFilterEnabled || !hasTimeData;
  ['timeUnitRow', 'timeAxisRow'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('time-axis-disabled', disabled);
  });
}

// 绑定「数据时间轴」模块：按照时间显示开关 + 时间单位下拉 + 时间轴滑块
function bindTimeAxis() {
  // 读取数据来源表格，自动同步时间轴范围
  computeDataTimeRange();

  // 无时间数据时，默认回落到「全部显示」，避免误藏数据
  if (!hasTimeData) timeFilterEnabled = false;

  const enSw = document.getElementById('timeEnableSwitch');
  const unitSel = document.getElementById('timeUnitSel');
  const slider = document.getElementById('timeAxisRange');

  // 同步开关按钮高亮
  const syncEnableBtns = () => {
    if (!enSw) return;
    enSw.querySelectorAll('.mode-btn').forEach((btn) => {
      btn.classList.toggle('active', (btn.getAttribute('data-on') === '1') === timeFilterEnabled);
    });
  };

  // 「按照时间显示」是 / 否
  if (enSw) {
    enSw.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (!btn) return;
      timeFilterEnabled = btn.getAttribute('data-on') === '1';
      syncEnableBtns();
      refreshTimeAxisEnabled();
      applyTimeWindow();
    });
  }

  // 「时间单位」6小时 / 12小时 / 1天
  if (unitSel) {
    unitSel.value = String(timeUnitSec);
    unitSel.addEventListener('change', () => {
      const prevStart = timeWindowStart;
      timeUnitSec = Number(unitSel.value) || 43200;
      // 单位变化后按新单位重新对齐档位，尽量保持当前窗口起点对应的时间
      setTimeStep(Math.round((prevStart - dataAlignedMin) / timeUnitSec));
      applyTimeWindow();
    });
  }

  // 「时间轴」滑块：按档位离散取值，每档步进一个时间单位
  if (slider) {
    slider.addEventListener('input', () => {
      setTimeStep(parseInt(slider.value, 10) || 0);
      updateTimeAxisLabel();
      if (modelObject) { rebuildBehaviors(true); applyDisplayMode(); syncDataTreeUI(); }
    });
  }

  syncEnableBtns();
  refreshTimeAxisEnabled();
  updateTimeAxisLabel();
  syncTimeAxisSlider();
}

// 绑定「数据内容」面板：地图筛选下拉 + 点位大小拖动条 + 数据分类树
function bindHeatmapPanel() {
  const panel = document.getElementById('heatmapPanel');
  if (!panel) return;
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ===== 地图筛选下拉（只显示当前地图的难度档位）=====
  const sel = document.getElementById('heatMapFilter');
  if (sel) {
    rebuildMapFilterOptions();
    sel.addEventListener('change', () => {
      heatMapFilter = sel.value;
      if (modelObject) {
        rebuildBehaviors(true);
        // 场景点位只对当前选中的难度档位生效，筛选变化后需重建
        rebuildScenePoints();
        applyDisplayMode();
        syncDataTreeUI();
      }
    });
  }

  // ===== 点位大小 =====
  const slider = document.getElementById('heatDotSize');
  const valEl = document.getElementById('heatDotSizeVal');
  if (!slider) return;

  const update = () => {
    const v = parseFloat(slider.value);
    if (isNaN(v)) return;
    // 范围 0.00001 ~ 0.003，需要 5 位小数才能完整显示
    if (valEl) valEl.textContent = v.toFixed(5);
    // 复用已有 window.dotSize()：设置全局倍率并重建热点/异常散点
    if (typeof window.dotSize === 'function') window.dotSize(v);
  };
  slider.addEventListener('input', update);
  // 初次同步（同步当前显示值，不触发重建以免模型未就绪）
  if (valEl) valEl.textContent = parseFloat(slider.value).toFixed(5);

  // ===== 显示方式切换（点云 / 热力图）=====
  const modeSw = document.getElementById('dataModeSwitch');
  if (modeSw) {
    modeSw.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (!btn) return;
      setDisplayMode(btn.getAttribute('data-mode'));
    });
  }

  // ===== 数据分类树 =====
  buildDataTree();

  // ===== 数据时间轴 =====
  bindTimeAxis();
}

// 构建「数据内容」面板里的分类树，并绑定交互
//   - 一级分组标题：点击折叠 / 展开（小三角同步旋转）
//   - 二级项目名称：点击切换显隐
//   - 二级项目色块：点击弹出取色器改颜色
function buildDataTree() {
  // 1) 动态生成「场景点位」下的类别项（用 icon 缩略图代替色块）
  const sceneList = document.getElementById('sceneList');
  if (sceneList) {
    sceneList.innerHTML = '';
    SCENE_CATEGORIES.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'data-item';
      row.setAttribute('data-key', c.key);
      // 面板缩略图用 drop-shadow 叠色，效果与 3D 里的 iconTint 保持一致
      const tintStyle = c.iconTint
        ? ` style="filter:brightness(0) drop-shadow(0 0 0 ${c.iconTint}) drop-shadow(0 0 0 ${c.iconTint})"`
        : '';
      row.innerHTML =
        `<img class="data-icon" src="${c.icon}" alt=""${tintStyle}>` +
        `<span class="data-item-name">${c.name}</span>` +
        `<span class="data-item-count"></span>`;
      sceneList.appendChild(row);
    });
  }

  // 2) 动态生成「玩家行为」下的类别项
  const list = document.getElementById('behaviorList');
  if (list) {
    list.innerHTML = '';
    BEHAVIOR_CATEGORIES.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'data-item';
      row.setAttribute('data-key', c.key);
      row.innerHTML =
        `<span class="data-color" style="background:${c.color}">` +
        `<input type="color" value="${c.color}" title="点击修改颜色"></span>` +
        `<span class="data-item-name">${c.name}</span>` +
        `<span class="data-item-count"></span>`;
      list.appendChild(row);
    });
  }

  // 2b) 动态生成「其他数据」下的类别项（结构与玩家行为一致，可自定义颜色）
  const otherListEl = document.getElementById('otherList');
  if (otherListEl) {
    otherListEl.innerHTML = '';
    OTHER_CATEGORIES.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'data-item';
      row.setAttribute('data-key', c.key);
      row.innerHTML =
        `<span class="data-color" style="background:${c.color}">` +
        `<input type="color" value="${c.color}" title="点击修改颜色"></span>` +
        `<span class="data-item-name">${c.name}</span>` +
        `<span class="data-item-count"></span>`;
      otherListEl.appendChild(row);
    });
  }

  // 2) 一级分组折叠
  document.querySelectorAll('#dataTree .data-group').forEach((grp) => {
    const head = grp.querySelector('.data-group-head');
    if (!head) return;
    head.addEventListener('click', () => grp.classList.toggle('collapsed'));
  });

  // 3) 二级项目：名称切显隐、色块改颜色
  document.querySelectorAll('#dataTree .data-item').forEach((row) => {
    const key = row.getAttribute('data-key');
    const disabled = row.classList.contains('disabled');
    const nameEl = row.querySelector('.data-item-name');
    const colorEl = row.querySelector('.data-color');
    const colorInput = row.querySelector('input[type="color"]');

    if (nameEl && !disabled) {
      nameEl.addEventListener('click', () => {
        if (sceneState[key]) {
          setSceneVisible(key, !sceneState[key].visible);
        } else if (behaviorState[key]) {
          setBehaviorVisible(key, !behaviorState[key].visible);
        }
        // 热力图模式下勾选项变化需重算密度（所有勾选项汇总进同一张图）
        applyDisplayMode();
        syncDataTreeUI();
      });
    }

    if (colorInput && !disabled) {
      // 阻止冒泡，避免点色块时同时触发折叠 / 显隐
      colorEl.addEventListener('click', (e) => e.stopPropagation());
      colorInput.addEventListener('input', () => {
        const hex = colorInput.value;
        colorEl.style.background = hex;
        if (behaviorState[key]) setBehaviorColor(key, hex);
      });
    }
  });

  syncDataTreeUI();
}

// 把运行时状态同步到数据树 UI（高亮已开启项、更新点数）
function syncDataTreeUI() {
  document.querySelectorAll('#dataTree .data-item').forEach((row) => {
    const key = row.getAttribute('data-key');
    const cnt = row.querySelector('.data-item-count');
    let on = false;
    let n = null;
    if (sceneState[key]) {
      on = sceneState[key].visible;
      n = sceneRaw(key).length;
    } else if (behaviorState[key]) {
      on = behaviorState[key].visible;
      n = filterByMapId(behaviorRaw(key)).length;
    }
    row.classList.toggle('active', on);
    if (cnt) cnt.textContent = (n === null) ? '' : String(n);
  });
}

// 控制台设置地图筛选：heatMap('all') / heatMap(35) / heatMap() 打印当前值与各档位点数
// 只接受属于当前 3D 地图的 map_id（另一张图的档位请先切换顶部地图）
window.heatMap = function (v) {
  const stat = countHeatMapIds();
  const curIds = Object.keys(HEAT_MAP_NAMES).map(Number)
    .filter((id) => HEAT_MAP_TO_LEVEL[id] === currentMapKey);
  if (v === undefined) {
    const lvName = currentMapKey === 'steel' ? '钢铁厂' : '电子城';
    console.log(`%c[地图筛选] 当前地图=${lvName}  当前筛选=${heatMapFilter}`,
      'color:#f5c542;font-weight:bold');
    curIds.forEach((id) => {
      console.log(`   ${id} ${HEAT_MAP_NAMES[id]}: ${stat[id] || 0} 点`);
    });
    return heatMapFilter;
  }
  if (v !== 'all' && curIds.indexOf(Number(v)) < 0) {
    console.warn(`[地图筛选] map_id ${v} 不属于当前地图，可选：all / ${curIds.join(' / ')}`);
    return heatMapFilter;
  }
  heatMapFilter = (v === 'all') ? 'all' : String(Number(v));
  const sel = document.getElementById('heatMapFilter');
  if (sel) sel.value = heatMapFilter;
  if (modelObject) {
    rebuildBehaviors(true);
    rebuildScenePoints();
    applyDisplayMode();
    syncDataTreeUI();
  }
  return heatMapFilter;
};

// 绑定参考图操作面板：显隐勾选 + 透明度滑块/输入框
function bindRefPanel() {
  const panel = document.getElementById('refPanel');
  if (!panel) return;
  // 面板内部交互不应触发画布拾取
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  // 显示 2D 参考图
  const chk = document.getElementById('refBtnVisible');
  if (chk) {
    chk.checked = !!refParams.visible;
    chk.addEventListener('change', () => {
      refParams.visible = chk.checked;
      applyRefPlane();
    });
  }

  // 透明度：滑块 + 数值输入 双向同步
  const range = document.getElementById('refOpacityRange');
  const input = document.getElementById('refOpacityInput');
  const setOpacity = (v, from) => {
    let val = parseFloat(v);
    if (isNaN(val)) return;
    val = Math.max(0, Math.min(1, val));
    refParams.opacity = val;
    if (range && from !== 'range') range.value = String(val);
    if (input && from !== 'input') input.value = val.toFixed(2);
    applyRefPlane();
  };
  if (range) {
    range.value = String(refParams.opacity);
    range.addEventListener('input', () => setOpacity(range.value, 'range'));
  }
  if (input) {
    input.value = refParams.opacity.toFixed(2);
    input.addEventListener('input', () => setOpacity(input.value, 'input'));
    input.addEventListener('change', () => setOpacity(input.value, 'input'));
  }
}

// ================= UE 风格飞行控制 =================
function updateCameraRotation() {
  // 去掉轨道式俯仰限制，仅在接近正上/正下时留极小余量防止翻转
  const lim = Math.PI / 2 - 0.001;
  pitch = Math.max(-lim, Math.min(lim, pitch));
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}

function bindControls() {
  // 屏蔽右键菜单，便于右键旋转
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return; // 触摸由 bindTouchControls 处理
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    downBtn = e.button;
    if (e.button === 1) {
      panning = true;         // 中键平移
    } else if (e.button === 0 || e.button === 2) {
      rotating = true;        // 左键 / 右键旋转视角
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!rotating && !panning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (rotating) {
      yaw -= dx * 0.0025;
      pitch -= dy * 0.0025;
      updateCameraRotation();
    } else if (panning) {
      // 沿相机右向 / 上向做屏幕空间平移
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      camera.position.addScaledVector(right, -dx * panScale);
      camera.position.addScaledVector(up, dy * panScale);
    }
  });

  const endDrag = (e) => {
    if (e.type === 'pointerup' && downBtn === 0 && e.button === 0) {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved < 5) {
        // 2D 参考图不可选中 / 不可移动，左键单击不做任何拾取处理
      }
    }
    rotating = false;
    panning = false;
    downBtn = -1;
    if (e.pointerId != null && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // 滚轮：透视下沿视线 dolly；正交下改变 orthoZoom（越滚越近）
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (projectionMode === 'ortho') {
      const factor = Math.pow(1.15, -Math.sign(e.deltaY));
      orthoZoom = Math.max(0.05, Math.min(50, orthoZoom * factor));
      const { w, h } = getSize();
      updateOrthoFrustum(w, h);
    } else {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      camera.position.addScaledVector(forward, -Math.sign(e.deltaY) * dollyStep);
    }
  }, { passive: false });

  // 键盘 WASDQE（仅 3D 视图激活时生效）
  window.addEventListener('keydown', (e) => {
    if (!running) return;
    if (e.code === 'KeyP') { logCamera(); e.preventDefault(); return; }
    if (e.code === 'KeyR') { resetView(); e.preventDefault(); return; }
    if (setKey(e.code, true)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    setKey(e.code, false);
  });

  bindTouchControls();
}

// ===== 移动端触摸手势（面向玩家的简化操作）=====
// 单指拖动：平移画面（沿相机右向/上向做屏幕空间平移）
// 双指捏合：缩放（透视=沿视线 dolly，正交=改 orthoZoom）
// 【已去掉旋转视角】：玩家只需平移 + 缩放看数据，无需转动镜头
function bindTouchControls() {
  let mode = 0;            // 0 空闲 / 1 单指平移 / 2 双指缩放
  let lx = 0, ly = 0;      // 上一帧单指位置
  let lastDist = 0;        // 上一帧双指间距
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  // 沿相机右向/上向平移（屏幕空间），dpx/dpy 为屏幕像素位移
  const panBy = (dpx, dpy) => {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    camera.position.addScaledVector(right, -dpx * panScale);
    camera.position.addScaledVector(up, dpy * panScale);
  };

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      mode = 1;
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
    } else if (e.touches.length >= 2) {
      mode = 2;
      lastDist = dist(e.touches[0], e.touches[1]);
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (mode === 1 && e.touches.length === 1) {
      // 单指平移
      const t = e.touches[0];
      const dx = t.clientX - lx, dy = t.clientY - ly;
      lx = t.clientX; ly = t.clientY;
      panBy(dx, dy);
    } else if (mode === 2 && e.touches.length >= 2) {
      // 双指捏合缩放
      const a = e.touches[0], b = e.touches[1];
      const d = dist(a, b);
      const dd = d - lastDist;
      if (Math.abs(dd) > 0.3) {
        if (projectionMode === 'ortho') {
          orthoZoom = Math.max(0.05, Math.min(50, orthoZoom * Math.pow(1.01, dd)));
          const { w, h } = getSize();
          updateOrthoFrustum(w, h);
        } else {
          const forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          camera.position.addScaledVector(forward, dd * dollyStep * 0.15);
        }
        lastDist = d;
      }
    }
    e.preventDefault();
  }, { passive: false });

  const endTouch = (e) => {
    if (e.touches.length === 0) { mode = 0; }
    else if (e.touches.length === 1) {
      mode = 1;
      lx = e.touches[0].clientX; ly = e.touches[0].clientY;
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
}

function setKey(code, val) {
  switch (code) {
    case 'KeyW': keys.w = val; return true;
    case 'KeyS': keys.s = val; return true;
    case 'KeyA': keys.a = val; return true;
    case 'KeyD': keys.d = val; return true;
    case 'KeyQ': keys.q = val; return true;
    case 'KeyE': keys.e = val; return true;
    case 'ShiftLeft':
    case 'ShiftRight': keys.shift = val; return true;
    default: return false;
  }
}

function updateMovement(dt) {
  // 2D 参考图不可移动，WASD/QE 始终用于控制相机
  const speed = moveSpeed * (keys.shift ? 3 : 1) * dt;
  if (!(keys.w || keys.s || keys.a || keys.d || keys.q || keys.e)) return;

  // 前向含俯仰（飞行式），右向保持水平
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();

  if (keys.w) camera.position.addScaledVector(forward, speed);
  if (keys.s) camera.position.addScaledVector(forward, -speed);
  if (keys.d) camera.position.addScaledVector(right, speed);
  if (keys.a) camera.position.addScaledVector(right, -speed);
  if (keys.e) camera.position.y += speed;
  if (keys.q) camera.position.y -= speed;
}

function onResize() {
  if (!renderer || !container.classList.contains('visible')) return;
  const { w, h } = getSize();
  if (perspCamera) {
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
  }
  updateOrthoFrustum(w, h);
  renderer.setSize(w, h, false);
  if (labelRenderer) labelRenderer.setSize(w, h);
}

// 按画布尺寸 + orthoZoom 更新正交相机的视锥
function updateOrthoFrustum(w, h) {
  if (!orthoCamera) return;
  // 让正交视锥宽度等价于同位置的透视相机在焦平面（相机→原点距离）的可见宽度，
  // 使切换投影时画面比例大致不跳变。
  let baseHalfWidth;
  if (perspCamera) {
    const dist = perspCamera.position.length() || 5000;
    const vFov = THREE.MathUtils.degToRad(perspCamera.fov);
    const halfH = Math.tan(vFov / 2) * dist;
    baseHalfWidth = halfH * (w / h);
  } else {
    baseHalfWidth = w * 0.5;
  }
  const halfW = baseHalfWidth / orthoZoom;
  const halfH = halfW * (h / w);
  orthoCamera.left = -halfW;
  orthoCamera.right = halfW;
  orthoCamera.top = halfH;
  orthoCamera.bottom = -halfH;
  orthoCamera.updateProjectionMatrix();
}

// 切换投影模式（'persp' | 'ortho'），保持视角/位置连续
function setProjection(mode) {
  if (mode !== 'persp' && mode !== 'ortho') return;
  if (mode === projectionMode) return;
  projectionMode = mode;
  const from = camera;
  const target = mode === 'persp' ? perspCamera : orthoCamera;
  if (from && target && from !== target) {
    target.position.copy(from.position);
    target.quaternion.copy(from.quaternion);
  }
  camera = target;
  const { w, h } = getSize();
  updateOrthoFrustum(w, h);
  // 顶栏按钮 active 态同步
  const tabP = document.getElementById('tabPersp');
  const tabO = document.getElementById('tabOrtho');
  if (tabP) tabP.classList.toggle('active', mode === 'persp');
  if (tabO) tabO.classList.toggle('active', mode === 'ortho');
}
window.setProjection = setProjection;

function frameModel(object) {
  // 【新策略】模型保留 UE 原生坐标，不做居中/贴地。仅测量尺寸供相机/网格/速度自适应。
  // 注意：ueRoot 有绕 X 轴 -90° 的旋转，setFromObject 会返回 three 世界坐标下的包围盒，
  // 这正是我们要的可视化尺寸。
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxDim = Math.max(size.x, size.y, size.z);

  // 网格与雾根据模型尺寸自适应
  scene.fog.near = maxDim * 1.2;
  scene.fog.far = maxDim * 6;

  // 运动/交互速度按模型尺寸自适应（作为基准值，再乘用户倍率）
  baseMoveSpeed = maxDim * 0.6;
  basePanScale = maxDim * 0.0015;
  baseDollyStep = maxDim * 0.08;
  applySpeedMul();
  // 撤离点图标尺寸：基准 maxDim*0.03*0.3，再放大 1.5 倍
  markerSize = maxDim * 0.03 * 0.3 * 1.5;

  // 透视：远近平面按模型尺寸自适应
  if (perspCamera) {
    perspCamera.near = maxDim / 500;
    perspCamera.far = maxDim * 20;
    perspCamera.updateProjectionMatrix();
  }
  // 正交：使用超大 near/far 保证任意相机位置都覆盖场景
  if (orthoCamera) {
    orthoCamera.near = -maxDim * 20;
    orthoCamera.far = maxDim * 20;
    orthoCamera.updateProjectionMatrix();
  }

  if (INITIAL_VIEW && useInitialView) {
    // 使用手动调好的固定视角（仅首屏钢铁厂）
    camera.position.set(INITIAL_VIEW.pos[0], INITIAL_VIEW.pos[1], INITIAL_VIEW.pos[2]);
    yaw = THREE.MathUtils.degToRad(INITIAL_VIEW.yaw);
    pitch = THREE.MathUtils.degToRad(INITIAL_VIEW.pitch);
  } else {
    // 自动俯视：相机放在模型中心正上方向下看
    camera.position.set(center.x, center.y + maxDim * 1.4, center.z + 0.0001);
    yaw = 0;
    pitch = -Math.PI / 2 + 0.0001;
  }
  updateCameraRotation();

  // 保存初始状态，供 R 键复位
  initialState = {
    pos: camera.position.clone(),
    yaw: yaw,
    pitch: pitch,
  };

  // 重建场景点位（按当前难度档位取对应关卡的点位）
  rebuildScenePoints();

  // 构建玩家数据点与标签（默认按当前显隐状态）
  buildPlayerData();

  // 重建已开启的数据类别（默认全部关闭，用户在「数据内容」面板勾选后才构建）
  rebuildBehaviors(true);
  applyDisplayMode();
  syncDataTreeUI();

  // 创建 2D 参考图平面（默认铺满模型 XZ 范围、半透明）
  // 各地图使用各自的 2D 底图（钢铁厂 map-steelfactory.jpg / 电子城 map-E-Market.jpg）
  createReferencePlane(size);
  if (refPanel) refPanel.style.display = '';
}

// 打印当前相机参数（按 P），方便把满意的视角固定下来
function logCamera() {
  const p = camera.position;
  const yDeg = THREE.MathUtils.radToDeg(yaw).toFixed(2);
  const pDeg = THREE.MathUtils.radToDeg(pitch).toFixed(2);
  const line = `pos: [${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}], yaw: ${yDeg}, pitch: ${pDeg}`;
  console.log('%c[相机参数] 复制下面这行发给我：', 'color:#f5c542;font-weight:bold');
  console.log('%c' + line, 'color:#8fd; font-size:13px');
  return line;
}

// 复位到初始视角（按 R）
function resetView() {
  if (!initialState) return;
  camera.position.copy(initialState.pos);
  yaw = initialState.yaw;
  pitch = initialState.pitch;
  updateCameraRotation();
}

// ================= 场景点位（3D）=================
// 数据来自 scenepoints.js，按当前「地图筛选」选中的难度档位取对应关卡的点位。
// 每个点位由两部分组成：
//   1) 图标 Sprite（复用 UE 工程的小地图图标，见 SCENE_CATEGORIES.icon）
//   2) 可选的触发范围圈（目前只有撤离点有，对应 BP 里的 SphereLarge 碰撞组件）
// 不支持手动放置 / 拖动 / 删除，只能按类别显示或隐藏。
function getSceneTexture(url) {
  if (!sceneTextures[url]) {
    const t = new THREE.TextureLoader().load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    sceneTextures[url] = t;
  }
  return sceneTextures[url];
}

// 创建一个躺在 UE XY 平面上的圆环（表示触发范围），半径单位为 UE cm
function makeTriggerRing(radius, colorHex) {
  const group = new THREE.Group();
  const SEG = 64;
  const pts = [];
  for (let i = 0; i <= SEG; i++) {
    const t = (i / SEG) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius, 0));
  }
  // 外圈亮线
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.95, depthTest: false })
  );
  line.renderOrder = 1001;
  group.add(line);
  // 半透明填充，便于俯视时看清范围
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, SEG),
    new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    })
  );
  disc.renderOrder = 1000;
  group.add(disc);
  return group;
}

// 构建（或重建）某个场景点位类别
function buildScene(key) {
  const cfg = SCENE_CATEGORIES.find((c) => c.key === key);
  const st = sceneState[key];
  if (!cfg || !st) return;

  // 清理旧的
  if (st.group) {
    if (st.group.parent) st.group.parent.remove(st.group);
    st.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((mm) => {
          if (mm && typeof mm.dispose === 'function') mm.dispose();
        });
      }
    });
    st.group = null;
  }
  st.markers.length = 0;

  const raw = sceneRaw(key);
  if (!raw.length || !ueRoot) return;

  const root = new THREE.Group();
  const ringColor = new THREE.Color(cfg.ringColor).getHex();
  const tex = getSceneTexture(cfg.icon);

  raw.forEach((p) => {
    const v = ueToLocal({
      x: p[0] + UE_OFFSET.x,
      y: p[1] + UE_OFFSET.y,
      z: p[2] + UE_OFFSET.z,
    });
    const g = new THREE.Group();
    g.position.copy(v);

    // 触发范围圈（贴地略抬，避免与地面 Z-fighting）
    if (cfg.ring > 0) {
      const ring = makeTriggerRing(cfg.ring, ringColor);
      ring.position.z = 5;
      g.add(ring);
    }

    // 图标（各类别可用 iconScale 单独放大、iconTint 单独染色）
    const iconSize = markerSize * (cfg.iconScale || 1);
    const spriteMat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    if (cfg.iconTint) spriteMat.color.set(cfg.iconTint);
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(iconSize, iconSize, 1);
    // 在 UE 坐标空间里 Z 是高度轴，把图标底部抬到地面之上
    sprite.position.z = iconSize * 0.5;
    sprite.renderOrder = 1002;
    g.add(sprite);

    root.add(g);
    st.markers.push(g);
  });

  root.visible = st.visible;
  ueRoot.add(root);
  st.group = root;
}

// 重建所有场景点位类别（切换地图 / 难度筛选 / 镜像 / 图标尺寸变化后调用）
function rebuildScenePoints() {
  SCENE_CATEGORIES.forEach((c) => buildScene(c.key));
}

// 设置某类场景点位显隐
function setSceneVisible(key, on) {
  const st = sceneState[key];
  if (!st) return;
  st.visible = !!on;
  if (st.visible && !st.group) buildScene(key);
  if (st.group) st.group.visible = st.visible;
}

// ================= 2D 参考图平面 =================
// 【新策略】参考图直接放到 UE 坐标空间里：
//   - 中心位于 UE (centerX, centerY, 0)   ← 来自 outdoor_mini_map_center
//   - 宽度 = orthoWidth cm，高度按图片宽高比 = orthoWidth / aspect
//   - 平面本身在 UE 的 XY 平面（Z=0），图片右=UE +X，图片上=UE -Y（官方约定）
// 加到 ueRoot 后，ueRoot 的 -90°X 会把它变换到 three 显示空间。
function createReferencePlane(modelSize) {
  if (refPlane) { ueRoot.remove(refPlane); refPlane = null; }
  // 各地图对应的 2D 底图。优先取 window.MAP_2D_IMAGES（script.js 里定义），
  // 兜底默认到钢铁厂图片以兼容旧路径。
  const imgs = (window.MAP_2D_IMAGES) || {
    steel: 'assets/map-steelfactory.jpg',
    electronic: 'assets/map-E-Market.jpg',
  };
  const imgUrl = imgs[currentMapKey] || imgs.steel;
  refTexture = new THREE.TextureLoader().load(imgUrl, function (t) {
    const iw = (t.image && t.image.width) || 1;
    const ih = (t.image && t.image.height) || 1;
    const aspect = iw / ih;
    // 【关键】UE 的 SceneCapture2D 用正交投影，ortho_width 同时决定横向与纵向覆盖的世界距离
    // （渲染目标是正方形 RT），因此参考图在 UE 空间里必须是 orthoWidth × orthoWidth 的正方形，
    // 不能按图片宽高比缩放高度 —— 否则数据点与参考图的 Y 方向比例会不一致（点被拉伸/压缩）。
    const meta = MAP_META[currentMapKey] || MAP_META.steel;
    const w = (meta && meta.orthoWidth > 0) ? meta.orthoWidth : (modelSize.x || 15000);
    refParams.w = w;
    refParams.h = w;   // 正方形，与 ortho_width 覆盖范围一致
    // 中心默认对齐 UE 元数据；用户仍可用 refMove/refNudge 微调
    if (meta) {
      refParams.x = meta.centerX;
      refParams.y = meta.centerY;   // 注意：新架构下 refParams.y 表示"参考图 UE Y 位置"
      refParams.z = 0;              //         refParams.z 表示"参考图 UE Z（高度）"
    }
    buildRefMesh();
  });
  refTexture.colorSpace = THREE.SRGBColorSpace;
}

function buildRefMesh() {
  // 【UE 坐标空间下】参考图直接放在 XY 平面（Z=0），无需额外旋转 —— PlaneGeometry
  // 本身就在 XY 平面，法线沿 +Z 朝上，正对我们要的方向。
  refPlane = new THREE.Group();
  const geo = new THREE.PlaneGeometry(refParams.w, refParams.h);
  const mat = new THREE.MeshBasicMaterial({
    map: refTexture,
    transparent: true,
    opacity: refParams.opacity,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  refMesh = new THREE.Mesh(geo, mat);
  // 官方约定：图片右 = UE +X（PlaneGeometry 自然如此），图片上 = UE -Y。
  // PlaneGeometry 默认图片"上" = 局部 +Y（=UE +Y，即"图片下"方向），因此需要绕本地 X 反转。
  // 用 flipY = -1 实现：让贴图上下翻转，从而"图片上"对应 UE -Y。
  refMesh.scale.set(1, -1, 1);
  refMesh.renderOrder = -1;
  refPlane.add(refMesh);

  ueRoot.add(refPlane);
  applyRefPlane();
}

// 应用当前 refParams 到平面（位置/旋转/翻转/透明度/显隐）
// 【已在 UE 编辑器中实测验证的摆放规则】
//   贴图来源：DA_CodeEvacuationMinimapConfig 的 outdoor_minimap_texture
//     钢铁厂 902 = T_MiniMapTxure_DreamCoreFactoryNew  → assets/map-steelfactory.jpg
//     电子城 903 = T_MiniMapTxure_CodeEvac             → assets/map-E-Market.jpg
//   贴图是正交俯拍的正方形 RT，覆盖世界范围 = ortho_width × ortho_width，
//   中心 = outdoor_mini_map_center。
//   验证方法：在 UE 关卡里 spawn 一块 Plane（中心 = center、scale = orthoWidth/100），
//   贴上同一张贴图，与玩家数据点 Cube 对比 —— 结果是平面需要绕 UE Z 轴 Yaw 180°
//   才能与数据点完全对齐，且不需要任何 UV 镜像。
function applyRefPlane() {
  if (!refPlane || !refMesh) return;
  // refParams.x/y/z = 参考图中心在 UE 坐标系里的位置（cm）
  refPlane.position.set(refParams.x, refParams.y, refParams.z);
  // 绕 UE Z 轴（垂直轴）旋转，默认 180° —— 与 UE 实测一致
  refPlane.rotation.set(0, 0, THREE.MathUtils.degToRad(refParams.rotY));
  // 不做隐式镜像；flipX / flipY 仅供用户手动微调（默认 1 = 不翻）
  refMesh.scale.set(refParams.flipX, refParams.flipY, 1);
  refMesh.material.opacity = refParams.opacity;
  refPlane.visible = refParams.visible;
}

// 用给定宽高重建平面几何（缩放/尺寸变更时调用）
function rebuildRefGeometry() {
  if (!refMesh) return;
  refMesh.geometry.dispose();
  refMesh.geometry = new THREE.PlaneGeometry(refParams.w, refParams.h);
}

// 参考图升降（正为上移）：步长随平面尺度自适应
function nudgeRefY(dir) {
  const step = Math.max(10, refParams.h * 0.02);
  refParams.y += dir * step;
  applyRefPlane();
}

// 参考图等比缩放：factor>1 放大、<1 缩小
function scaleRef(factor) {
  refParams.w *= factor;
  refParams.h *= factor;
  rebuildRefGeometry();
}

function printRefParams() {
  const p = refParams;
  const line =
    `refParams = { x:${p.x.toFixed(1)}, y:${p.y.toFixed(1)}, z:${p.z.toFixed(1)}, ` +
    `rotY:${p.rotY.toFixed(1)}, w:${p.w.toFixed(1)}, h:${p.h.toFixed(1)}, ` +
    `flipX:${p.flipX}, flipY:${p.flipY}, opacity:${p.opacity} };`;
  console.log('%c[参考图参数] 复制发我固化：', 'color:#f5c542;font-weight:bold');
  console.log('%c' + line, 'color:#8fd; font-size:13px');
  return line;
}

function loadModel() {
  const url = MAP_MODELS[currentMapKey] || MODEL_URL;
  // 切换地图时先卸载旧模型
  if (modelObject) {
    disposeGroup(modelObject);
    modelObject = null;
    window.modelObject = null;
  }
  loaderEl.classList.remove('hidden');
  loaderText.textContent = '正在加载 3D 模型…';
  const loader = new FBXLoader();
  loader.load(
    url,
    function (object) {
      // 【新策略：整个场景使用 UE 坐标系】
      // FBX 从 UE 导出时保留原始 Z-up 姿态，本工具不再对模型做任何旋转/居中/贴地位移，
      // 直接以 UE 世界坐标空间加载到 ueRoot 中，ueRoot 顶层的固定 -90°X 旋转会把整个
      // UE 空间可视化为 three 的 Y-up 显示。
      // MODEL_YAW 保留（可绕 UE Z 轴旋转模型朝向）；用户面板的旋转/镜像/偏移由
      // MODEL_XFORM + applyModelXform() 统一应用。
      object.__qLay = new THREE.Quaternion();  // 保留字段以免其它引用报错
      object.__upAxis = 'z';

      object.traverse(function (child) {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          if (!child.material) {
            child.material = new THREE.MeshStandardMaterial({ color: 0x888888 });
          }
        }
      });
      modelObject = object;
      ueRoot.add(object);   // 挂到 UE 坐标空间根节点
      applyModelXform();    // 初始应用（MODEL_YAW + 用户当前的 MODEL_XFORM）
      applyModelDisplay();  // 初始应用显隐与透明度
      frameModel(object);
      loaderEl.classList.add('hidden');
      // 暴露调试入口
      window.modelObject = modelObject;
      window.scene = scene;
      window.camera = camera;
      window.THREE = THREE;
    },
    function (xhr) {
      if (xhr.total) {
        const pct = Math.round((xhr.loaded / xhr.total) * 100);
        loaderText.textContent = '正在加载 3D 模型… ' + pct + '%';
      } else {
        loaderText.textContent =
          '正在加载 3D 模型… ' + (xhr.loaded / 1048576).toFixed(1) + ' MB';
      }
    },
    function (err) {
      console.error('FBX 加载失败:', err);
      loaderText.textContent = '模型加载失败，请检查文件或网络';
    }
  );
}

// 实时调整模型水平朝向：modelYaw(180) 表示绕 Y 轴 180°。不带参数打印当前值。
window.modelYaw = function (deg) {
  if (deg === undefined) return (MODEL_YAW * 180) / Math.PI;
  MODEL_YAW = ((Number(deg) || 0) * Math.PI) / 180;
  if (modelObject && modelObject.__qLay) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), MODEL_YAW);
    modelObject.quaternion.copy(qYaw.multiply(modelObject.__qLay.clone()));
    modelObject.updateMatrixWorld(true);
  }
  return (MODEL_YAW * 180) / Math.PI;
};

function animate() {
  if (!running) return;
  rafId = requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  updateMovement(dt);
  renderer.render(scene, camera);
  if (labelRenderer) labelRenderer.render(scene, camera);
}

function start() {
  if (!initialized) {
    initialized = true;
    initScene();
    loadModel();
  }
  onResize();
  if (!running) {
    running = true;
    clock.getDelta(); // 丢弃切换间隔，避免瞬移
    animate();
  }
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  // 释放按键状态，避免切回后仍在移动
  keys.w = keys.a = keys.s = keys.d = keys.q = keys.e = keys.shift = false;
  rotating = panning = false;
}

// ===== 控制台调试接口 =====
// 在浏览器控制台直接调用可实时预览视角：
//   setView(x, y, z, yawDeg, pitchDeg)  // 设置相机位置与朝向
//   logCam()                            // 打印当前相机参数
window.setView = function (x, y, z, yawDeg, pitchDeg) {
  if (!camera) { console.warn('请先切换到 3D 视图'); return; }
  camera.position.set(x, y, z);
  yaw = THREE.MathUtils.degToRad(yawDeg);
  pitch = THREE.MathUtils.degToRad(pitchDeg);
  updateCameraRotation();
};
window.logCam = function () { return logCamera(); };

// ===== 场景点位 UE 偏移调试 =====
// ueOffset() 打印当前偏移；ueOffset(x,y,z) 直接设置。正常情况下应保持为 0。
function printUeOffset() {
  const o = UE_OFFSET;
  const line = `UE_OFFSET = { x: ${o.x}, y: ${o.y}, z: ${o.z} };`;
  console.log('%c[场景点位偏移]', 'color:#f5c542;font-weight:bold');
  console.log('%c' + line, 'color:#8fd; font-size:13px');
  return line;
}
window.ueOffset = function (x, y, z) {
  if (x === undefined) return printUeOffset();
  UE_OFFSET = { x: +x || 0, y: +y || 0, z: +z || 0 };
  rebuildScenePoints();
  return printUeOffset();
};

// ===== 2D 参考图平面 控制台命令 =====
window.refShow = function (b) {
  refParams.visible = b === undefined ? !refParams.visible : !!b;
  applyRefPlane();
  return printRefParams();
};
window.refOpacity = function (v) {
  refParams.opacity = Math.max(0, Math.min(1, +v));
  applyRefPlane();
  return printRefParams();
};
window.refScale = function (s) {
  s = +s || 1;
  refParams.w *= s;
  refParams.h *= s;
  rebuildRefGeometry();
  return printRefParams();
};
window.refSize = function (w, h) {
  if (w) refParams.w = +w;
  if (h) refParams.h = +h;
  rebuildRefGeometry();
  return printRefParams();
};
window.refMove = function (x, y, z) {
  refParams.x = +x || 0;
  refParams.y = y === undefined ? refParams.y : (+y || 0);
  refParams.z = +z || 0;
  applyRefPlane();
  return printRefParams();
};
window.refNudge = function (dx, dz) {
  refParams.x += +dx || 0;
  refParams.z += +dz || 0;
  applyRefPlane();
  return printRefParams();
};
window.refRaise = function (dy) {
  refParams.y += +dy || 0;
  applyRefPlane();
  return printRefParams();
};
window.refRotate = function (deg) {
  refParams.rotY = +deg || 0;
  applyRefPlane();
  return printRefParams();
};
window.refTurn = function (ddeg) {
  refParams.rotY += +ddeg || 0;
  applyRefPlane();
  return printRefParams();
};
window.refFlipX = function () {
  refParams.flipX *= -1;
  applyRefPlane();
  return printRefParams();
};
window.refFlipY = function () {
  refParams.flipY *= -1;
  applyRefPlane();
  return printRefParams();
};
window.refPrint = function () { return printRefParams(); };

// ===== 参考图方向穷举（用于一次性定死"参考图 vs 数据点"的方向关系）=====
// 参考图相对数据点只有 4 种可能的方向关系（X / Y 镜像的符号组合）。
// 用法：在控制台反复执行 refDir()（不带参数=切到下一种），观察哪一种数据点与
// 小地图上的建筑完全吻合，然后把控制台打印的编号告诉开发者固化即可。
// 也可以 refDir(0..3) 直接指定。
const REF_DIRS = [
  { flipX:  1, flipY:  1, desc: '#0 不翻转' },
  { flipX:  1, flipY: -1, desc: '#1 仅上下翻（Y 镜像）' },
  { flipX: -1, flipY:  1, desc: '#2 仅左右翻（X 镜像）' },
  { flipX: -1, flipY: -1, desc: '#3 上下+左右翻（=绕中心 180°）' },
];
let _refDirIdx = -1;
window.refDir = function (n) {
  if (n === undefined) {
    _refDirIdx = (_refDirIdx + 1) % REF_DIRS.length;
  } else {
    _refDirIdx = Math.max(0, Math.min(REF_DIRS.length - 1, Number(n) | 0));
  }
  const d = REF_DIRS[_refDirIdx];
  refParams.flipX = d.flipX;
  refParams.flipY = d.flipY;
  applyRefPlane();
  console.log('%c[参考图方向] ' + d.desc + `   (rotY=${refParams.rotY}, flipX=${d.flipX}, flipY=${d.flipY})`,
    'color:#f5c542;font-weight:bold;font-size:13px');
  return d.desc;
};
// 参考图旋转 0 / 180 快速切换（配合 refDir 一起穷举，共 8 种）
window.refRot180 = function () {
  refParams.rotY = (refParams.rotY === 180) ? 0 : 180;
  applyRefPlane();
  console.log('%c[参考图旋转] rotY = ' + refParams.rotY, 'color:#f5c542;font-weight:bold;font-size:13px');
  return refParams.rotY;
};

// ===== 校准锚点：在指定 UE 世界坐标处打一个醒目的标记 =====
// 用法：ueMark(x, y)  或  ueMark(x, y, z)
//   在 UE 坐标 (x, y, z) 处放一根亮青色竖柱 + 十字，用来核对该坐标落在小地图的哪个位置。
//   ueMark()      —— 清除所有标记
// 场景：在 UE 编辑器里点选某个地标建筑，复制它的 Location，用本命令在工具里打点，
//       即可判断"工具的 UE→小地图映射"是否正确、偏差多少。
let _ueMarks = null;
window.ueMark = function (x, y, z) {
  if (!ueRoot) { console.warn('请先进入 3D 视图'); return; }
  if (_ueMarks) { _ueMarks.removeFromParent(); _ueMarks = null; }
  if (x === undefined) { console.log('[ueMark] 已清除标记'); return; }
  const ux = Number(x) || 0, uy = Number(y) || 0, uz = (z === undefined ? 0 : Number(z) || 0);
  _ueMarks = new THREE.Group();
  _ueMarks.name = 'UE_MARKS';
  const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false });
  const add = (a, b) => {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
    l.renderOrder = 10000;
    _ueMarks.add(l);
  };
  const H = 4000, C = 800;
  add(new THREE.Vector3(ux, uy, uz), new THREE.Vector3(ux, uy, uz + H));       // 竖柱
  add(new THREE.Vector3(ux - C, uy, uz + 20), new THREE.Vector3(ux + C, uy, uz + 20)); // 十字 X
  add(new THREE.Vector3(ux, uy - C, uz + 20), new THREE.Vector3(ux, uy + C, uz + 20)); // 十字 Y
  ueRoot.add(_ueMarks);
  console.log(`%c[ueMark] 已在 UE (${ux}, ${uy}, ${uz}) 处标记（青色竖柱）`,
    'color:#4dd2ff;font-weight:bold;font-size:13px');
};

// ================= 玩家数据（3D 标签）=================
// 生成一张白色圆点贴图，供事件点复用（用材质 color 着色区分类型）
function getPlayerDotTexture() {
  if (playerDotTexture) return playerDotTexture;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.6, 'rgba(255,255,255,1)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
  ctx.fill();
  playerDotTexture = new THREE.CanvasTexture(cv);
  playerDotTexture.colorSpace = THREE.SRGBColorSpace;
  return playerDotTexture;
}

// 组装单个事件的 HTML 标签内容
function buildLabelEl(ev, cfg) {
  const el = document.createElement('div');
  el.className = 'pd-label ' + cfg.cls;
  const pos = `(${ev.x.toFixed(1)}, ${ev.y.toFixed(1)}, ${ev.z.toFixed(1)})`;
  let html = `<div class="pd-title">${cfg.name}</div>`;
  if (ev.id) html += `<div class="pd-meta">宝箱 ${ev.id}</div>`;
  if (ev.t != null) html += `<div class="pd-meta">t=${ev.t.toFixed(1)}s</div>`;
  html += `<div class="pd-meta">${pos}</div>`;
  if (ev.s) html += `<div class="pd-states">${ev.s}</div>`;
  el.innerHTML = html;
  return el;
}

// 构建（或重建）所有玩家数据点与标签
function buildPlayerData() {
  // 清理旧的
  if (playerGroup) {
    ueRoot.remove(playerGroup);
    playerGroup.traverse((o) => {
      if (o.isSprite && o.material) { if (o.material.map) {/* 共享贴图不释放 */} o.material.dispose(); }
    });
    playerGroup = null;
  }
  stopPlayback();
  playerLabels.length = 0;
  playerDots.length = 0;
  playerPoints.length = 0;
  playerPathLine = null;

  playerGroup = new THREE.Group();
  const dotSize = Math.max(markerSize * 0.8, 1);
  const labelStep = markerSize * 1.4; // 同点位重复事件的标签竖直错位量

  if (modelObject) modelObject.updateMatrixWorld(true);

  const stackCount = new Map(); // 按位置聚合，重复点位的标签向上堆叠避免完全重叠
  const pathPoints = [];        // 按时间顺序收集各事件的世界坐标（贴地），用于连轨迹线
  PLAYER_EVENTS.forEach((ev) => {
    const cfg = PD_TYPES[ev.ty];
    const v = ueToLocal(ev); // 已直接返回 three 世界坐标（对齐 2D 小地图）
    pathPoints.push(v.clone());
    playerPoints.push(v.clone());

    // 圆点（贴事件真实位置）
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getPlayerDotTexture(),
      color: cfg.color,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }));
    dot.scale.set(dotSize, dotSize, 1);
    dot.position.copy(v);
    dot.renderOrder = 998;
    playerGroup.add(dot);
    playerDots.push(dot);

    // 文字标签（重复点位向上堆叠，避免完全重叠）
    const key = `${ev.x.toFixed(1)}|${ev.y.toFixed(1)}|${ev.z.toFixed(1)}`;
    const idx = stackCount.get(key) || 0;
    stackCount.set(key, idx + 1);

    const label = new CSS2DObject(buildLabelEl(ev, cfg));
    label.position.copy(v);
    label.position.y += dotSize * 0.8 + idx * labelStep;
    playerGroup.add(label);
    playerLabels.push(label);
  });

  // 时间顺序轨迹线：PLAYER_EVENTS 本身按事件发生顺序录入（chest/abn 带时间戳 t=114→372s
  // 递增，snap 分钟快照插在对应时段），故按数组顺序连线即为时间顺序。颜色从冷色（起点）
  // 渐变到暖色（终点）表达时间推进方向。整条线单独抬高飘在空中，避免与模型穿插、看不清。
  if (pathPoints.length > 1) {
    const posArr = new Float32Array(pathPoints.length * 3);
    const colArr = new Float32Array(pathPoints.length * 3);
    const cStart = new THREE.Color(0x33ccff);
    const cEnd = new THREE.Color(0xff5533);
    const last = pathPoints.length - 1;
    const lift = markerSize * 10 + PD_PATH_LIFT; // 连线竖直抬升到空中，用 pdPathLift 再调
    pathPoints.forEach((p, i) => {
      posArr[i * 3] = p.x; posArr[i * 3 + 1] = p.y + lift; posArr[i * 3 + 2] = p.z;
      const c = cStart.clone().lerp(cEnd, i / last);
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 997; // 在圆点(998)之下
    playerGroup.add(line);
    playerPathLine = line;
  }

  ueRoot.add(playerGroup);
  applyPlayerDataVisible();
}

// 应用显隐：圆点随 group、标签逐个切换（CSS2DObject 只认自身 visible）
// 打开时把所有圆点/标签/连线都恢复为可见（覆盖播放留下的部分显示状态），关闭时整体隐藏。
function applyPlayerDataVisible() {
  if (playerGroup) playerGroup.visible = playerDataVisible;
  if (playerDataVisible) {
    stopPlayback();
    playerDots.forEach((d) => { d.visible = true; });
    playerLabels.forEach((l) => { l.visible = true; });
    if (playerPathLine) {
      playerPathLine.visible = true;
      playerPathLine.geometry.setDrawRange(0, Infinity);
    }
  } else {
    playerLabels.forEach((l) => { l.visible = false; });
  }
}

// ================= 玩家数据播放（按时间顺序逐个显示）=================
// 停止播放定时器（不改变已显示内容）
function stopPlayback() {
  if (pdPlayTimer) { clearInterval(pdPlayTimer); pdPlayTimer = null; }
}

// 复位播放：停止并隐藏所有已显示的点/标签/连线，可从头重新播放
function resetPlayback() {
  stopPlayback();
  pdPlayIndex = 0;
  playerDots.forEach((d) => { d.visible = false; });
  playerLabels.forEach((l) => { l.visible = false; });
  if (playerPathLine) {
    playerPathLine.visible = false;
    playerPathLine.geometry.setDrawRange(0, 0);
  }
}

// 显示下一个事件（圆点 + 标签），并让轨迹连线随之生长一段
function pdRevealNext() {
  if (pdPlayIndex >= playerDots.length) {
    stopPlayback();
    window.dispatchEvent(new CustomEvent('playerdata-play-done'));
    return;
  }
  const i = pdPlayIndex;
  if (playerDots[i]) playerDots[i].visible = true;
  if (playerLabels[i]) playerLabels[i].visible = true;
  if (playerPathLine) {
    playerPathLine.visible = true;
    playerPathLine.geometry.setDrawRange(0, i + 1); // 画到第 i+1 个顶点
  }
  pdPlayIndex++;
  if (pdPlayIndex >= playerDots.length) {
    stopPlayback();
    window.dispatchEvent(new CustomEvent('playerdata-play-done'));
  }
}

// 开始播放：每隔 interval 秒显示一个事件。数据/模型可能还没加载好，做有限次重试。
function startPlayback(interval) {
  const step = Math.max(50, (+interval || 2) * 1000);
  let tries = 0;
  const begin = () => {
    if ((!playerDots.length || !camera) && tries < 60) { tries++; setTimeout(begin, 100); return; }
    if (!playerDots.length) return;
    resetPlayback();
    playerDataVisible = true;
    if (playerGroup) playerGroup.visible = true;
    // 先把相机移到数据上方，保证能看到逐个出现的标签
    focusPlayerData();
    pdRevealNext();                       // 立即显示第一个
    pdPlayTimer = setInterval(pdRevealNext, step);
  };
  begin();
}

// 由 2D 工具栏「数据播放」按钮触发
window.addEventListener('playerdata-play-3d', (e) => {
  const active = !!(e.detail && e.detail.active);
  const interval = (e.detail && e.detail.interval) || 2;
  if (active) startPlayback(interval);
  else resetPlayback();
});

// 控制台命令：pdPlay(2) 从头播放（2 秒/个）；pdPlayStop() 复位
window.pdPlay = function (interval) { startPlayback(interval); return '开始播放玩家数据'; };
window.pdPlayStop = function () { resetPlayback(); return '已复位'; };

// 玩家数据包围盒（three 世界坐标），供聚焦相机用
function getPlayerDataBounds() {
  const box = new THREE.Box3();
  if (!playerPoints.length) return null;
  playerPoints.forEach((p) => box.expandByPoint(p));
  return box;
}

// 一键把相机移到玩家数据上方俯视，保证一点就能看到（打乱视角，按 R 复位）
function focusPlayerData() {
  const box = getPlayerDataBounds();
  if (!box) { console.warn('玩家数据尚未生成'); return; }
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const span = Math.max(s.x, s.z, 1);
  camera.position.set(c.x, c.y + span * 1.2 + 500, c.z + 0.001);
  yaw = 0;
  pitch = -Math.PI / 2 + 0.0001;
  updateCameraRotation();
}
window.pdFocus = function () { focusPlayerData(); return '已聚焦玩家数据（按 R 复位视角）'; };

// 诊断：统计点位数、投影在视锥内的数量、包围盒，帮助定位“看不到”的原因
window.pdDebug = function () {
  if (!camera) { console.warn('请先切到 3D 视图'); return; }
  camera.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  let inView = 0;
  playerPoints.forEach((p, i) => {
    const ndc = p.clone().applyMatrix4(vp);
    const vis = ndc.z >= -1 && ndc.z <= 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    if (vis) inView++;
    if (i < 3) {
      console.log(`[pd] #${i} world=(${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}) ndc=(${ndc.x.toFixed(2)},${ndc.y.toFixed(2)},${ndc.z.toFixed(2)}) vis=${vis}`);
    }
  });
  const box = getPlayerDataBounds();
  const info = {
    points: playerPoints.length,
    inView,
    groupVisible: playerGroup && playerGroup.visible,
    playerDataVisible,
  };
  console.log('[pd] 诊断:', JSON.stringify(info));
  if (box) {
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    console.log(`[pd] 包围盒中心=(${c.x.toFixed(0)},${c.y.toFixed(0)},${c.z.toFixed(0)}) 尺寸=(${s.x.toFixed(0)},${s.y.toFixed(0)},${s.z.toFixed(0)})`);
  }
  return info;
};

// 由 2D 工具栏「玩家数据」按钮触发
window.addEventListener('playerdata-mode-3d', (e) => {
  playerDataVisible = !!(e.detail && e.detail.active);
  applyPlayerDataVisible();
  // 打开时静默检测：若没有任何点落在当前视野内，自动聚焦，避免“点了看不到”
  if (playerDataVisible) {
    setTimeout(() => {
      if (!playerPoints.length || !camera) return;
      camera.updateMatrixWorld();
      const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const t = new THREE.Vector3();
      let inView = 0;
      playerPoints.forEach((p) => {
        t.copy(p).applyMatrix4(vp);
        if (t.z >= -1 && t.z <= 1 && Math.abs(t.x) <= 1 && Math.abs(t.y) <= 1) inView++;
      });
      if (inView === 0) {
        console.warn('[玩家数据] 数据点不在当前视野内，已自动聚焦（按 R 复位视角）');
        focusPlayerData();
      }
    }, 60);
  }
});

// 控制台微调：坐标对不齐时用 pdNudge(dx,dy,dz) 增量、pdOffset(x,y,z) 直接设置、pdOffset() 打印
function printPdOffset() {
  const o = PD_OFFSET;
  const x = PD_XFORM;
  const l1 = `PD_XFORM = { map: ['${x.map[0]}', '${x.map[1]}', '${x.map[2]}'], scale: ${x.scale} };`;
  const l2 = `PD_OFFSET = { x: ${o.x}, y: ${o.y}, z: ${o.z} };`;
  console.log('%c[玩家数据适配] 复制下面两行发我固化：', 'color:#f5c542;font-weight:bold');
  console.log('%c' + l1, 'color:#8fd; font-size:13px');
  console.log('%c' + l2, 'color:#8fd; font-size:13px');
  return l1 + '\n' + l2;
}
window.pdOffset = function (x, y, z) {
  if (x === undefined) return printPdOffset();
  PD_OFFSET = { x: +x || 0, y: +y || 0, z: +z || 0 };
  rebuildPlayerViz();
  return printPdOffset();
};
window.pdNudge = function (dx, dy, dz) {
  PD_OFFSET = {
    x: PD_OFFSET.x + (+dx || 0),
    y: PD_OFFSET.y + (+dy || 0),
    z: PD_OFFSET.z + (+dz || 0),
  };
  rebuildPlayerViz();
  return printPdOffset();
};
window.pdShow = function (b) {
  playerDataVisible = b === undefined ? !playerDataVisible : !!b;
  applyPlayerDataVisible();
  return playerDataVisible;
};
// 调节轨迹连线在空中的抬升高度（正值更高）：pdPathLift(2000)；不带参数打印当前值
window.pdPathLift = function (v) {
  if (v === undefined) return PD_PATH_LIFT;
  PD_PATH_LIFT = +v || 0;
  buildPlayerData();
  return PD_PATH_LIFT;
};

// ===== UE→模型 坐标适配调参（对不齐 / 镜像 / 大小不对时用）=====
// 轴重映射：pdMap('x','-y','z') 表示模型局部 [x,y,z] 分别取 UE 的 x、-y、z（此例把 Y 镜像）。
// 可交换轴，如 pdMap('y','x','z')；前缀 '-' 表示取反。不带参数则打印当前配置。
window.pdMap = function (mx, my, mz) {
  if (mx === undefined) return printPdOffset();
  const ok = (t) => /^-?[xyz]$/.test(String(t));
  if (![mx, my, mz].every(ok)) {
    console.warn("[pdMap] 参数须为 'x'/'y'/'z' 或带负号，如 pdMap('x','-y','z')");
    return printPdOffset();
  }
  PD_XFORM.map = [String(mx), String(my), String(mz)];
  rebuildPlayerViz();
  return printPdOffset();
};
// 整体缩放（UE 单位→模型单位）：模型是米、数据是厘米时用 pdScale(0.01)；反之 pdScale(100)。
window.pdScale = function (s) {
  if (s === undefined) return printPdOffset();
  PD_XFORM.scale = +s || 1;
  rebuildPlayerViz();
  return printPdOffset();
};
// 快捷镜像某个轴（在当前 map 基础上对该轴取反）
window.pdFlip = function (axis) {
  const i = { x: 0, y: 1, z: 2 }[String(axis).toLowerCase()];
  if (i === undefined) { console.warn("[pdFlip] 用法 pdFlip('x'|'y'|'z')"); return printPdOffset(); }
  const t = PD_XFORM.map[i];
  PD_XFORM.map[i] = t[0] === '-' ? t.slice(1) : '-' + t;
  rebuildPlayerViz();
  return printPdOffset();
};
// 复位适配为「自动模式」（推荐）：跟随模型自适应旋转自动对齐 UE 数据
window.pdReset = function () {
  PD_AUTO = true;
  PD_XFORM = { map: ['x', '-y', 'z'], scale: 1 };
  PD_OFFSET = { x: 0, y: 0, z: 0 };
  PD_PATH_LIFT = 0;
  rebuildPlayerViz();
  console.log('[玩家数据适配] 已恢复自动模式（按 MAP_META 小地图元数据对齐；未填则退化为 PD_XFORM）');
  return printPdOffset();
};

// 【新】查看/设置当前地图的小地图 UE 元数据
//   mapMeta()                          —— 打印当前地图的 MAP_META 条目
//   mapMeta(orthoWidth, centerX, centerY) —— 直接设置并重建
// 数值来自 UE 项目 DA_CodeEvacuationMinimapConfig 该地图 group 的 3 个字段
// （ortho_width / outdoor_mini_map_center.X / outdoor_mini_map_center.Y）。
window.mapMeta = function (orthoWidth, centerX, centerY) {
  const key = currentMapKey;
  if (orthoWidth === undefined) {
    const m = MAP_META[key];
    const line = `MAP_META.${key} = { orthoWidth: ${m.orthoWidth}, centerX: ${m.centerX}, centerY: ${m.centerY} };`;
    console.log('%c[小地图元数据] 当前：', 'color:#f5c542;font-weight:bold');
    console.log('%c' + line, 'color:#8fd; font-size:13px');
    return line;
  }
  MAP_META[key] = {
    orthoWidth: +orthoWidth || 0,
    centerX: +centerX || 0,
    centerY: +centerY || 0,
  };
  rebuildPlayerViz();
  console.log(`[小地图元数据] 已更新 ${key} 并重建数据点`);
  return window.mapMeta();
};

// 【新】用两个 UE 已知坐标点在 3D 视图里点击标定，反算 orthoWidth / centerX / centerY
// 用法：
//   1) 控制台执行 mapCalibStart([ueX1, ueY1], [ueX2, ueY2])
//   2) 在 3D 视图里依次点击这两个点位在参考图上的对应像素
//   3) 程序自动写入 MAP_META[currentMapKey] 并重建
// 说明：参照游戏项目官方约定（image up==UE -Y，image right==UE +X），
// 只需要两个非共线的点即可解出等比例仿射映射的 orthoWidth 与 centerX/Y。
let _mapCalib = null;
window.mapCalibStart = function (ueA, ueB) {
  if (!Array.isArray(ueA) || !Array.isArray(ueB)) {
    console.warn('用法：mapCalibStart([ueX1, ueY1], [ueX2, ueY2])');
    return;
  }
  _mapCalib = { ue: [ueA, ueB], clicks: [] };
  console.log('%c[标定] 请在 3D 视图中依次点击这两个 UE 坐标对应的位置（点参考图平面上）',
    'color:#4dd2ff;font-weight:bold');
  console.log(`  点 1：UE (${ueA[0]}, ${ueA[1]})`);
  console.log(`  点 2：UE (${ueB[0]}, ${ueB[1]})`);
};
// 【内部】接收一次点击（在参考图上射线拾取到的 three 世界坐标），推进标定
function mapCalibConsumeClick(worldPt) {
  if (!_mapCalib) return false;
  _mapCalib.clicks.push({ x: worldPt.x, z: worldPt.z });
  console.log(`[标定] 已记录第 ${_mapCalib.clicks.length} 个点：three(${worldPt.x.toFixed(1)}, ${worldPt.z.toFixed(1)})`);
  if (_mapCalib.clicks.length >= 2) {
    // 解方程：UE→world 是等比映射且旋转固定（image up==-Y, image right==+X）
    //   world.x = refX + (ue.x - centerX) * s
    //   world.z = refZ - (ue.y - centerY) * s
    // 两组点相减消去 refX/centerX/refZ/centerY：
    //   (w1.x - w2.x) = (u1.x - u2.x) * s   →   s = (w1.x - w2.x) / (u1.x - u2.x)
    //   （用 X 方向解，若 X 差为 0 用 Z 方向解）
    const [w1, w2] = _mapCalib.clicks;
    const [u1, u2] = _mapCalib.ue;
    const dux = u1[0] - u2[0];
    const duy = u1[1] - u2[1];
    let s;
    if (Math.abs(dux) > Math.abs(duy)) {
      s = (w1.x - w2.x) / (dux || 1);
    } else {
      s = -(w1.z - w2.z) / (duy || 1);
    }
    // 反算 centerX/Y（用 refParams.x/z 作为 refX/refZ 基准）
    const centerX = u1[0] - (w1.x - refParams.x) / s;
    const centerY = u1[1] + (w1.z - refParams.z) / s;
    // s = refW / orthoWidth  →  orthoWidth = refW / s
    const orthoWidth = refParams.w / s;
    MAP_META[currentMapKey] = { orthoWidth, centerX, centerY };
    console.log('%c[标定完成] 已写入 MAP_META：', 'color:#f5c542;font-weight:bold');
    console.log(`  orthoWidth=${orthoWidth.toFixed(2)}  centerX=${centerX.toFixed(2)}  centerY=${centerY.toFixed(2)}`);
    _mapCalib = null;
    rebuildPlayerViz();
  }
  return true;
}
window.mapCalibConsumeClick = mapCalibConsumeClick;
// 切换为自动模式：按 MAP_META 小地图元数据映射（未填则退化）
window.pdAuto = function () {
  PD_AUTO = true;
  rebuildPlayerViz();
  console.log('[玩家数据适配] 已切换到自动模式（按小地图 MAP_META 对齐）');
  return printPdOffset();
};
// 手动设置 UE→本地 的轴映射（同时关闭自动模式）。用法：
//   pdXform('x','z','y')   —— 一次性设置 3 个映射
//   pdXform()              —— 打印当前值
window.pdXform = function (mx, my, mz, scale) {
  if (mx === undefined) return printPdOffset();
  PD_AUTO = false;
  PD_XFORM = {
    map: [String(mx), String(my), String(mz)],
    scale: scale === undefined ? PD_XFORM.scale : (+scale || 1),
  };
  rebuildPlayerViz();
  return printPdOffset();
};
// 若想对比「完全不做坐标转换」的原始状态（UE 坐标直接当模型局部坐标），用 pdRaw()
window.pdRaw = function () {
  PD_XFORM = { map: ['x', 'y', 'z'], scale: 1 };
  PD_OFFSET = { x: 0, y: 0, z: 0 };
  rebuildPlayerViz();
  return printPdOffset();
};

// 场景点位显隐（保留事件入口，便于外部脚本调用）
window.addEventListener('extraction-show-3d', (e) => {
  setSceneVisible('extraction', !!(e.detail && e.detail.active));
  syncDataTreeUI();
});

// ================= 热点图（CSV 玩家坐标密度可视化）=================
// 数据来自 heatdata.js（window.HEAT_POINTS，UE 世界坐标数组），与玩家数据同一套坐标映射：
// ueToLocal(适配镜像/缩放) → modelObject.localToWorld → three 世界坐标。
// 渲染方式：标准热力图管线——把所有点用 'lighter' 混合累加到一张离屏灰度 canvas，
// 再按累积强度归一化后映射为「深蓝→蓝→青→绿→黄→红」调色板，生成一张贴图铺在
// 一块覆盖 XZ 范围的水平平面上（NormalBlending，不过曝），贴地略抬离避免 z-fighting。


// 累积强度[0,1] → 经典热力图配色（透青蓝→青→绿→黄→红），返回 [r,g,b] 0-255
function heatColorRGB(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [
    [0.00, [ 30,  40, 200]], // 深蓝
    [0.25, [ 30, 120, 230]], // 蓝
    [0.45, [ 20, 210, 200]], // 青
    [0.62, [ 40, 220,  60]], // 绿
    [0.80, [245, 230,  30]], // 黄
    [1.00, [230,  30,  25]], // 红
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = (b[0] - a[0]) || 1;
  const k = (t - a[0]) / span;
  return [
    Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
    Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
    Math.round(a[1][2] + (b[1][2] - a[1][2]) * k),
  ];
}

// ================= 热力图（密度可视化）=================
// 与「点云」互斥的另一种显示方式，由「数据内容」面板的「显示方式」切换。
// 设计要点：
//   1) 覆盖范围 = 当前 3D 模型的最外轮廓。范围用模型包围盒，形状用「模型俯视剪影」
//      做遮罩 —— 轮廓外的像素一律不绘制，因此不会溢出到模型之外。
//   2) 只统计「玩家行为」数据；场景点位属于关卡配置标记，不计入密度。
//   3) 颜色深浅完全由点云密度决定，不提供任何人工参数（扩散半径按模型尺寸自动推导）。
//   4) 点位坐标一律走 ueToLocal，与点云使用完全相同的映射（含左右镜像），
//      保证两种显示方式的位置严格一致。
//   5) 平面紧贴 2D 参考图上方并关闭深度测试，俯视时与小地图严格重合、不被建筑遮挡。
let displayMode = 'heatmap';   // 'points' | 'heatmap'（玩家端默认热力图）
let heatPlane = null;         // 承载热力图贴图的平面
// 热力图的扩散范围（真实世界距离，cm）。按此值换算成像素半径，
// 保证不同尺寸的地图扩散程度在物理上一致；不对外暴露为可调参数。
const HEAT_SPREAD_CM = 220;
// 热力图贴图长边分辨率。越大越精细（代价是构建耗时与显存）。
const HEAT_TEX_LONG = 2048;

// 分离式盒式模糊（对 Float32 密度图做一趟水平 + 一趟垂直），多次调用可近似高斯。
// 边缘采用「钳制取样」，避免边界出现暗边。
function boxBlur(src, W, H, r) {
  const win = 2 * r + 1;
  const tmp = new Float32Array(W * H);
  // 水平
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = sum / win;
      const outIdx = row + Math.min(W - 1, Math.max(0, x - r));
      const inIdx = row + Math.min(W - 1, Math.max(0, x + r + 1));
      sum += src[inIdx] - src[outIdx];
    }
  }
  // 垂直
  const dst = new Float32Array(W * H);
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = sum / win;
      const outIdx = Math.min(H - 1, Math.max(0, y - r)) * W + x;
      const inIdx = Math.min(H - 1, Math.max(0, y + r + 1)) * W + x;
      sum += tmp[inIdx] - tmp[outIdx];
    }
  }
  return dst;
}

// 收集参与热力图统计的点，返回 ueRoot 局部坐标 [x, y]
// 【只统计玩家行为数据】场景点位（撤离点/副本入口/宝箱点位/出生点位）属于关卡配置标记，
// 不是玩家行为采样，因此不计入密度；它们在热力图模式下仍以图标形式叠加显示。
// 坐标必须与点云一致地经过 ueToLocal（含 MIRROR_X 镜像），否则两种模式会左右相反。
function collectVisiblePoints() {
  const pts = [];
  POINT_CATEGORIES.forEach((c) => {
    if (!behaviorState[c.key] || !behaviorState[c.key].visible) return;
    filterByMapId(behaviorRaw(c.key)).forEach((p) => {
      const v = ueToLocal({ x: p[0], y: p[1], z: p[2] || 0 });
      pts.push([v.x, v.y]);
    });
  });
  return pts;
}

// 取当前 3D 模型在 ueRoot 局部坐标系（= UE 坐标空间）里的 XY 包围范围
function modelUeBounds() {
  if (!modelObject || !ueRoot) return null;
  modelObject.updateMatrixWorld(true);
  ueRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(modelObject); // three 世界坐标
  if (box.isEmpty() || !isFinite(box.min.x)) return null;
  // 变换回 ueRoot 局部（即 UE 坐标空间）
  const inv = new THREE.Matrix4().copy(ueRoot.matrixWorld).invert();
  box.applyMatrix4(inv);
  return {
    minX: box.min.x, maxX: box.max.x,
    minY: box.min.y, maxY: box.max.y,
    minZ: box.min.z, maxZ: box.max.z,
  };
}

// 把模型的「俯视剪影」渲染成一张遮罩，返回 Uint8Array（长度 W*H，0=轮廓外，255=轮廓内）
// 做法：临时只显示模型 + 全白 override 材质，用正交相机沿 UE -Z 俯拍到 RenderTarget。
// 相机朝向刻意与 canvas 对齐：屏幕右 = UE +X，屏幕上 = UE +Y。
function renderModelMask(b, W, H) {
  if (!renderer || !modelObject || !ueRoot) return null;

  const rt = new THREE.WebGLRenderTarget(W, H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });

  // 1) 记录并临时隐藏 scene 里除模型外的一切
  const hidden = [];
  scene.traverse((o) => {
    if (o === scene || o === ueRoot) return;
    // 模型自身及其子节点保持可见
    let p = o;
    let inModel = false;
    while (p) { if (p === modelObject) { inModel = true; break; } p = p.parent; }
    if (inModel) return;
    if (o.isMesh || o.isSprite || o.isLine || o.isPoints || o.isInstancedMesh) {
      if (o.visible) { hidden.push(o); o.visible = false; }
    }
  });
  const modelWasVisible = modelObject.visible;
  modelObject.visible = true;

  // 2) 正交相机：位于模型上方（UE +Z），朝下俯视
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const halfW = (b.maxX - b.minX) / 2;
  const halfH = (b.maxY - b.minY) / 2;
  const camPosUe = new THREE.Vector3(cx, cy, b.maxZ + 1000);
  const camPos = ueRoot.localToWorld(camPosUe.clone());
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 1, (b.maxZ - b.minZ) + 3000);
  cam.position.copy(camPos);
  // ueRoot 绕 X 轴 -90°：UE +Z → three +Y，UE +Y → three -Z
  //   → 相机朝 three -Y 看（即 UE -Z，俯视），up 取 three -Z（即 UE +Y，对应画面上方）
  cam.up.set(0, 0, -1);
  const lookAt = ueRoot.localToWorld(new THREE.Vector3(cx, cy, b.minZ));
  cam.lookAt(lookAt);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);

  // 3) 全白 override 渲染
  const prevOverride = scene.overrideMaterial;
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  scene.background = null;
  scene.fog = null;

  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(scene, cam);

  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);

  // 4) 还原现场
  renderer.setRenderTarget(prevRT);
  renderer.setClearAlpha(prevClear);
  scene.overrideMaterial.dispose();
  scene.overrideMaterial = prevOverride;
  scene.background = prevBg;
  scene.fog = prevFog;
  modelObject.visible = modelWasVisible;
  hidden.forEach((o) => { o.visible = true; });
  rt.dispose();

  // 5) 转成 mask（WebGL 像素从左下起，canvas ImageData 从左上起 → 需翻转 Y）
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const srcRow = (H - 1 - y) * W;
    const dstRow = y * W;
    for (let x = 0; x < W; x++) {
      // alpha > 0 即被模型覆盖
      mask[dstRow + x] = buf[(srcRow + x) * 4 + 3] > 8 ? 255 : 0;
    }
  }
  return mask;
}

// 构建（或重建）热力图平面
function buildHeatPlane() {
  // 清理旧的
  if (heatPlane) {
    if (heatPlane.parent) heatPlane.parent.remove(heatPlane);
    if (heatPlane.geometry) heatPlane.geometry.dispose();
    if (heatPlane.material) {
      if (heatPlane.material.map) heatPlane.material.map.dispose();
      heatPlane.material.dispose();
    }
    heatPlane = null;
  }
  if (displayMode !== 'heatmap' || !ueRoot) return;

  const b = modelUeBounds();
  if (!b) return;
  const pts = collectVisiblePoints();
  if (!pts.length) {
    console.warn('[热力图] 当前没有勾选任何数据项');
    return;
  }

  const spanX = Math.max(b.maxX - b.minX, 1);
  const spanY = Math.max(b.maxY - b.minY, 1);

  // canvas 分辨率：长边固定 HEAT_TEX_LONG，短边按比例
  const LONG = HEAT_TEX_LONG;
  let W, H;
  if (spanX >= spanY) { W = LONG; H = Math.max(64, Math.round(LONG * spanY / spanX)); }
  else { H = LONG; W = Math.max(64, Math.round(LONG * spanX / spanY)); }

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // 1) 栅格化：按双线性权重把每个点分摊到相邻 4 个像素（亚像素精度，
  //    避免高分辨率下因取整产生的网格状条纹）。
  //    不使用 canvas 的 alpha 累加 —— 它在 255 处会被硬截断，点多时层次全丢。
  let density = new Float32Array(W * H);
  let plotted = 0;
  for (let i = 0; i < pts.length; i++) {
    // ueRoot 局部 XY → canvas 像素。canvas y 轴朝下，UE +Y 对应画面上方，故翻转
    const fx = (pts[i][0] - b.minX) / spanX * (W - 1);
    const fy = (b.maxY - pts[i][1]) / spanY * (H - 1);
    if (fx < 0 || fx > W - 1 || fy < 0 || fy > H - 1) continue;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    density[y0 * W + x0] += (1 - tx) * (1 - ty);
    density[y0 * W + x1] += tx * (1 - ty);
    density[y1 * W + x0] += (1 - tx) * ty;
    density[y1 * W + x1] += tx * ty;
    plotted++;
  }

  // 2) 扩散：3 次盒式模糊近似高斯。半径按「真实世界距离」换算成像素，
  //    这样不同尺寸的地图扩散范围在物理上保持一致（HEAT_SPREAD_CM），无需人工调参。
  //    上限随贴图分辨率放宽，避免高分辨率下扩散被过早截断。
  const cmPerPx = spanX / W;
  const R = Math.max(2, Math.min(Math.round(LONG / 12), Math.round(HEAT_SPREAD_CM / cmPerPx)));
  for (let pass = 0; pass < 3; pass++) density = boxBlur(density, W, H, R);

  // 3) 取模型俯视剪影作为遮罩，轮廓外不参与统计也不绘制
  const mask = renderModelMask(b, W, H);

  // 4) 归一化基准：只统计轮廓内的非零像素，取 99% 分位
  //    用直方图法（而非排序）求分位数 —— 高分辨率下像素数达数百万，排序会明显卡顿。
  let maxV = 0;
  let nonZero = 0;
  for (let px = 0; px < W * H; px++) {
    if (mask && mask[px] === 0) continue;
    const v = density[px];
    if (v > 1e-6) { nonZero++; if (v > maxV) maxV = v; }
  }
  let norm = 1;
  if (nonZero > 0 && maxV > 0) {
    const BUCKETS = 2048;
    const hist = new Uint32Array(BUCKETS);
    for (let px = 0; px < W * H; px++) {
      if (mask && mask[px] === 0) continue;
      const v = density[px];
      if (v <= 1e-6) continue;
      let bi = Math.floor((v / maxV) * (BUCKETS - 1));
      if (bi < 0) bi = 0; else if (bi >= BUCKETS) bi = BUCKETS - 1;
      hist[bi]++;
    }
    const target = nonZero * 0.99;
    let acc = 0;
    let bucket = BUCKETS - 1;
    for (let i = 0; i < BUCKETS; i++) {
      acc += hist[i];
      if (acc >= target) { bucket = i; break; }
    }
    norm = ((bucket + 1) / BUCKETS) * maxV;
    if (!(norm > 0)) norm = maxV;
  }

  // 5) 映射到调色板（颜色深浅完全由密度决定）
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let px = 0; px < W * H; px++) {
    const i = px * 4;
    // 模型轮廓之外一律透明
    if (mask && mask[px] === 0) { d[i + 3] = 0; continue; }
    const raw = density[px] / norm;
    if (raw <= 0.01) { d[i + 3] = 0; continue; }  // 几乎无数据 → 透明
    // gamma 抬升中低密度，使蓝→青→绿→黄→红的过渡更清晰
    const t = Math.min(1, Math.pow(Math.min(1, raw), 0.7));
    const [r, g2, bb] = heatColorRGB(t);
    d[i] = r; d[i + 1] = g2; d[i + 2] = bb;
    // 低密度半透明、高密度接近不透明
    d[i + 3] = Math.round(70 + Math.min(1, t * 1.25) * 165);
  }
  ctx.putImageData(img, 0, 0);

  // 6) 贴到覆盖模型范围的水平平面上（ueRoot 局部空间，XY 平面）
  //    位置：紧贴 2D 参考图上方（参考图所在的 UE Z 平面 + 少量偏移），并关闭深度测试
  //    使其始终绘制在 3D 模型之上 —— 这样俯视时热力图与小地图严格重合、不会被建筑挡住。
  //    renderOrder 介于参考图（-1）与场景点位图标（1000+）之间，保证图标仍浮在最上层。
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // 斜视时提升清晰度
  if (renderer && renderer.capabilities) {
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(spanX, spanY),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true,
      depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, toneMapped: false,
    })
  );
  mesh.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (refParams.z || 0) + 5);
  mesh.renderOrder = 5;
  ueRoot.add(mesh);
  heatPlane = mesh;
  console.log(`[热力图] 落图点数 ${plotted}/${pts.length}  范围 ${Math.round(spanX)}×${Math.round(spanY)}cm  ` +
    `canvas ${W}×${H}  扩散 ${HEAT_SPREAD_CM}cm(${R}px)  归一化基准 ${norm.toFixed(3)}  ` +
    `轮廓遮罩 ${mask ? '已启用' : '不可用'}`);
}

// 应用显示方式：点云 ↔ 热力图
// 玩家行为数据两种方式互斥；场景点位是关卡配置标记，两种方式下都按勾选显示图标。
function applyDisplayMode() {
  const isHeat = displayMode === 'heatmap';
  // 玩家行为散点：热力图模式下隐藏（其密度已由热力图表达）
  POINT_CATEGORIES.forEach((c) => {
    const st = behaviorState[c.key];
    if (st.group) st.group.visible = !isHeat && st.visible;
  });
  // 场景点位图标：始终按勾选显示，便于与热力图对照
  SCENE_CATEGORIES.forEach((c) => {
    const st = sceneState[c.key];
    if (st.group) st.group.visible = st.visible;
  });
  if (isHeat) buildHeatPlane();
  else if (heatPlane) { heatPlane.visible = false; }
  // 「点位大小」只对点云模式有意义，热力图模式下隐藏
  const dotRow = document.getElementById('dotSizeRow');
  if (dotRow) dotRow.hidden = isHeat;
}

// 切换显示方式（供面板与控制台调用）
function setDisplayMode(mode) {
  if (mode !== 'points' && mode !== 'heatmap') return;
  displayMode = mode;
  document.querySelectorAll('#dataModeSwitch .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  applyDisplayMode();
}
window.setDisplayMode = setDisplayMode;

// 所有数据类别共用的光球半径（UE 单位 cm）
// 基准 = 当前地图的 orthoWidth（小地图覆盖的世界范围），与各类别的数据分布无关，
// 因此不同类别、不同筛选条件下的光球大小始终完全一致。
function dotRadius() {
  const meta = MAP_META[currentMapKey] || MAP_META.steel;
  const base = (meta && meta.orthoWidth > 0) ? meta.orthoWidth : 15000;
  return base * (window.__DOT_SCALE || 0.001);
}

// 通用散点构建：把 UE 坐标数组 raw 映射到 three 世界坐标，用 InstancedMesh 渲染小球。
// raw 每项为 [x, y, z, mapId]（mapId 可缺省，兼容旧数据）。
// color: 十六进制颜色；outPoints: 用于回填 three 世界坐标（供聚焦相机）。
// 返回构建好的 Group（visible 默认 false，由调用方控制），无数据返回 null。
function buildDotsGroup(raw, color, outPoints) {
  if (!raw || !raw.length) return null;
  if (!modelObject) return null;
  modelObject.updateMatrixWorld(true);

  // 0) 按「地图筛选」下拉过滤 map_id（heatMapFilter='all' 时不过滤）
  const src = filterByMapId(raw);
  if (!src.length) {
    console.warn(`[散点] 当前地图筛选(${heatMapFilter})下没有数据`);
    return null;
  }

  // 1) UE 坐标 → three 世界坐标
  const world = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    world[i] = ueToLocal({ x: p[0], y: p[1], z: p[2] }); // 已直接返回 three 世界坐标（对齐 2D 小地图）
  }

  // 2) InstancedMesh 渲染散点小球（坐标空间：UE，Z 为高度轴）
  // 半径基准取「当前地图的 orthoWidth」——与具体类别的数据分布无关，
  // 保证所有类别的光球大小完全一致（早期用各自点云跨度会导致大小不一）。
  // 由「数据内容」面板的滑块或控制台 dotSize() 调整，范围 0.00001 ~ 0.003。
  const dot = dotRadius();
  const sphereGeo = new THREE.SphereGeometry(dot, 16, 12);
  const sphereMat = new THREE.MeshBasicMaterial({ color: color, toneMapped: false });
  const inst = new THREE.InstancedMesh(sphereGeo, sphereMat, world.length);
  const mtx = new THREE.Matrix4();
  const lift = dot; // 沿 UE Z 抬起半径高度，避免和地面/参考图 Z-fighting
  for (let i = 0; i < world.length; i++) {
    const v = world[i];
    mtx.makeTranslation(v.x, v.y, v.z + lift);
    inst.setMatrixAt(i, mtx);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.renderOrder = 990;

  const group = new THREE.Group();
  group.add(inst);
  group.visible = false;
  ueRoot.add(group);   // 加到 UE 坐标空间根节点

  if (outPoints) {
    outPoints.length = 0;
    for (let i = 0; i < world.length; i++) outPoints.push(world[i].clone());
  }
  return group;
}

function disposeGroup(g) {
  if (!g) return;
  // 数据/模型/参考图 group 现在挂在 ueRoot 下；父容器可能是 ueRoot 或 scene（兼容）
  if (g.parent) g.parent.remove(g);
  else scene.remove(g);
  // 材质可能是单个 Material，也可能是数组（多材质 mesh）。
  // 统一转成数组逐个 dispose，避免对数组直接调用 .dispose() 报错中断整个卸载流程。
  const disposeMat = (m) => {
    if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach((mat) => {
      if (mat && typeof mat.dispose === 'function') mat.dispose();
    });
  };
  g.traverse((o) => {
    if (o.isSprite) disposeMat(o.material);
    if (o.isMesh || o.isInstancedMesh) {
      if (o.geometry) o.geometry.dispose();
      disposeMat(o.material);
    }
  });
}

// 构建（或重建）单个玩家行为类别的散点
function buildBehavior(key) {
  const st = behaviorState[key];
  if (!st) return;
  disposeGroup(st.group);
  st.group = null;
  st.points3d.length = 0;
  st.built = false;

  const raw = behaviorRaw(key);
  if (!raw.length) return;
  if (!modelObject) return;

  const colorHex = new THREE.Color(st.color).getHex();
  st.group = buildDotsGroup(raw, colorHex, st.points3d);
  if (st.group) st.group.visible = st.visible;
  st.built = true;
}

// 重建所有已开启的类别（切换地图筛选 / 点位大小 / 镜像后调用）
function rebuildBehaviors(onlyVisible) {
  POINT_CATEGORIES.forEach((c) => {
    const st = behaviorState[c.key];
    if (onlyVisible && !st.visible && !st.built) return;
    buildBehavior(c.key);
  });
}

// 设置某类别显隐（首次开启时才构建，避免一次性建 30 万点）
function setBehaviorVisible(key, on) {
  const st = behaviorState[key];
  if (!st) return;
  st.visible = !!on;
  if (st.visible && !st.built && modelObject) buildBehavior(key);
  if (st.group) st.group.visible = st.visible;
}

// 修改某类别颜色（十六进制字符串，如 '#ff0000'）
function setBehaviorColor(key, hex) {
  const st = behaviorState[key];
  if (!st) return;
  st.color = hex;
  // 已构建则直接改材质颜色，无需重建几何
  if (st.group) {
    st.group.traverse((o) => {
      if (o.isInstancedMesh && o.material) o.material.color.set(hex);
    });
  }
}

// 控制台调整散点球尺寸：dotSize()  打印当前倍率；dotSize(0.002) 设置后重建
// 数值是「相对于点云 X 跨度」的比例，默认 0.001，面板可调范围 0.00001 ~ 0.003；越大球越明显。
window.dotSize = function (v) {
  if (v === undefined) return window.__DOT_SCALE || 0.001;
  window.__DOT_SCALE = +v || 0.001;
  if (modelObject) rebuildBehaviors(true);
  return window.__DOT_SCALE;
};

// 统一重建：玩家事件点 + 数据类别散点，二者共用同一套 UE 坐标映射
function rebuildPlayerViz() {
  buildPlayerData();
  if (modelObject) rebuildBehaviors(true);
}
window.rebuildPlayerViz = rebuildPlayerViz;

// 某类别点云的包围盒（three 世界坐标），供聚焦相机
function getBehaviorBounds(key) {
  const st = behaviorState[key];
  if (!st || !st.points3d.length) return null;
  const box = new THREE.Box3();
  st.points3d.forEach((p) => box.expandByPoint(p));
  return box;
}

// 把相机移到某类别数据上方俯视
function focusBehavior(key) {
  const box = getBehaviorBounds(key);
  if (!box || !camera) { console.warn('[数据内容] 该类别数据尚未生成'); return; }
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const span = Math.max(s.x, s.z, 1);
  camera.position.set(c.x, c.y + span * 0.9 + 500, c.z + 0.001);
  yaw = 0;
  pitch = -Math.PI / 2 + 0.0001;
  updateCameraRotation();
}

// 聚焦当前所有已显示类别的整体范围
function focusVisibleBehaviors() {
  const box = new THREE.Box3();
  let has = false;
  POINT_CATEGORIES.forEach((cat) => {
    const st = behaviorState[cat.key];
    if (!st.visible || !st.points3d.length) return;
    st.points3d.forEach((p) => box.expandByPoint(p));
    has = true;
  });
  if (!has || !camera) return;
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const span = Math.max(s.x, s.z, 1);
  camera.position.set(c.x, c.y + span * 0.9 + 500, c.z + 0.001);
  yaw = 0;
  pitch = -Math.PI / 2 + 0.0001;
  updateCameraRotation();
}

// ===== 控制台命令 =====
// dataShow('death')        切换某类别显隐
// dataShow('death', true)  显式开启
// dataColor('death', '#f00') 改颜色
// dataFocus('death')       聚焦该类别
// dataList()               列出所有类别及点数/状态
window.dataShow = function (key, on) {
  if (sceneState[key]) {
    setSceneVisible(key, on === undefined ? !sceneState[key].visible : on);
    applyDisplayMode();
    syncDataTreeUI();
    return sceneState[key].visible;
  }
  const st = behaviorState[key];
  if (!st) { console.warn('未知类别：' + key); return; }
  setBehaviorVisible(key, on === undefined ? !st.visible : on);
  applyDisplayMode();
  syncDataTreeUI();
  return st.visible;
};
window.dataColor = function (key, hex) {
  if (!behaviorState[key]) { console.warn('未知类别：' + key); return; }
  if (hex === undefined) return behaviorState[key].color;
  setBehaviorColor(key, hex);
  syncDataTreeUI();
  return behaviorState[key].color;
};
window.dataFocus = function (key) {
  if (key === undefined) { focusVisibleBehaviors(); return '已聚焦所有已显示类别'; }
  focusBehavior(key);
  return '已聚焦 ' + key;
};
window.dataList = function () {
  const mid = currentSceneMapId();
  console.log(`%c[数据内容 · 场景点位]  当前难度档位 = ${mid} ${HEAT_MAP_NAMES[mid] || ''}`,
    'color:#f5c542;font-weight:bold');
  SCENE_CATEGORIES.forEach((c) => {
    const st = sceneState[c.key];
    console.log(`  ${st.visible ? '☑' : '☐'} ${c.name}(${c.key})  点数 ${sceneRaw(c.key).length}` +
      (c.ring > 0 ? `  触发半径 ${c.ring}cm` : ''));
  });
  console.log('%c[数据内容 · 玩家行为]', 'color:#f5c542;font-weight:bold');
  BEHAVIOR_CATEGORIES.forEach((c) => {
    const st = behaviorState[c.key];
    const total = behaviorRaw(c.key).length;
    const shown = filterByMapId(behaviorRaw(c.key)).length;
    console.log(`  ${st.visible ? '☑' : '☐'} ${c.name}(${c.key})  颜色=${st.color}  ` +
      `当前筛选 ${shown} / 共 ${total}`);
  });
  return { scene: sceneState, behavior: behaviorState };
};

// 由视图切换触发的自定义事件（保留以兼容外部调用）
window.addEventListener('enter3d', start);
window.addEventListener('leave3d', stop);

// 本工具只有 3D 视图：模块加载完成后立即启动。
// （script.js 是同步脚本，会先于本模块执行并派发 enter3d，那时监听还没注册，
//   因此这里必须主动启动一次，否则首屏不会渲染。）
start();

// 切换地图：复用钢铁厂完全相同的旋转逻辑（-90° X 躺平 + MODEL_YAW）
function switchMap(key) {
  if (!MAP_MODELS[key] || key === currentMapKey) return;
  currentMapKey = key;
  // 切换地图后不再使用钢铁厂专属固定视角，改用按各自模型尺寸自适应的俯视视角，
  // 避免相机停在旧地图坐标上导致新模型跑出画面「看不见」。
  useInitialView = false;
  // 「3D 模型」面板的调整按地图独立保存，切换后把新地图的偏移值同步到输入框
  syncModelPanelInputs();
  // 「地图筛选」只列当前地图的难度档位，切换后重建下拉（必要时回落为「全部」）
  rebuildMapFilterOptions();
  // 已初始化过 3D 场景才需要即时重载模型；否则等首次 enter3d 时按 currentMapKey 加载
  if (initialized) {
    loadModel();
  }
}
window.switchMap = switchMap;
// 查看/打印各地图的「3D 模型」调整参数（按地图独立保存）
// modelXform()        —— 人类可读的概览
// modelXformCode()    —— 输出可直接粘贴回 view3d.js 的默认值代码，便于把调好的参数固化
window.modelXform = function () {
  console.log('%c[3D 模型调整 · 按地图独立]', 'color:#f5c542;font-weight:bold');
  Object.keys(MODEL_XFORMS).forEach((k) => {
    const X = MODEL_XFORMS[k];
    const tag = (k === currentMapKey) ? ' ← 当前' : '';
    console.log(`  ${k}${tag}: rot(Z=${X.rotYaw90 * 90}°, X=${X.rotPitch90 * 90}°, Y=${X.rotRoll90 * 90}°) ` +
      `flip(${X.flipX},${X.flipY},${X.flipZ}) offset(${X.offsetX},${X.offsetY},${X.offsetZ})`);
  });
  console.log('%c提示：执行 modelXformCode() 可导出用于固化的代码。', 'color:#8fd');
  return MODEL_XFORMS;
};

// 导出当前各地图的模型变换为「可固化的默认值代码」
window.modelXformCode = function () {
  const fmt = (k) => {
    const X = MODEL_XFORMS[k];
    return `  ${k}: { rotYaw90: ${X.rotYaw90}, rotPitch90: ${X.rotPitch90}, rotRoll90: ${X.rotRoll90}, ` +
      `flipX: ${X.flipX}, flipY: ${X.flipY}, flipZ: ${X.flipZ}, ` +
      `offsetX: ${X.offsetX}, offsetY: ${X.offsetY}, offsetZ: ${X.offsetZ} },`;
  };
  const body = Object.keys(MODEL_XFORMS).map(fmt).join('\n');
  const code = 'const MODEL_XFORM_DEFAULTS = {\n' + body + '\n};';
  console.log('%c[导出] 复制下面整段发给开发者即可固化为默认参数：', 'color:#23d160;font-weight:bold');
  console.log('%c' + code, 'color:#8fd;font-size:13px');
  return code;
};

// 控制台控制模型显隐 / 透明度（与面板双向同步）
window.modelShow = function (b) {
  modelVisible = (b === undefined) ? !modelVisible : !!b;
  const el = document.getElementById('modelShow');
  if (el) el.checked = modelVisible;
  applyModelDisplay();
  return modelVisible;
};
window.modelOpacity = function (v) {
  if (v === undefined) return modelOpacity;
  modelOpacity = Math.max(0, Math.min(1, +v || 0));
  const r = document.getElementById('modelOpacityRange');
  const i = document.getElementById('modelOpacityInput');
  if (r) r.value = String(modelOpacity);
  if (i) i.value = modelOpacity.toFixed(2);
  applyModelDisplay();
  return modelOpacity;
};
window.addEventListener('switch-map', function (e) {
  switchMap(e.detail && e.detail.map);
});
