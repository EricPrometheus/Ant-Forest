/**
 * @file lib/agent/run.js - agent 入口脚本（Issue #6）
 *
 * 【职责】
 *   给 AutoJS 定时任务 / RunIntentActivity 调用的顶层入口：
 *   读取启动参数中的 task，调用 agent.run(task) 执行主循环。
 *
 * 【为什么单独一个 run.js】
 *   agent.js 只导出 run 函数（纯逻辑，方便测试），
 *   run.js 负责 AutoJS 进程级的"壳"：参数解析、任务队列注册、退出清理。
 *   定时任务在 AutoJS 里指向此文件即可。
 *
 * 【启动参数读取方式】
 *   与其他 unit 脚本（森林集市.js / 神奇海洋收集.js）一致：
 *   config.parseExecArgv() 返回 engines.myEngine().execArgv 的浅拷贝（已去掉 intent）。
 *   定时任务/外部调用可通过 executeArguments 传 task 字符串，例如：
 *     engines.execScriptFile(path, { executeArguments: { task: '收自己能量' } })
 *   无参数时默认 "收自己能量"。
 *
 * @author AI Agent Forest
 */

let { config } = require('../../config.js')(runtime, global)
let singletonRequire = require('../SingletonRequirer.js')(runtime, global)
let commonFunctions = singletonRequire('CommonFunction')
let _logUtils = singletonRequire('LogUtils')
let { logInfo, errorInfo, warnInfo, debugInfo, flushAllLogs } = _logUtils
let runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')

var agent = require('./agent.js')

// ============================ 默认任务 ============================

/** 无参数时执行的任务 */
var DEFAULT_TASK = '收自己能量'

// ============================ 参数读取 ============================

/**
 * 读取启动参数中的 task。
 *
 * 优先级：
 *   1. executeArguments.task（engines.execScriptFile 传入）
 *   2. intent.getStringExtra('task')（定时任务 Intent 方式）
 *   3. 默认 DEFAULT_TASK
 *
 * @returns {string}
 */
function readTask () {
  var task = null
  try {
    // config.parseExecArgv 已去掉 intent 并做了 JSON 序列化（转基本类型）
    var args = config.parseExecArgv()
    if (args && args.task) {
      task = args.task
    }
  } catch (e) {
    warnInfo('[run] parseExecArgv 异常：' + e)
  }

  // intent 方式（定时任务通过 AlarmManager 触发）
  if (!task) {
    try {
      var intent = engines.myEngine().execArgv.intent
      if (intent && typeof intent.getStringExtra === 'function') {
        var intentTask = intent.getStringExtra('task')
        if (intentTask) {
          task = intentTask
        }
      }
    } catch (e) {
      // 无 intent 是正常情况（直接 Run 运行）
    }
  }

  return task || DEFAULT_TASK
}

// ============================ 主流程 ============================

logInfo('[agent-run] ====== agent 入口启动 ======')

// 避免定时任务打断前台运行中的任务
commonFunctions.checkAnyReadyAndSleep && commonFunctions.checkAnyReadyAndSleep()

// 加入任务队列，防止重复运行
logInfo('[agent-run] 加入任务队列')
runningQueueDispatcher.addRunningTask()
commonFunctions.killDuplicateScript && commonFunctions.killDuplicateScript()

// 注册退出清理（移除任务队列、刷日志）
events.on('exit', function () {
  config.isRunning = false
})
commonFunctions.registerOnEngineRemoved(function () {
  config.resetBrightness && config.resetBrightness()
  flushAllLogs && flushAllLogs()
  runningQueueDispatcher.removeRunningTask(true, true, function () {
    config.isRunning = false
  })
}, 'agent-run')

var task = readTask()
logInfo('[agent-run] 任务参数：task=' + task)

config.isRunning = true

// 开启一键收：逛一逛好友界面有一键收按钮（用户确认），oneKeyCollectByImg 有 OCR
// fallback（自动定位"一键收"文字，不需手动框配图）。doCollectTargetFriend 的
// collectEnergy 会触发 collectByOneKeyCollect，OCR 在好友界面找按钮。
try {
  config.overwrite('use_one_key_collect', true)
  logInfo('[agent-run] 已开启 use_one_key_collect（OCR 自动定位一键收）')
} catch (e) {
  warnInfo('[agent-run] 开启 use_one_key_collect 失败：' + e)
}

// 执行 agent 主循环
var result
try {
  result = agent.run(task)
} catch (e) {
  errorInfo('[agent-run] agent.run 异常：' + e)
  if (typeof _logUtils.printExceptionStack === 'function') {
    _logUtils.printExceptionStack(e)
  }
  result = { task: task, success: false, steps: 0, fail_count: 0, finished: false, error: 'run_exception' }
}

logInfo('[agent-run] 任务结果：' + JSON.stringify(result))

// 清理
flushAllLogs && flushAllLogs()
runningQueueDispatcher.removeRunningTask(true)

// 延迟退出，给 AutoJS 引擎时间收尾
setTimeout(function () { exit() }, 1000 * 5)
