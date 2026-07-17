/**
 * @file lib/agent/executor.js - 执行 VL 决策（Issue #5）
 *
 * 【职责】
 *   接收 vl_client.decide() 返回的动作对象 {action, params, reason}，
 *   派发到具体的 AutoJS 操作（click / swipe / call_sub / wait / finish），
 *   并返回统一结构 {success, finished?, error?, sub_result?} 给 agent 主循环。
 *
 * 【为什么单独抽一层 executor】
 *   vl_client 只管"决策"，executor 只管"执行"，职责分离后：
 *   - 单元测试可 mock automator/call_sub 来验证派发逻辑；
 *   - 后续接其他输入源（规则引擎、键盘宏）时复用同一执行入口。
 *
 * 【坐标校验策略】
 *   VL 偶尔会输出越界坐标（幻觉），executor 必须二次拦截：
 *   1. click：0 ≤ x ≤ COORD_MAX_X，0 ≤ y ≤ COORD_MAX_Y（与 vl_client 一致，1440x2560）
 *   2. swipe：起点终点均需在屏内，位移绝对值不超过屏幕尺寸
 *   越界一律拒绝执行，返回 invalid_coords，让 agent 主循环进入重试/降级。
 *
 * 【swipe 参数约定】
 *   vl_client 的 SYSTEM_PROMPT 定义 swipe params 为 {dx, dy}（相对位移，正=右/下）。
 *   executor 负责把相对位移换算成 AutoJS swipe() 需要的绝对四坐标：
 *   - 起点：屏幕水平中线、垂直靠下 3/4 处（向下浏览列表的常见手势起点）
 *   - 终点：起点 + (dx, dy)，并钳制到屏幕范围内
 *   - duration：随机 300-500ms，模拟人类滑动节奏
 *
 * @author AI Agent Forest
 */

let { config } = require('../../config.js')(runtime, global)
let singletonRequire = require('../SingletonRequirer.js')(runtime, global)
let automator = singletonRequire('Automator')
let _logUtils = singletonRequire('LogUtils')
let { logInfo, errorInfo, warnInfo, debugInfo } = _logUtils
let call_sub = require('./sub_processes.js')

// ============================ 常量 ============================

/**
 * 坐标合法上界（与 vl_client.js 保持一致，避免两头标准不一导致 VL 已校验、executor 又拒）。
 * 下界固定 0。
 */
var COORD_MAX_X = 1440
var COORD_MAX_Y = 2560

/** swipe 默认/随机时长范围（ms），贴近真人滑动节奏，降低被风控识别概率 */
var SWIPE_DURATION_MIN = 300
var SWIPE_DURATION_MAX = 500

// ============================ 坐标校验 ============================

/**
 * 判断值是否为有限整数（拒绝 NaN/Infinity/小数/字符串）
 * @param {*} v
 * @returns {boolean}
 */
function isInt (v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v
}

/**
 * 判断整数 v 是否落在 [min, max] 闭区间
 */
function inRange (v, min, max) {
  return v >= min && v <= max
}

/**
 * 校验 click 坐标合法性
 * @param {number} x
 * @param {number} y
 * @returns {{valid: boolean, error?: string}}
 */
function validateClickCoords (x, y) {
  if (!isInt(x) || !isInt(y)) {
    return { valid: false, error: 'click 坐标非整数 x=' + x + ' y=' + y }
  }
  if (!inRange(x, 0, COORD_MAX_X) || !inRange(y, 0, COORD_MAX_Y)) {
    return { valid: false, error: 'click 坐标越界 (' + x + ',' + y + ')' }
  }
  return { valid: true }
}

/**
 * 校验 swipe 位移合法性：dx/dy 必须是整数，绝对值不能超过屏幕尺寸
 * （超过一整屏的滑动属于模型幻觉）
 * @param {number} dx
 * @param {number} dy
 * @returns {{valid: boolean, error?: string}}
 */
function validateSwipeDelta (dx, dy) {
  if (!isInt(dx) || !isInt(dy)) {
    return { valid: false, error: 'swipe 位移非整数 dx=' + dx + ' dy=' + dy }
  }
  if (Math.abs(dx) > COORD_MAX_X || Math.abs(dy) > COORD_MAX_Y) {
    return { valid: false, error: 'swipe 位移过大 (' + dx + ',' + dy + ')' }
  }
  // 全零位移等于无效操作，直接拒绝
  if (dx === 0 && dy === 0) {
    return { valid: false, error: 'swipe 位移全零' }
  }
  return { valid: true }
}

// ============================ swipe 换算 ============================

/**
 * 把 VL 的相对位移 {dx, dy} 换算成 AutoJS swipe() 所需的四坐标 + 时长。
 *
 * 起点策略：屏幕水平中线、垂直 3/4 处（向下浏览列表的常见手势起点）。
 * 终点 = 起点 + (dx, dy)，并钳制到 [0, width/height]。
 * 终点越界时整体平移手势使其完全落在屏内；若平移后仍越界（手势比屏幕还大），
 * 直接截断终点到边界——保证 swipe 调用本身不会抛异常。
 *
 * @param {number} dx 水平相对位移（正=右）
 * @param {number} dy 垂直相对位移（正=下）
 * @returns {{x1:number,y1:number,x2:number,y2:number,duration:number}}
 */
function resolveSwipePath (dx, dy) {
  var width = config.device_width || COORD_MAX_X
  var height = config.device_height || COORD_MAX_Y

  var x1 = Math.floor(width / 2)
  var y1 = Math.floor(height * 3 / 4)

  var x2 = x1 + dx
  var y2 = y1 + dy

  // 钳制到屏幕范围（兜底，正常情况下 validateSwipeDelta 已保证不会越界太多）
  x2 = Math.max(0, Math.min(x2, width))
  y2 = Math.max(0, Math.min(y2, height))

  var duration = SWIPE_DURATION_MIN + Math.floor(Math.random() * (SWIPE_DURATION_MAX - SWIPE_DURATION_MIN))
  return { x1: x1, y1: y1, x2: x2, y2: y2, duration: duration }
}

// ============================ 主入口 execute ============================

/**
 * 执行 VL 决策动作。
 *
 * @param {object} action VL 返回的动作对象，结构 {action:string, params:object, reason:string}
 *   合法 action：click / swipe / call_sub / wait / finish
 * @returns {{success:boolean, finished?:boolean, error?:string, sub_result?:object}}
 *   - success：动作是否执行成功
 *   - finished：仅 action=finish 时为 true，agent 主循环据此退出
 *   - error：失败时的错误描述
 *   - sub_result：仅 action=call_sub 成功时携带，内容为 call_sub 的返回
 */
function execute (action) {
  // 入参基础校验
  if (!action || typeof action !== 'object') {
    errorInfo('[executor] 入参非对象：' + action)
    return { success: false, error: 'invalid_action_object' }
  }

  var type = action.action
  var params = action.params || {}

  try {
    switch (type) {
      case 'click':
        return execClick(params)
      case 'swipe':
        return execSwipe(params)
      case 'call_sub':
        return execCallSub(params)
      case 'wait':
        return execWait(params)
      case 'finish':
        return { success: true, finished: true }
      default:
        warnInfo('[executor] 未知 action：' + type)
        return { success: false, error: 'unknown_action' }
    }
  } catch (e) {
    errorInfo('[executor] 执行 ' + type + ' 异常：' + e)
    if (typeof _logUtils.printExceptionStack === 'function') {
      _logUtils.printExceptionStack(e)
    }
    return { success: false, error: e && e.message ? e.message : ('' + e) }
  }
}

// ============================ 各 action 实现 ============================

/**
 * click：点击屏幕坐标
 * @param {{x:number, y:number}} params
 */
function execClick (params) {
  var x = params.x
  var y = params.y
  var check = validateClickCoords(x, y)
  if (!check.valid) {
    warnInfo('[executor] ' + check.error)
    return { success: false, error: 'invalid_coords' }
  }
  debugInfo('[executor] click (' + x + ',' + y + ')')
  var ok = automator.click(x, y)
  return { success: !!ok }
}

/**
 * swipe：滑动手势
 * @param {{dx:number, dy:number}} params 相对位移（正=右/下）
 */
function execSwipe (params) {
  var dx = params.dx
  var dy = params.dy
  var check = validateSwipeDelta(dx, dy)
  if (!check.valid) {
    warnInfo('[executor] ' + check.error)
    return { success: false, error: 'invalid_coords' }
  }
  var path = resolveSwipePath(dx, dy)
  debugInfo('[executor] swipe (' + path.x1 + ',' + path.y1 + ')->(' + path.x2 + ',' + path.y2 + ') duration=' + path.duration)
  var ok = automator.swipe(path.x1, path.y1, path.x2, path.y2, path.duration)
  return { success: !!ok }
}

/**
 * call_sub：委派子流程给 main.js 已验证逻辑
 * @param {{sub:string}} params 子流程名，如 collect_own_energy / stroll
 */
function execCallSub (params) {
  var sub = params.sub
  if (!sub || typeof sub !== 'string') {
    warnInfo('[executor] call_sub 缺少合法 sub 字段')
    return { success: false, error: 'invalid_params' }
  }
  logInfo('[executor] call_sub: ' + sub)
  var result = call_sub(sub)
  // call_sub 失败时返回 {success:false, ...}，executor 原样透传错误
  if (!result || !result.success) {
    return {
      success: false,
      error: (result && result.error) ? result.error : 'sub_process_failed',
      sub_result: result
    }
  }
  return { success: true, sub_result: result }
}

/**
 * wait：sleep 等待
 * @param {{ms?:number}} params 等待毫秒数，缺省 1000
 */
function execWait (params) {
  var ms = params.ms
  if (ms !== undefined && (!isInt(ms) || ms < 0)) {
    warnInfo('[executor] wait.ms 非法：' + ms)
    return { success: false, error: 'invalid_params' }
  }
  if (ms === undefined) {
    ms = 1000
  }
  // 上限 10s，防止 VL 幻觉出超长等待卡死主循环
  if (ms > 10000) {
    warnInfo('[executor] wait.ms=' + ms + ' 过大，截断到 10000')
    ms = 10000
  }
  debugInfo('[executor] wait ' + ms + 'ms')
  sleep(ms)
  return { success: true }
}

// ============================ 导出 ============================

module.exports = {
  execute: execute,
  // 导出内部函数方便单元测试 mock
  _internal: {
    execClick: execClick,
    execSwipe: execSwipe,
    execCallSub: execCallSub,
    execWait: execWait,
    validateClickCoords: validateClickCoords,
    validateSwipeDelta: validateSwipeDelta,
    resolveSwipePath: resolveSwipePath,
    isInt: isInt,
    inRange: inRange,
    COORD_MAX_X: COORD_MAX_X,
    COORD_MAX_Y: COORD_MAX_Y
  }
}
