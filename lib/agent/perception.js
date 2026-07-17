/**
 * perception.js - 混合感知模块
 *
 * 为什么独立一个模块：感知是 Agent 的"眼睛"，职责单一（dump 无障碍树 + 截图），
 * 方便后续替换实现（比如换成 uiautomator2-server 或 minicap）时不影响上层决策。
 *
 * 数据流：
 *   auto.windowRoots() → 遍历 AccessibilityNodeInfo → 过滤/去重 → tree_summary
 *   captureScreen()    → images.save()              → screenshot_path
 *
 * 返回：{ tree_summary: Array<NodeSummary>, screenshot_path: string }
 *   NodeSummary = { text, resource_id, bounds, clickable, bounds_zero? }
 *
 * AutoJS Rhino 兼容：用 let / var，不用 async/await、箭头函数（部分版本不支持）、
 * 不用 Object.assign（用自己写的浅合并）。
 */

// 截图保存目录（为什么用 /sdcard：AutoJS 对外部存储有权限，VL 后续读取 base64 也方便）
var SCREENSHOT_DIR = '/sdcard/agent_screens'
// 树摘要最大节点数（超过则截断，避免传给 VL 的 prompt 过长）
var MAX_NODES = 50
// 系统包前缀，这些包的节点对蚂蚁森林场景没用，直接过滤
var SYSTEM_PACKAGE_PREFIXES = ['com.android.systemui', 'com.android.internal']

/**
 * 判断字符串是否为空或仅空白
 * @param {string} val
 * @returns {boolean}
 */
function isEmpty (val) {
  return val === null || typeof val === 'undefined' || val === ''
}

/**
 * 安全获取控件属性，任何异常都返回默认值
 * 为什么包 try-catch：AccessibilityNodeInfo 在 H5/WebView 场景下经常抛 NPE，
 * 单个节点获取失败不应该中断整个 dump
 * @param {function} getter 取值函数
 * @param {*} defaultVal 默认值
 * @returns {*}
 */
function safeGet (getter, defaultVal) {
  try {
    var v = getter()
    return v === null ? defaultVal : v
  } catch (e) {
    return defaultVal
  }
}

/**
 * 判断给定包名是否是系统 UI 包（状态栏/导航栏/输入法等），这些节点对识别蚂蚁森林无意义
 * @param {string} pkg
 * @returns {boolean}
 */
function isSystemPackage (pkg) {
  if (isEmpty(pkg)) return false
  for (var i = 0; i < SYSTEM_PACKAGE_PREFIXES.length; i++) {
    if (pkg === SYSTEM_PACKAGE_PREFIXES[i] || pkg.indexOf(SYSTEM_PACKAGE_PREFIXES[i] + '.') === 0) {
      return true
    }
  }
  return false
}

/**
 * 从 bounds Rect 字符串 "[x1,y1][x2,y2]" 解析为 {left, top, right, bottom, width, height}
 * 为什么自己解析：AutoJS 的 node.bounds() 返回 android.graphics.Rect，但不同版本 API 差异大，
 * 统一用 bounds() 拿 Rect 再读字段最稳
 * @param {android.graphics.Rect} rect
 * @returns {object}
 */
function parseRect (rect) {
  if (!rect) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  var left = safeGet(function () { return rect.left }, 0)
  var top = safeGet(function () { return rect.top }, 0)
  var right = safeGet(function () { return rect.right }, 0)
  var bottom = safeGet(function () { return rect.bottom }, 0)
  return {
    left: left,
    top: top,
    right: right,
    bottom: bottom,
    width: right - left,
    height: bottom - top
  }
}

/**
 * 判断 bounds 是否全零（H5/WebView 节点常见的坑）
 * 为什么单独检测：蚂蚁森林是 H5 页面，部分 WebView 内部节点 bounds 报 [0,0][0,0]，
 * VL（视觉语言模型）看到 bounds_zero 标记后知道这类节点定位不可靠，要靠截图判断
 * @param {object} parsedRect parseRect 的返回值
 * @returns {boolean}
 */
function isBoundsZero (parsedRect) {
  return parsedRect.left === 0 && parsedRect.top === 0 && parsedRect.right === 0 && parsedRect.bottom === 0
}

/**
 * 把单个 AccessibilityNodeInfo 提炼成摘要对象
 * @param {android.view.accessibility.AccessibilityNodeInfo} node
 * @returns {object|null} 返回 null 表示该节点应该被过滤掉
 */
function summarizeNode (node) {
  if (!node) return null

  var text = safeGet(function () { return node.text() }, '')
  var resId = safeGet(function () { return node.viewIdResourceName() }, '')
  var rect = parseRect(safeGet(function () { return node.bounds() }, null))
  var clickable = safeGet(function () { return node.isClickable() }, false)
  var pkg = safeGet(function () { return node.getPackageName() }, '')

  // 过滤无信息的空节点：text 和 resource_id 都空的节点对识别没用
  if (isEmpty(text) && isEmpty(resId)) {
    return null
  }
  // 过滤系统 UI 节点
  if (isSystemPackage(pkg)) {
    return null
  }

  var summary = {
    text: String(text || ''),
    resource_id: String(resId || ''),
    bounds: '[' + rect.left + ',' + rect.top + '][' + rect.right + ',' + rect.bottom + ']',
    clickable: !!clickable
  }

  // H5 节点 bounds 全零时加标记，VL 据此切到纯视觉定位
  if (isBoundsZero(rect)) {
    summary.bounds_zero = true
  }

  return summary
}

/**
 * 递归遍历无障碍节点树，收集摘要
 * 为什么用递归而非 BFS：蚂蚁森林页面层级不深（一般 < 15 层），递归更直观；
 * 加深度上限保护避免极端场景栈溢出
 * @param {android.view.accessibility.AccessibilityNodeInfo} node 当前节点
 * @param {Array} out 收集数组
 * @param {object} seen 去重字典（key = text|resId|bounds）
 * @param {number} depth 当前深度
 * @param {number} maxDepth 最大深度
 */
function traverseNode (node, out, seen, depth, maxDepth) {
  if (!node || out.length >= MAX_NODES || depth > maxDepth) {
    return
  }

  var summary = summarizeNode(node)
  if (summary) {
    var key = summary.text + '|' + summary.resource_id + '|' + summary.bounds
    if (!seen[key]) {
      seen[key] = true
      out.push(summary)
    }
  }

  // 递归子节点
  var childCount = safeGet(function () { return node.getChildCount() }, 0)
  for (var i = 0; i < childCount && out.length < MAX_NODES; i++) {
    var child = safeGet(function () { return node.getChild(i) }, null)
    if (child) {
      traverseNode(child, out, seen, depth + 1, maxDepth)
    }
  }
}

/**
 * 获取所有窗口根节点，遍历生成树摘要
 * 为什么用 windowRoots() 而不是 auto.rootInActiveWindow：
 *   windowRoots() 能拿到弹窗/悬浮窗等多窗口，覆盖更全；
 *   auto.rootInActiveWindow 只返回活跃窗口根，会漏掉对话框。
 * @returns {Array}
 */
function dumpTreeSummary () {
  var roots = []
  try {
    var bridge = runtime.getAccessibilityBridge()
    var windowRoots = bridge.windowRoots()
    if (windowRoots && windowRoots.size() > 0) {
      // 倒序遍历：windowRoots 列表靠后的是顶层窗口（最新的弹窗在前台）
      for (var i = windowRoots.size() - 1; i >= 0; i--) {
        var root = windowRoots.get(i)
        if (root) {
          roots.push(root)
        }
      }
    }
  } catch (e) {
    // windowRoots 拿不到则降级用 auto.rootInActiveWindow
    try {
      var fallback = auto.rootInActiveWindow
      if (fallback) {
        roots.push(fallback)
      }
    } catch (e2) {
      console.warn('perception.dumpTreeSummary 获取根节点失败: ' + e2)
    }
  }

  var out = []
  var seen = {}
  for (var r = 0; r < roots.length && out.length < MAX_NODES; r++) {
    traverseNode(roots[r], out, seen, 0, 20)
  }
  return out
}

/**
 * 截图并保存到文件，返回文件路径
 * 为什么走 captureScreen 而非 adb screencap：AutoJS 的截图在脚本进程内完成，
 * 无需 shell 权限，兼容性更好；失败时返回空字符串让上层判断。
 * @returns {string} 截图文件绝对路径，失败返回 ''
 */
function captureAndSave () {
  try {
    // 确保目录存在
    files.ensureDir(SCREENSHOT_DIR + '/')
    var timestamp = new Date().getTime()
    var path = SCREENSHOT_DIR + '/perceive_' + timestamp + '.png'

    var img = captureScreen()
    if (!img) {
      console.warn('perception.captureAndSave captureScreen 返回空')
      return ''
    }
    images.save(img, path)
    // 回收截图，避免内存泄漏（AutoJS ImageWrapper 不回收会 OOM）
    if (img && img.recycle) {
      img.recycle()
    }
    return path
  } catch (e) {
    console.warn('perception.captureAndSave 截图保存失败: ' + e)
    return ''
  }
}

/**
 * 混合感知入口：dump 无障碍树 + 截图，返回 VL 决策所需的完整上下文
 *
 * 使用前需要确保：
 *   1. 无障碍服务已开启（auto.waitFor() 或通过 commonFunctions.ensureAccessibilityEnabled）
 *   2. 截图权限已申请（requestScreenCapture）
 *
 * @returns {{tree_summary: Array, screenshot_path: string}}
 */
function perceive () {
  var treeSummary = dumpTreeSummary()
  var screenshotPath = captureAndSave()
  return {
    tree_summary: treeSummary,
    screenshot_path: screenshotPath
  }
}

module.exports = {
  perceive: perceive
}
