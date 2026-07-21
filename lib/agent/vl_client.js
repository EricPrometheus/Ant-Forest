/**
 * @file vl_client.js - 国产视觉语言模型（VL）调用客户端
 *
 * 【职责】
 *   接收蚂蚁森林当前截图 + 无障碍树摘要 + 任务描述 + 历史动作，
 *   调用国产 VL（通义千问 VL / 智谱 GLM-4V），让模型"看图决策"，
 *   返回结构化动作 {action, params, reason} 供执行器执行。
 *
 * 【为什么用国产 VL 而不是 GPT-4V】
 *   AutoJS 跑在国产模拟器/真机上，走国内网络直连阿里/智谱更稳定，
 *   且通义千问 VL、GLM-4V 对中文界面理解不输海外模型，成本更低。
 *
 * 【为什么自己解析 JSON 而不依赖 VL 的 function-calling】
 *   两家 VL 的 function-calling 实现不一致、文档稀少，
 *   统一用"prompt 约束 + 正则提取 JSON"最可控、最易调试。
 *
 * @author AI Agent Forest
 */

let { config } = require('../../config.js')(runtime, global)

// OkHttp 类导入（与 AIRequestUtil.js 保持一致的风格，失败静默，
// 实际调用处会因变量未定义抛出并被 catch 捕获）
try {
  importClass('okhttp3.OkHttpClient')
  importClass('okhttp3.MediaType')
  importClass('okhttp3.RequestBody')
  importClass('okhttp3.Request')
} catch (e) {
  console.warn('vl_client: OkHttp 类导入失败，请检查 AutoJS 环境：' + e)
}

// ============================ 常量 ============================

/** 合法动作枚举（执行器只认这 5 种） */
var VALID_ACTIONS = ['click', 'swipe', 'call_sub', 'finish', 'wait']

/**
 * 坐标合法范围（1080P 蚂蚁森林典型分辨率，兼容 1440x2560）。
 * 校验时取宽松上界，避免不同设备误杀；
 * 越界时尝试重试，而非直接信任模型输出。
 */
var COORD_MAX_X = 1440
var COORD_MAX_Y = 2560

/** 最大重试次数（网络超时 / 非法 JSON / 坐标越界 都会消耗重试） */
var MAX_RETRY = 3

/** 单次请求超时（秒）—— 视觉 VL 首 token 常 30-60s（尤其 Coding Plan/anthropic/免费模型排队），
 *  30s 太短会静默超时（VL 零响应）。增到 90s 给足推理时间。
 *  Hermes 在 PC 可能超时更长/流式，所以同 key 同模型正常。 */
var CALL_TIMEOUT_SECONDS = 90

// ============================ Prompt 设计 ============================

/**
 * 系统 prompt：约束 VL 只返回 JSON + 灌输蚂蚁森林领域知识。
 *
 * 【设计要点】
 * 1. 强约束输出格式：第一层用 ```json 围栏，内层是纯 JSON。
 *    这样即使模型加了自然语言前缀，正则也能稳定提取。
 * 2. 动作语义明确：click 点能量球/swipe 滑好友列表/call_sub 委派子流程/
 *    finish 任务完成/wait 等待加载。每个动作的 params 字段固定，
 *    执行器不需要猜。
 * 3. 领域知识：告诉模型"什么是能量球（黄绿色圆）、什么是找能量按钮、
 *    H5 页面特征"，减少模型在陌生 UI 上的犹豫。
 * 4. 坐标系：明确告知分辨率范围，减少越界概率。
 */
var SYSTEM_PROMPT = [
  '你是蚂蚁森林自动化决策大脑。你会收到一张手机截图和无障碍树摘要，',
  '必须决策下一步操作。',
  '',
  '【输出格式】严格只返回一个 JSON 对象，不要任何解释文字：',
  '```json',
  '{"action": "<动作>", "params": <参数>, "reason": "<一句话理由>"}',
  '```',
  '',
  '【合法动作与参数】',
  '- click   点击屏幕坐标。params: {"x": int, "y": int}',
  '- swipe   滑动手势。params: {"dx": int, "dy": int}（相对位移，正=右/下）',
  '- call_sub 委派子流程（如能量雨、神奇物种）。params: {"sub": "<子流程名>"}',
  '- finish  任务已完成，退出。params: {}',
  '- wait    页面加载中/无操作可做，等待。params: {"ms": int}',
  '',
  '【蚂蚁森林领域知识】',
  '- 能量球：树周围黄绿色/绿色发光圆球，可收取。浇水球为金/黄色。',
  '- 主界面：中央一棵树，底部有"浇水""背包""任务"按钮。',
  '- 好友排行榜：列表页，每行一个好友，右侧有可收取的小手指图标或能量球。',
  '- "找能量"按钮：列表底部的绿色入口按钮，点击进入下一个好友。',
  '- "查看更多好友"：排行榜底部入口。',
  '- H5 活动：顶部有活动标题，底部有关闭/返回按钮。',
  '- 倒计时能量球：灰色/带数字，当前不可收，应 wait 或跳过。',
  '',
  '【坐标系】屏幕分辨率约 1080x2400（最大 1440x2560），坐标必须在此范围内。',
  '坐标原点(0,0)在左上角。',
  '',
  '【决策原则】',
  '1. 有可收能量球优先 click 收取。',
  '2. 当前页无可收时，swipe 向下滑动找更多，或 click "找能量"按钮。',
  '3. 弹窗/H5 优先关闭返回主流程。',
  '4. 不确定时 wait，不要乱点。'
].join('\n')

// ============================ VL 执行器基类 ============================

/**
 * VL 请求执行器基类，子类需实现 buildRequestData 和 inspectContent。
 * 沿用 AIRequestUtil.js 的 OkHttp 同步调用模式。
 */
function VlExecutor () {
  this.name = 'VlExecutor'
}

/**
 * 同步执行 VL 请求。
 * @param {string} systemPrompt 系统约束
 * @param {string} userPrompt   用户侧文本（含截图 data URI 由子类组装）
 * @param {string} imageBase64  截图 base64（不含 data: 前缀）
 * @returns {string|null} 模型返回的文本内容，失败返回 null
 */
VlExecutor.prototype.execute = function (systemPrompt, userPrompt, imageBase64) {
  var client = new OkHttpClient().newBuilder()
    .callTimeout(CALL_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
    .build()
  var request = this.buildRequestData(systemPrompt, userPrompt, imageBase64)
  if (!request) {
    console.error(this.name + ': 构建请求失败')
    return null
  }
  try {
    var response = client.newCall(request).execute()
    if (!response.isSuccessful()) {
      console.error(this.name + ' 请求失败 status=' + response.code() + ' body=' + response.body().string())
      return null
    }
    var responseBody = response.body().string()
    console.verbose(this.name + ' 原始响应: ' + responseBody.substring(0, Math.min(responseBody.length, 500)))
    return this.inspectContent(responseBody)
  } catch (e) {
    console.error(this.name + ' 请求异常: ' + e)
    return null
  }
}

/**
 * 从 HTTP 响应体解析出模型文本内容。子类按各家 API 结构覆盖。
 * 默认按 OpenAI 兼容结构（choices[0].message.content）解析。
 * @returns {string|null}
 */
VlExecutor.prototype.inspectContent = function (responseBody) {
  try {
    var json = JSON.parse(responseBody)
    if (json && json.choices && json.choices.length > 0) {
      var content = json.choices[0].message.content
      // 部分多模态 API content 是数组 [{type:"text",text:"..."}]
      if (Array.isArray(content)) {
        var parts = []
        for (var i = 0; i < content.length; i++) {
          if (content[i].text) parts.push(content[i].text)
        }
        return parts.join('')
      }
      return content
    }
    // 通义千问 VL 的 output 结构兼容
    if (json && json.output && json.output.choices && json.output.choices.length > 0) {
      return json.output.choices[0].message.content
    }
    console.error(this.name + ' 响应结构无法识别: ' + responseBody.substring(0, 200))
    return null
  } catch (e) {
    console.error(this.name + ' 响应 JSON 解析失败: ' + e)
    return null
  }
}

/** 子类覆盖：构建各家 API 的 Request 对象 */
VlExecutor.prototype.buildRequestData = function (systemPrompt, userPrompt, imageBase64) {
  return null
}

// ============================ 通义千问 VL ============================

/**
 * 通义千问 VL 执行器。
 * endpoint: https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 * 消息格式：content 数组，image 传 data URI 或 URL，text 传 prompt。
 */
function QwenVlExecutor (apiKey, model, endpoint) {
  this.name = 'QwenVL'
  this.apiKey = apiKey
  this.model = model || 'qwen-vl-plus'
  this.endpoint = endpoint || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
}
QwenVlExecutor.prototype = Object.create(VlExecutor.prototype)
QwenVlExecutor.prototype.constructor = QwenVlExecutor

QwenVlExecutor.prototype.buildRequestData = function (systemPrompt, userPrompt, imageBase64) {
  var dataUri = 'data:image/jpeg;base64,' + imageBase64
  var requestData = {
    model: this.model,
    input: {
      messages: [
        { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
        {
          role: 'user',
          content: [
            { type: 'image', image: dataUri },
            { type: 'text', text: userPrompt }
          ]
        }
      ]
    }
  }
  var mediaType = MediaType.parse('application/json')
  var body = RequestBody.create(mediaType, JSON.stringify(requestData))
  return new Request.Builder()
    .url(this.endpoint)
    .method('POST', body)
    .addHeader('Authorization', 'Bearer ' + this.apiKey)
    .addHeader('Content-Type', 'application/json')
    .build()
}

// ============================ 智谱 GLM-4V ============================

/**
 * 智谱 GLM-4V 执行器。
 * endpoint: https://open.bigmodel.cn/api/paas/v4/chat/completions
 * OpenAI 兼容格式，content 数组传 image_url(data URI) + text。
 */
function GlmVlExecutor (apiKey, model, endpoint) {
  this.name = 'GLM-4V'
  this.apiKey = apiKey
  this.model = model || 'glm-4v'
  this.endpoint = endpoint || 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
}
GlmVlExecutor.prototype = Object.create(VlExecutor.prototype)
GlmVlExecutor.prototype.constructor = GlmVlExecutor

GlmVlExecutor.prototype.buildRequestData = function (systemPrompt, userPrompt, imageBase64) {
  var dataUri = 'data:image/jpeg;base64,' + imageBase64
  var requestData = {
    model: this.model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUri } },
          { type: 'text', text: userPrompt }
        ]
      }
    ],
    temperature: 0.1
  }
  var mediaType = MediaType.parse('application/json')
  var body = RequestBody.create(mediaType, JSON.stringify(requestData))
  return new Request.Builder()
    .url(this.endpoint)
    .method('POST', body)
    .addHeader('Authorization', 'Bearer ' + this.apiKey)
    .addHeader('Content-Type', 'application/json')
    .build()
}

/**
 * 智谱 GLM anthropic 协议执行器（Coding Plan 的 anthropic endpoint）。
 * endpoint: https://open.bigmodel.cn/api/anthropic/v1/messages
 * Coding Plan 的 OpenAI 兼容 endpoint 对该 key 余额不足/卡死，
 * 改用 anthropic 协议入口（Coding Plan 官方推荐协议之一）。
 * schema: system 顶层、max_tokens 必需、image source base64、x-api-key header。
 */
function GlmAnthropicExecutor (apiKey, model, endpoint) {
  this.name = 'GLM-Anthropic'
  this.apiKey = apiKey
  this.model = model || 'glm-4.6'
  this.endpoint = endpoint || 'https://open.bigmodel.cn/api/anthropic/v1/messages'
}
GlmAnthropicExecutor.prototype = Object.create(VlExecutor.prototype)
GlmAnthropicExecutor.prototype.constructor = GlmAnthropicExecutor

GlmAnthropicExecutor.prototype.buildRequestData = function (systemPrompt, userPrompt, imageBase64) {
  var requestData = {
    model: this.model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: userPrompt }
        ]
      }
    ]
  }
  var mediaType = MediaType.parse('application/json')
  var body = RequestBody.create(mediaType, JSON.stringify(requestData))
  return new Request.Builder()
    .url(this.endpoint)
    .method('POST', body)
    .addHeader('x-api-key', this.apiKey)
    .addHeader('anthropic-version', '2023-06-01')
    .addHeader('Content-Type', 'application/json')
    .build()
}

GlmAnthropicExecutor.prototype.parseResponse = function (json) {
  if (json && json.content && Array.isArray(json.content)) {
    var parts = []
    for (var i = 0; i < json.content.length; i++) {
      if (json.content[i].type === 'text' && json.content[i].text) {
        parts.push(json.content[i].text)
      }
    }
    return parts.join('')
  }
  return null
}

// ============================ 工厂 ============================

/**
 * 根据 config.vl_provider 创建对应执行器。
 * @returns {VlExecutor|null} key 未配置时返回 null
 */
function createExecutor () {
  var provider = config.vl_provider || 'qwen'
  var apiKey = config.vl_api_key
  if (!apiKey) {
    console.error('vl_client: vl_api_key 未配置，请在配置中填写')
    return null
  }
  var model = config.vl_model
  var endpoint = config.vl_endpoint
  if (provider === 'glm') {
    return new GlmVlExecutor(apiKey, model, endpoint)
  }
  if (provider === 'glm-anthropic') {
    return new GlmAnthropicExecutor(apiKey, model, endpoint)
  }
  // 默认通义
  return new QwenVlExecutor(apiKey, model, endpoint)
}

// ============================ 截图读取 ============================

/**
 * 读取截图文件并转 base64。
 * 【Why 用 images.read】AutoJS 原生 API，无需额外依赖，
 *    且能统一处理 png/jpg。toBase64 第二个参数为质量（0-100），
 *    用 60 压缩传输体积，VL 决策不需要原图精度。
 * @param {string} screenshotPath 截图绝对路径
 * @returns {string|null} base64 字符串（不含 data: 前缀）
 */
function readScreenshotAsBase64 (screenshotPath) {
  if (!screenshotPath) {
    console.error('vl_client: screenshot_path 为空')
    return null
  }
  try {
    var img = images.read(screenshotPath)
    if (!img) {
      console.error('vl_client: 无法读取截图: ' + screenshotPath)
      return null
    }
    var base64 = images.toBase64(img, 'jpeg', 60)
    img.recycle()
    return base64
  } catch (e) {
    console.error('vl_client: 截图转 base64 失败: ' + e)
    return null
  }
}

// ============================ JSON 提取与校验 ============================

/**
 * 从 VL 返回文本中提取决策 JSON。
 * 【Why】VL 经常在 JSON 前后加自然语言，或用 ```json 围栏包裹，
 *   这里用多重兜底策略确保尽可能提取到合法 JSON。
 * @param {string} text 模型返回的原始文本
 * @returns {object|null} 解析后的决策对象
 */
function extractDecisionJson (text) {
  if (!text) return null

  // 策略1：优先提取 ```json ... ``` 围栏内容
  var fenceRegex = /```(?:json)?\s*([\s\S]*?)```/i
  var fenceMatch = fenceRegex.exec(text)
  if (fenceMatch && fenceMatch[1]) {
    var fenced = tryParseJson(fenceMatch[1].trim())
    if (fenced) return fenced
  }

  // 策略2：提取第一个 {...} 块（贪心匹配最外层花括号）
  var braceRegex = /\{[\s\S]*\}/
  var braceMatch = braceRegex.exec(text)
  if (braceMatch) {
    var braced = tryParseJson(braceMatch[0])
    if (braced) return braced
  }

  // 策略3：直接尝试整段解析
  var direct = tryParseJson(text.trim())
  if (direct) return direct

  console.error('vl_client: 无法从模型输出提取 JSON: ' + text.substring(0, 200))
  return null
}

function tryParseJson (str) {
  try {
    return JSON.parse(str)
  } catch (e) {
    return null
  }
}

/**
 * 校验决策对象的 action 与 params 是否合法。
 * @param {object} decision 待校验决策
 * @returns {{valid: boolean, reason: string}} 校验结果
 */
function validateDecision (decision) {
  if (!decision || typeof decision !== 'object') {
    return { valid: false, reason: '决策非对象' }
  }
  var action = decision.action
  if (VALID_ACTIONS.indexOf(action) === -1) {
    return { valid: false, reason: '非法 action: ' + action }
  }
  var params = decision.params || {}

  // 按动作校验 params
  if (action === 'click') {
    var x = params.x, y = params.y
    if (!isInt(x) || !isInt(y)) {
      return { valid: false, reason: 'click 缺少合法 x/y 坐标' }
    }
    if (!inRange(x, 0, COORD_MAX_X) || !inRange(y, 0, COORD_MAX_Y)) {
      return { valid: false, reason: 'click 坐标越界 (' + x + ',' + y + ')' }
    }
  } else if (action === 'swipe') {
    var dx = params.dx, dy = params.dy
    if (!isInt(dx) || !isInt(dy)) {
      return { valid: false, reason: 'swipe 缺少合法 dx/dy 位移' }
    }
    // 位移范围放宽，允许较大滑动
    if (Math.abs(dx) > COORD_MAX_X || Math.abs(dy) > COORD_MAX_Y) {
      return { valid: false, reason: 'swipe 位移过大 (' + dx + ',' + dy + ')' }
    }
  } else if (action === 'call_sub') {
    if (!params.sub || typeof params.sub !== 'string') {
      return { valid: false, reason: 'call_sub 缺少 sub 字段' }
    }
  } else if (action === 'wait') {
    // ms 可选，给默认值
    if (params.ms !== undefined && !isInt(params.ms)) {
      return { valid: false, reason: 'wait.ms 非整数' }
    }
  }
  // finish 无需 params 校验

  return { valid: true, reason: '' }
}

function isInt (v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v
}

function inRange (v, min, max) {
  return v >= min && v <= max
}

// ============================ 用户 prompt 构造 ============================

/**
 * 构造 user 侧文本 prompt：树摘要 + 任务 + 历史。
 * 截图由执行器单独组装到 content 里，这里只管文字部分。
 * @param {string} task  当前任务描述
 * @param {object} perception {tree_summary, screenshot_path}
 * @param {Array}  history    最近动作数组 [{action, params, reason}, ...]
 * @returns {string}
 */
function buildUserPrompt (task, perception, history) {
  var lines = []
  lines.push('【当前任务】' + task)
  if (perception && perception.tree_summary) {
    lines.push('【无障碍树摘要】')
    lines.push(perception.tree_summary)
  }
  if (history && history.length > 0) {
    lines.push('【最近动作历史】')
    // 只传最近 5 步，避免 prompt 过长
    var recent = history.slice(-5)
    for (var i = 0; i < recent.length; i++) {
      var h = recent[i]
      lines.push((i + 1) + '. ' + JSON.stringify(h))
    }
  }
  lines.push('')
  lines.push('请根据截图和以上信息，决策下一步操作，只返回 JSON。')
  return lines.join('\n')
}

// ============================ 主入口 decide ============================

/**
 * VL 决策主入口。
 *
 * @param {string} task       当前任务描述（如"收集好友能量"）
 * @param {object} perception 感知信息 {tree_summary, screenshot_path}
 * @param {Array}  history    历史动作数组，每项 {action, params, reason}
 * @returns {object} 决策结果 {action, params, reason}
 *   失败时返回 {action:"wait", params:{ms:2000}, reason:"vl_failed"}
 *   调用方可据此决定是否降级到规则引擎。
 */
function decide (task, perception, history) {
  var executor = createExecutor()
  if (!executor) {
    return fallback('vl_api_key 未配置')
  }

  var imageBase64 = readScreenshotAsBase64(perception && perception.screenshot_path)
  if (!imageBase64) {
    return fallback('截图读取失败')
  }

  var userPrompt = buildUserPrompt(task, perception, history)

  // 重试循环：网络/解析/校验失败都重试
  var lastError = ''
  for (var attempt = 1; attempt <= MAX_RETRY; attempt++) {
    console.verbose('vl_client: 第 ' + attempt + '/' + MAX_RETRY + ' 次请求')
    var content = executor.execute(SYSTEM_PROMPT, userPrompt, imageBase64)
    if (!content) {
      lastError = 'HTTP 请求失败'
      sleepBeforeRetry(attempt)
      continue
    }

    var decision = extractDecisionJson(content)
    if (!decision) {
      lastError = 'JSON 提取失败'
      sleepBeforeRetry(attempt)
      continue
    }

    var check = validateDecision(decision)
    if (!check.valid) {
      lastError = check.reason
      console.warn('vl_client: 决策校验失败（重试 ' + attempt + '）：' + check.reason)
      sleepBeforeRetry(attempt)
      continue
    }

    // 成功
    if (!decision.reason) {
      decision.reason = 'vl 决策'
    }
    console.info('vl_client: 决策成功 action=' + decision.action + ' reason=' + decision.reason)
    return decision
  }

  console.error('vl_client: ' + MAX_RETRY + ' 次重试均失败，最后错误：' + lastError)
  return fallback(lastError)
}

/** 重试前退避，递增等待避免频繁打 API */
function sleepBeforeRetry (attempt) {
  if (attempt < MAX_RETRY) {
    var delay = 1000 * attempt // 1s, 2s
    console.verbose('vl_client: ' + delay + 'ms 后重试')
    sleep(delay)
  }
}

/** 生成降级决策 */
function fallback (reason) {
  return {
    action: 'wait',
    params: { ms: 2000 },
    reason: 'vl_failed: ' + (reason || '未知错误')
  }
}

// ============================ 导出 ============================

module.exports = {
  decide: decide,
  // 导出内部函数方便单元测试 mock
  _internal: {
    createExecutor: createExecutor,
    extractDecisionJson: extractDecisionJson,
    validateDecision: validateDecision,
    buildUserPrompt: buildUserPrompt,
    readScreenshotAsBase64: readScreenshotAsBase64,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    VALID_ACTIONS: VALID_ACTIONS
  }
}
