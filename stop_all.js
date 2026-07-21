/**
 * @file stop_all.js - 停止所有运行中的脚本引擎并清空任务队列
 *
 * 【为什么需要】
 *   之前一次 agent 运行（run.js）可能卡在 VL 长等待里未退出，
 *   RunningQueueDispatcher 的任务记录残留，导致新启动的 run.js
 *   被「脚本正在运行中」去重逻辑挡掉。本脚本强制停掉所有其他引擎
 *   并移除队列记录，给后续启动扫清障碍。
 */

'use strict'

var me = engines.myEngine()
var stopped = 0
engines.all().forEach(function (e) {
  try {
    if (e.id !== me.id) {
      e.forceStop()
      stopped++
    }
  } catch (err) {
    // 忽略单个引擎停止失败
  }
})

// 清空任务队列（runningQueueDispatcher 的 ready_engine 记录）
try {
  var singletonRequire = require('/sdcard/脚本/ant-forest/lib/SingletonRequirer.js')(runtime, global)
  var runningQueueDispatcher = singletonRequire('RunningQueueDispatcher')
  runningQueueDispatcher.removeRunningTask(true)
} catch (err) {
  // 队列清理失败不阻塞
}

toast('stop_all: 已停止 ' + stopped + ' 个引擎')
exit()
