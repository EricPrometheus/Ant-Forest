/**
 * @file lib/agent/sub_processes.js
 * @description main.js 子流程接口（Issue #4）
 *
 * 为什么这样设计（复用而非重写）：
 * main.js 的"收自己能量"和"逛一逛"流程已经过长期验证（167g），
 * 涉及大量的初始化（解锁、无障碍、截图权限、dex加载、悬浮窗、SQLite等）
 * 和复杂的界面交互逻辑。重写这些流程容易引入难以发现的回归问题。
 *
 * 因此本模块的职责仅限于：
 *   1. 校验/初始化运行环境（截图权限、悬浮窗等）
 *   2. 调用 core/Ant_forest.js 暴露的 collectOwnEnergy() / stroll() 方法
 *   3. 返回统一结构 {success, energy_gained, error} 给 agent
 *
 * 初始化依赖说明：
 * main.js 中有大量前置初始化，本模块假设调用方（agent 主循环）
 * 已经完成以下初始化（或由 agent 启动时统一处理）：
 *   - require config.js / SingletonRequirer.js
 *   - require modules/init_if_needed.js
 *   - 加载 color-region-center.dex / autojs-common.dex
 *   - 校验无障碍服务 ensureAccessibilityEnabled()
 *   - 解锁屏幕 unlocker.exec()
 *   - 请求截图权限 requestScreenCaptureOrRestart()
 *   - 初始化悬浮窗 FloatyInstance.init()
 *
 * 这些初始化只在 agent 进程启动时执行一次即可，不需要每次 call_sub 都重跑。
 * 但为了稳妥，本模块在执行子流程前会做必要的运行时校验（截图权限、无障碍）。
 */

let { config: _config } = require('../../config.js')(runtime, global)
let singletonRequire = require('../../lib/SingletonRequirer.js')(runtime, global)
let _commonFunctions = singletonRequire('CommonFunction')
let _logUtils = singletonRequire('LogUtils')
let { logInfo, errorInfo, warnInfo, debugInfo } = _logUtils
// _antForestRunner 推迟到 call_sub 内 lazy require，避免模块级触发 importClass(dex类) 早于 agent.initEnv() 加载 dex

/**
 * 子流程注册表
 * 为什么用注册表：方便后续扩展新的子流程（如 collect_friend_energy），
 * 只需在此追加映射，无需修改 call_sub 调度逻辑（开闭原则）。
 */
var SUB_PROCESSES = {
  // 收自己能量：复用 Ant_forest.collectOwnEnergy
  collect_own_energy: function () {
    logInfo('[call_sub] 开始执行：收自己能量')
    return require('../../core/Ant_forest.js').collectOwnEnergy()
  },
  // 逛一逛：复用 Ant_forest.stroll
  stroll: function () {
    logInfo('[call_sub] 开始执行：逛一逛')
    return require('../../core/Ant_forest.js').stroll()
  }
}

/**
 * 校验运行时环境是否就绪
 *
 * 为什么只校验这两项：
 * - 无障碍服务：可能在脚本运行期间被系统杀死，需要运行时校验
 * - 截图权限：同上，部分设备会在后台时回收截图权限
 * 其余初始化（dex、SQLite 等）属于进程级，不会在运行中失效。
 *
 * @returns {boolean} 环境是否就绪
 */
function ensureEnvironmentReady () {
  // 校验无障碍服务
  if (!_commonFunctions.ensureAccessibilityEnabled()) {
    errorInfo('[call_sub] 无障碍服务未启用，无法执行子流程')
    return false
  }
  // 校验截图权限（images.isDelegated 判断代理是否还在）
  if (typeof images !== 'undefined' && images.hasOwnProperty('isDelegated') && !images.isDelegated()) {
    warnInfo('[call_sub] 截图权限代理丢失，可能需要重启脚本')
    // 尝试重新请求截图权限
    if (typeof _commonFunctions.requestScreenCaptureOrRestart === 'function') {
      _commonFunctions.requestScreenCaptureOrRestart()
    } else {
      errorInfo('[call_sub] 无法重新请求截图权限')
      return false
    }
  }
  return true
}

/**
 * 调度 main.js 已验证的子流程
 *
 * agent 通过此函数调用蚂蚁森林的具体操作，不需要关心内部实现细节。
 * 所有子流程都复用 core/Ant_forest.js 中经过长期验证的逻辑。
 *
 * @param {string} name - 子流程名称，支持：
 *   - "collect_own_energy"：收自己能量
 *   - "stroll"：逛一逛收集好友能量
 * @param {object} [args] - 预留参数位，当前子流程不需要额外参数
 * @returns {{success: boolean, energy_gained: number, error: string}}
 *   - success：子流程是否执行成功
 *   - energy_gained：本次收取的能量值（g）
 *   - error：失败时的错误信息，成功时为空字符串
 */
function call_sub (name, args) {
  args = args || {}
  // 统一返回结构，确保 agent 侧可以安全访问字段
  var fallback = { success: false, energy_gained: 0, error: '' }

  // 参数校验
  if (!name || typeof name !== 'string') {
    fallback.error = '子流程名称必须是非空字符串'
    errorInfo('[call_sub] ' + fallback.error)
    return fallback
  }

  // 查找子流程
  var handler = SUB_PROCESSES[name]
  if (typeof handler !== 'function') {
    fallback.error = '未知的子流程：' + name
    errorInfo('[call_sub] ' + fallback.error)
    return fallback
  }

  // 校验运行时环境
  if (!ensureEnvironmentReady()) {
    fallback.error = '运行时环境未就绪（无障碍或截图权限异常）'
    return fallback
  }

  // 执行子流程（Ant_forest 内部已有 try-catch，但再加一层保险）
  try {
    var result = handler(args)
    // 确保返回结构完整
    if (!result || typeof result !== 'object') {
      return { success: false, energy_gained: 0, error: '子流程返回了无效结果' }
    }
    if (typeof result.energy_gained !== 'number') {
      result.energy_gained = 0
    }
    if (typeof result.error !== 'string') {
      result.error = result.error ? (result.error + '') : ''
    }
    logInfo('[call_sub] 子流程 ' + name + ' 执行完成：success=' + result.success +
      ', energy_gained=' + result.energy_gained + 'g')
    return result
  } catch (e) {
    fallback.error = '子流程执行异常：' + e
    errorInfo('[call_sub] ' + fallback.error)
    if (typeof _commonFunctions.printExceptionStack === 'function') {
      _commonFunctions.printExceptionStack(e)
    }
    return fallback
  }
}

module.exports = call_sub
