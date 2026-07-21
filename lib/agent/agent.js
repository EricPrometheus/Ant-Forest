/**
 * @file lib/agent/agent.js - agent 主循环（Issue #6）
 *
 * 【职责】
 *   串起 perception → vl_client.decide → executor.execute 的反馈循环，
 *   管理历史动作队列 + 连续失败计数，VL 返回 finish 或连续失败达上限时退出。
 *
 * 【为什么需要主循环而不是一次性流程】
 *   蚂蚁森林界面是动态的：点一下能量球、滑一下列表，UI 都会变，
 *   VL 需要根据最新截图反复决策，直到任务完成或判定无法继续。
 *
 * 【进程级初始化契约】
 *   call_sub（sub_processes.js）依赖一系列只在进程启动时执行一次的初始化：
 *     1. require config.js / SingletonRequirer.js（单例工厂）
 *     2. require modules/init_if_needed.js（运行时环境补齐）
 *     3. 加载 color-region-center.dex / autojs-common.dex（颜色识别等扩展）
 *     4. ensureAccessibilityEnabled（无障碍服务）
 *     5. unlocker.exec（解锁屏幕）
 *     6. requestScreenCaptureOrRestart（截图权限）
 *     7. FloatyInstance.init（悬浮窗）
 *   initEnv() 按此顺序幂等执行：已初始化则跳过，避免重复申请权限/弹窗。
 *
 * 【失败计数策略】
 *   - VL/执行失败（返回 success=false 或 vl 降级到 wait）累加 fail_count
 *   - 成功执行一步（success=true）清零 fail_count
 *   - fail_count ≥ MAX_FAIL(5) 退出，记录 errorInfo
 *   这样能避免在界面卡死 / VL 连续幻觉时空转耗 token
 *
 * 【历史队列设计】
 *   最近 10 步 {action, params, reason, result_success} 喂给 vl_client.decide，
 *   VL 看到历史后不会反复点同一坐标（降低抖动）。
 *   只存关键字段，perception_summary 用 tree_summary 前 5 条精简，避免 prompt 过长。
 *
 * @author AI Agent Forest
 */

let { config } = require('../../config.js')(runtime, global)
let singletonRequire = require('../SingletonRequirer.js')(runtime, global)
let commonFunctions = singletonRequire('CommonFunction')
let _logUtils = singletonRequire('LogUtils')
let { logInfo, errorInfo, warnInfo, debugInfo } = _logUtils
let FloatyInstance = singletonRequire('FloatyUtil')
let FileUtils = singletonRequire('FileUtils')
let runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')

// 子模块（延迟 require，等初始化环境就绪后再拿，确保 automator/call_sub 能拿到单例）
var perception = require('./perception.js')
var vlClient = require('./vl_client.js')
var executor = require('./executor.js')

// ============================ 常量 ============================

/** 连续失败上限：达到后退出主循环，避免空转 */
var MAX_FAIL = 5

/** 主循环每步间隔（ms）：给界面动画/加载留时间，避免过快点击 */
var STEP_INTERVAL_MS = 500

/** 历史队列上限（喂 VL 的最近步数） */
var HISTORY_MAX = 10

/** 喂 VL 的 tree_summary 条数（避免 prompt 过长） */
var PERCEPTION_SUMMARY_SLICE = 5

/**
 * 连续重复同一动作（同 action+params）的容忍上限。
 * 达到后给 VL 注入"已重复 N 次无效果，请换策略"提示，并累加 failCount，
 * 避免 VL 卡在对同一坐标反复点击（如点不掉的弹窗）空转。
 */
var MAX_REPEAT = 3

/**
 * 连续 VL 失败（reason 以 vl_failed 开头，即 vl_client 降级返回的 wait）的上限。
 * 【为什么单独计数】VL 降级返回 {action:wait}，executor 执行 wait 成功会清零 failCount，
 * 导致网络全断 / API 持续失败时 agent 永远到不了 MAX_FAIL，无限空转烧 token。
 * 用独立的 vlFailCount 累加 VL 侧失败，达上限强制退出。
 */
var MAX_VL_FAIL = 5

// ============================ 进程级初始化（幂等） ============================

/**
 * 进程级初始化状态标记。
 * 为什么用模块级闭包变量：initEnv 在同一进程内会被多次调用（run 多任务），
 * 用闭包标记保证只真正执行一次，符合"进程级初始化"契约。
 */
var _envInitialized = false

/**
 * 进程级环境初始化。
 *
 * 按 main.js 开头的顺序执行：
 *   init_if_needed → dex 加载 → 无障碍 → 解锁 → 截图权限 → 悬浮窗
 *
 * 幂等：已初始化直接返回 true，不重跑。
 * 失败：任一关键步骤失败返回 false，调用方决定是否退出。
 *
 * @returns {boolean} 初始化是否成功
 */
function initEnv () {
  if (_envInitialized) {
    debugInfo('[agent] initEnv 已初始化，跳过')
    return true
  }

  logInfo('[agent] ====== 开始进程级初始化 ======')

  // 1. 运行时环境补齐（必须在最早，补齐后续需要的全局对象）
  try {
    require('../../modules/init_if_needed.js')(runtime, global)
  } catch (e) {
    errorInfo('[agent] init_if_needed 失败：' + e)
    return false
  }

  // 2. 加载 dex（颜色识别等扩展，call_sub 内的 Ant_forest 依赖）
  try {
    var resolver = require('../AutoJSRemoveDexResolver.js')
    resolver()
    checkAndLoadDex('../../lib/color-region-center.dex')
    checkAndLoadDex('../../lib/autojs-common.dex')
    logInfo('[agent] dex 加载完成')
  } catch (e) {
    errorInfo('[agent] dex 加载失败：' + e)
    return false
  }

  // 3. 无障碍服务（perception dumpTreeSummary + automator 点击依赖）
  if (!commonFunctions.ensureAccessibilityEnabled()) {
    errorInfo('[agent] 无障碍服务启用失败')
    return false
  }
  commonFunctions.markExtendSuccess && commonFunctions.markExtendSuccess()

  // 4. 解锁屏幕（定时任务触发时设备可能锁屏）
  try {
    var unlocker = require('../Unlock.js')
    unlocker.exec()
    logInfo('[agent] 解锁完成')
  } catch (e) {
    errorInfo('[agent] 解锁异常：' + e)
    // 解锁失败不立即退出：如果是亮屏运行，解锁可能不需要
    warnInfo('[agent] 解锁异常，继续尝试后续步骤')
  }

  // 5. 截图权限（perception.captureAndSave 依赖）
  try {
    if (typeof commonFunctions.requestScreenCaptureOrRestart === 'function') {
      commonFunctions.requestScreenCaptureOrRestart()
    } else if (!requestScreenCapture(false)) {
      warnInfo('[agent] requestScreenCapture 返回 false，截图可能不可用')
    }
    if (typeof commonFunctions.ensureDeviceSizeValid === 'function') {
      commonFunctions.ensureDeviceSizeValid()
    }
  } catch (e) {
    errorInfo('[agent] 截图权限申请失败：' + e)
    return false
  }

  // 6. 悬浮窗（main.js 执行流程依赖 FloatyInstance）
  try {
    if (!FloatyInstance.init()) {
      errorInfo('[agent] 悬浮窗初始化失败')
      return false
    }
  } catch (e) {
    errorInfo('[agent] 悬浮窗初始化异常：' + e)
    return false
  }

  _envInitialized = true
  logInfo('[agent] ====== 进程级初始化完成 ======')
  return true
}

/**
 * 重置初始化标记（仅用于测试：强制下次 initEnv 重跑）。
 */
function _resetInitFlag () {
  _envInitialized = false
}

// ============================ 进入蚂蚁森林 ============================

/**
 * 深链进入蚂蚁森林主页。
 *
 * 【为什么需要】run.js 经 RunIntentActivity 启动，困鱼 UI 留在前台，
 * agent 不主动切支付宝的话 VL 一直看到 AutoJS 界面，只能 wait。
 * 主循环前先深链把蚂蚁森林拉到前台，VL 才能基于真实界面决策。
 *
 * 【实现】复用 core/Ant_forest.js startApp 的核心逻辑（深链 appId=60000002），
 * 但不 require 整个 Ant_forest（会触发 OpenCvUtil→importClass dex 链）。
 * app.startActivity 失败时用 shell am start 兜底。
 *
 * 【为什么不检测是否已在森林】深链重复进入只会刷新页面，代价小；
 * 而准确检测"在森林"需识别 J_treeCanvas 等 H5 节点（bounds 0,0 不可靠），
 * 检测成本 > 直接重进的代价。简单优先。
 */
function ensureInAntForest () {
  logInfo('[agent] 深链进入蚂蚁森林')
  var scheme = 'alipays://platformapi/startapp?appId=60000002'
  try {
    var pkg = config.package_name || 'com.eg.android.AlipayGphone'
    app.startActivity({ action: 'VIEW', data: scheme, packageName: pkg })
  } catch (e) {
    warnInfo('[agent] app.startActivity 异常，shell 兜底：' + e)
    try {
      shell("am start -a android.intent.action.VIEW -d '" + scheme + "'", true)
    } catch (e2) {
      errorInfo('[agent] 深链进入也失败：' + e2)
    }
  }
  // 首次进入等久一点（支付宝冷启动 + H5 加载）
  sleep(3000)
}

// ============================ 历史队列 ============================

/**
 * 把一步决策 + 结果摘要推入历史队列。
 * 队列长度超过 HISTORY_MAX 时移除最旧的一条（FIFO）。
 *
 * @param {Array}  history     历史队列（会被原地修改）
 * @param {object} action      VL 返回的动作 {action, params, reason}
 * @param {object} result      executor 返回 {success, finished?, ...}
 * @param {Array}  treeSummary perception 返回的 tree_summary（取前 N 条摘要）
 */
function pushHistory (history, action, result, treeSummary) {
  var entry = {
    action: action.action,
    params: action.params,
    reason: action.reason,
    result_success: !!(result && result.success),
    result_finished: !!(result && result.finished),
    perception_summary: (treeSummary || []).slice(0, PERCEPTION_SUMMARY_SLICE)
  }
  history.push(entry)
  // 超长则移除最旧（保持最近 HISTORY_MAX 步）
  while (history.length > HISTORY_MAX) {
    history.shift()
  }
}

// ============================ 主循环 run ============================

/**
 * agent 主循环入口。
 *
 * 流程：
 *   initEnv() → while (not finished && fail_count < MAX_FAIL):
 *     perceive → decide(vl) → execute → pushHistory → 更新 fail_count
 *
 * @param {string} task    任务描述（"收自己能量"/"逛一逛"/"森林集市"）
 * @param {object} [options] 预留扩展位
 * @returns {{task:string, success:boolean, steps:number, fail_count:number, finished:boolean, error?:string}}
 */
function run (task, options) {
  options = options || {}
  if (!task || typeof task !== 'string') {
    errorInfo('[agent] task 必须是非空字符串')
    return { task: '', success: false, steps: 0, fail_count: 0, finished: false, error: 'invalid_task' }
  }

  logInfo('[agent] ====== 开始执行任务：' + task + ' ======')

  // 进程级初始化（幂等）
  if (!initEnv()) {
    errorInfo('[agent] 进程级初始化失败，任务终止')
    return { task: task, success: false, steps: 0, fail_count: 0, finished: false, error: 'init_failed' }
  }

  // 深链进入蚂蚁森林（避免 VL 停在 AutoJS 界面一直 wait）
  ensureInAntForest()

  // 循环状态
  var history = []
  var failCount = 0
  var vlFailCount = 0
  var steps = 0
  var finished = false
  var lastActionKey = null
  var repeatCount = 0

  while (!finished && failCount < MAX_FAIL && vlFailCount < MAX_VL_FAIL) {
    steps++
    logInfo('[agent] ====== 第 ' + steps + ' 步循环开始 ======')

    // --- 1. 感知：截图 + 无障碍树 ---
    var perceptionResult
    try {
      perceptionResult = perception.perceive()
    } catch (e) {
      errorInfo('[agent] 第 ' + steps + ' 步感知异常：' + e)
      failCount++
      sleep(STEP_INTERVAL_MS)
      continue
    }
    logInfo('[agent] 第 ' + steps + ' 步 perceive 完成，准备调 VL decide')

    // --- 2. 决策：VL 看图选动作 ---
    var action
    try {
      action = vlClient.decide(task, perceptionResult, history)
    } catch (e) {
      errorInfo('[agent] 第 ' + steps + ' 步 VL 决策异常：' + e)
      failCount++
      sleep(STEP_INTERVAL_MS)
      continue
    }

    // action 基础校验兜底（vl_client 内部已校验，这里再防一道空值）
    if (!action || !action.action) {
      warnInfo('[agent] 第 ' + steps + ' 步 VL 返回空动作，失败计数')
      failCount++
      sleep(STEP_INTERVAL_MS)
      continue
    }

    debugInfo('[agent] 第 ' + steps + ' 步决策：action=' + action.action +
      ' params=' + JSON.stringify(action.params) + ' reason=' + action.reason)

    // --- 2.5 重复动作检测 + VL 失败计数 ---
    // 重复检测：连续相同 action+params 说明 VL 卡住（如反复点不掉的弹窗），需干预
    var actionKey = action.action + ':' + JSON.stringify(action.params || {})
    // actionChanged：VL 是否换了不同动作。决定 failCount 是否清零——
    // 只有"换动作且执行成功"才算推进（清零），重复同一动作即使点击成功也不推进
    var actionChanged = (actionKey !== lastActionKey)
    if (!actionChanged) {
      repeatCount++
    } else {
      repeatCount = 1
      lastActionKey = actionKey
    }
    // VL 失败检测：vl_client 降级返回 {action:wait, reason:'vl_failed...'}，
    // executor 执行 wait 会成功 → failCount 清零，故用独立的 vlFailCount 累加
    if (action.reason && /^vl_failed/.test(action.reason)) {
      vlFailCount++
      warnInfo('[agent] 第 ' + steps + ' 步 VL 失败降级，vlFailCount=' + vlFailCount + '/' + MAX_VL_FAIL)
    } else {
      vlFailCount = 0
    }
    // 重复达上限：给 VL 注入换策略提示（写进 reason → pushHistory → 下一步 VL 看到），
    // 并标记 repeatCapped 让本步强制累加 failCount，把 agent 推向退出
    var repeatCapped = false
    if (repeatCount >= MAX_REPEAT) {
      warnInfo('[agent] 第 ' + steps + ' 步动作已连续重复 ' + repeatCount + ' 次，注入换策略提示')
      action.reason = (action.reason || '') +
        ' [系统提示：该动作已连续重复' + repeatCount + '次无效，请立即换用其他动作如 swipe/wait/finish]'
      repeatCapped = true
      repeatCount = 0
    }

    // --- 3. 执行：派发到 click/swipe/call_sub/wait/finish ---
    var execResult
    try {
      execResult = executor.execute(action)
    } catch (e) {
      errorInfo('[agent] 第 ' + steps + ' 步执行异常：' + e)
      failCount++
      pushHistory(history, action, { success: false, error: 'execute_exception' }, perceptionResult.tree_summary)
      sleep(STEP_INTERVAL_MS)
      continue
    }

    // --- 4. 记录历史（喂 VL，避免重复决策） ---
    pushHistory(history, action, execResult, perceptionResult.tree_summary)

    // --- 5. 判断循环是否结束 / 更新失败计数 ---
    if (execResult && execResult.finished) {
      finished = true
      logInfo('[agent] 第 ' + steps + ' 步 VL 返回 finish，任务完成')
      break
    }

    // 失败计数策略：
    // - VL 换不同动作（actionChanged）且执行成功 且 未触发重复上限 → 清零 failCount（正常推进）
    // - 重复同一动作（actionChanged=false）即使 click success 也不清零——
    //   反复点同一处属于无效推进（如点不掉的弹窗），让 failCount 累加推向退出
    // - 执行失败 或 重复达上限 → 累加 failCount
    // - VL 降级 wait 本身执行成功，不在此累加，由独立的 vlFailCount 管理
    if (execResult && execResult.success && actionChanged && !repeatCapped) {
      failCount = 0
    } else {
      failCount++
      warnInfo('[agent] 第 ' + steps + ' 步失败计数 fail_count=' + failCount + '/' + MAX_FAIL +
        (repeatCapped ? ' [重复上限]' : (!actionChanged ? ' [重复动作]' : '')) +
        ' error=' + (execResult && execResult.error ? execResult.error : (execResult && execResult.success ? 'none' : 'unknown')))
    }

    // 步间间隔（避免过快，给界面动画留时间）
    sleep(STEP_INTERVAL_MS)
  }

  // --- 循环结束，汇总结果 ---
  var vlExhausted = vlFailCount >= MAX_VL_FAIL
  var success = finished && failCount < MAX_FAIL && !vlExhausted
  var summary = {
    task: task,
    success: success,
    steps: steps,
    fail_count: failCount,
    vl_fail_count: vlFailCount,
    finished: finished
  }

  if (!success && vlExhausted) {
    summary.error = 'vl_failed_exhausted'
    errorInfo('[agent] 任务 [' + task + '] VL 连续失败 ' + vlFailCount + ' 次退出（API/网络异常）')
  } else if (!success && failCount >= MAX_FAIL) {
    summary.error = 'max_fail_exceeded'
    errorInfo('[agent] 任务 [' + task + '] 连续失败 ' + failCount + ' 次退出')
  } else if (success) {
    logInfo('[agent] 任务 [' + task + '] 完成，共 ' + steps + ' 步')
  } else {
    warnInfo('[agent] 任务 [' + task + '] 未完成退出，steps=' + steps + ' fail_count=' + failCount)
  }

  return summary
}

// ============================ 导出 ============================

module.exports = {
  run: run,
  initEnv: initEnv,
  ensureInAntForest: ensureInAntForest,
  _resetInitFlag: _resetInitFlag,
  _internal: {
    pushHistory: pushHistory,
    MAX_FAIL: MAX_FAIL,
    MAX_REPEAT: MAX_REPEAT,
    MAX_VL_FAIL: MAX_VL_FAIL,
    STEP_INTERVAL_MS: STEP_INTERVAL_MS,
    HISTORY_MAX: HISTORY_MAX,
    PERCEPTION_SUMMARY_SLICE: PERCEPTION_SUMMARY_SLICE
  }
}
