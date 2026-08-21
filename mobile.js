/* ================= 手机竖屏 H5 版启动与交互 =================
 * 本文件替代桌面版 script.js：只保留玩家需要的功能
 *   - 启动 3D 视图（给 #view3d 加 visible，view3d.js 模块随后自启动）
 *   - 地图切换（钢铁厂 / 电子城）
 *   - 投影切换（透视 / 俯视）
 *   - 复位视角
 *   - 数据内容底部抽屉展开 / 收起
 *   - 首次操作提示
 * 已阉割：日志转表、模型调整、操控速度、参考图面板、脱离卡死、玩家撤离
 */
(function () {
  'use strict';

  // 各地图的 2D 小地图底图（view3d.js 会读取 window.MAP_2D_IMAGES）
  window.MAP_2D_IMAGES = {
    steel: 'assets/map-steelfactory.jpg',
    electronic: 'assets/map-E-Market.jpg',
  };

  var view3d = document.getElementById('view3d');
  var mapSwitch = document.getElementById('mapSwitch');
  var projSwitch = document.getElementById('projSwitch');

  // ---- 启动：进入 3D 视图（务必在 view3d.js 模块自启动前完成）----
  if (view3d) view3d.classList.add('visible');
  window.dispatchEvent(new CustomEvent('enter3d'));

  // ---- 地图切换 ----
  var currentMap = 'steel';
  if (mapSwitch) {
    mapSwitch.addEventListener('click', function (e) {
      var tab = e.target.closest('.map-tab');
      if (!tab) return;
      var key = tab.getAttribute('data-map');
      if (key === currentMap) return;
      currentMap = key;
      mapSwitch.querySelectorAll('.map-tab').forEach(function (t) {
        t.classList.toggle('active', t === tab);
      });
      window.dispatchEvent(new CustomEvent('switch-map', { detail: { map: key } }));
    });
  }

  // ---- 投影切换（透视 / 俯视）----
  if (projSwitch) {
    projSwitch.addEventListener('click', function (e) {
      var tab = e.target.closest('.view-tab');
      if (!tab || tab.disabled) return;
      if (typeof window.setProjection === 'function') {
        window.setProjection(tab.getAttribute('data-proj'));
      }
      projSwitch.querySelectorAll('.view-tab').forEach(function (t) {
        t.classList.toggle('active', t === tab);
      });
    });
  }

  // ---- 复位视角（复用 view3d.js 的 R 键逻辑）----
  var btnReset = document.getElementById('mBtnReset');
  if (btnReset) {
    btnReset.addEventListener('click', function () {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'r' }));
    });
  }

  // ---- 数据内容底部抽屉（可拖拽滑动 + 轻点切换）----
  var sheet = document.getElementById('heatmapPanel');
  var handle = document.getElementById('mSheetHandle');
  if (sheet && handle) {
    var dragging = false;
    var startY = 0;      // 手指起始 Y
    var baseY = 0;       // 拖动起始时抽屉的 translateY
    var curY = 0;        // 当前 translateY
    var moved = 0;       // 累计位移（判断是否为轻点）

    // 收起状态下抽屉下移的距离 = 抽屉高度 - 手柄高度
    function collapsedOffset() {
      return Math.max(0, sheet.offsetHeight - handle.offsetHeight);
    }

    function onDown(clientY) {
      dragging = true;
      moved = 0;
      startY = clientY;
      baseY = sheet.classList.contains('collapsed') ? collapsedOffset() : 0;
      curY = baseY;
      sheet.classList.add('m-dragging'); // 关闭 transition，拖动跟手
    }
    function onMove(clientY) {
      if (!dragging) return;
      var dy = clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      curY = Math.min(collapsedOffset(), Math.max(0, baseY + dy));
      sheet.style.transform = 'translateY(' + curY + 'px)';
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('m-dragging');
      sheet.style.transform = '';        // 交还给 CSS class 控制
      var off = collapsedOffset();
      if (moved < 8) {
        // 轻点：直接切换
        sheet.classList.toggle('collapsed');
      } else {
        // 拖动：按当前位置过半吸附
        sheet.classList.toggle('collapsed', curY > off / 2);
      }
    }

    // 触摸
    handle.addEventListener('touchstart', function (e) {
      onDown(e.touches[0].clientY); e.preventDefault();
    }, { passive: false });
    handle.addEventListener('touchmove', function (e) {
      onMove(e.touches[0].clientY); e.preventDefault();
    }, { passive: false });
    handle.addEventListener('touchend', onUp);
    handle.addEventListener('touchcancel', onUp);

    // 鼠标（桌面调试兼容）
    handle.addEventListener('mousedown', function (e) { onDown(e.clientY); });
    window.addEventListener('mousemove', function (e) { if (dragging) onMove(e.clientY); });
    window.addEventListener('mouseup', onUp);
  }

  // ---- 首次操作提示 ----
  var tips = document.getElementById('mTips');
  var tipsClose = document.getElementById('mTipsClose');
  if (tips && tipsClose) {
    tipsClose.addEventListener('click', function () {
      tips.classList.add('hidden');
    });
  }

  // ---- 阻止页面级触摸滚动 / 双指缩放整页（画布交互不受影响）----
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
})();
