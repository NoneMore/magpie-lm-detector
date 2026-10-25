# Magpie LM Detector (external plugin)

无需修改 Magpie 上游代码的独立模型指纹检测插件。通过 Magpie 已支持的 OpenCode 风格 Provider 插件认证入口打开本地控制台，使用官方 [`lmfpd-sdk`](https://github.com/Ikaleio/lm-detector/tree/main/sdk/ts) 生成挑战、执行 API 检测、评分并更新参考数据。

**它不是 Magpie Page 插件**，不需要 `magpie.tool.run()` / Page Tool Bridge，不修改 Gateway 路由，也不拦截业务请求。`NoneMore/magpie` Fork 中原来的内置插件保持独立存在，本仓库不会对它做任何更改。

## 安装

Magpie 插件管理中添加：

```sh
magpie plugin add github:NoneMore/magpie-lm-detector
```

打开 Magpie 的 Plugins / Provider 登录入口，选择 **LM Detector (console)** → **打开模型指纹检测控制台**，打开给出的一次性本地链接。此流程借用插件已有的 OAuth UI 打开本地页面，**不需要输入任何授权码或真正完成 OAuth 登录**。Magpie 的插件 Host 需要 Bun 1.4.2+；插件自动安装 `lmfpd-sdk` 依赖，无需 Go、Node 运行时或平台专属二进制。

也可以本地开发：

```sh
npm install
npm run check
magpie plugin add /absolute/path/to/magpie-lm-detector
```

`npm run check` 在 Node.js 22+ 下执行静态检查和注入式单元 / 本地 HTTP 测试。真实 Magpie + Bun 宿主还应人工进行一次安装与模型采样验收。

## 工作原理

1. Magpie 使用现有插件机制加载 `index.mjs`，它在 Bun 插件宿主进程中开启仅监听 `127.0.0.1` 随机端口的 HTTP 控制台（**无额外子进程**）。
2. 插件认证入口 `authorize()` 为每次打开生成 10 分钟有效、只能使用一次的访问链接。
3. 浏览器消费链接后获取 12 小时有效的 HttpOnly + SameSite=Lax 会话 cookie。管理 API 要求会话；变更类请求还需要正确的 Origin 和自定义请求头。
4. 控制台读取 Magpie Gateway 模型列表，选择具体 `provider/model` 后启动 `lmfpd-sdk` 检测任务。Gateway Key 只留在后端，不进入前端结果。
5. SDK 从公开源下载压缩指纹参考库并缓存；后续加载会根据数据 TTL 在后台更新，无需插件重新发布。

HTTP 控制台带有严格 Host、Origin、CSP 与路径校验。不要把此本地端口通过反向代理或端口转发公开到互联网；它不是远程管理服务。

## Gateway 配置

首次启动插件会尝试发现 Magpie 的本地 Gateway：

- 如果设置了插件参数 `gatewayURL` / `gatewayKey`，优先使用它们；
- 否则使用 `MAGPIE_FPD_GATEWAY_URL` / `MAGPIE_FPD_GATEWAY_KEY`；
- 否则查找 `MAGPIE_ADDR`，然后查找 `${XDG_CONFIG_HOME:-~/.config}/magpie/settings.json` 的 `port`，最终回退 `http://127.0.0.1:3425`；
- 默认 Gateway Key 仅对 loopback 地址使用 `magpie`，**不会向远程主机发送该默认 Key**。远程 Gateway 必须使用 HTTPS 和显式 Key。

发现过程在插件宿主启动后异步执行，每隔 5 秒重试，不阻塞 Magpie Gateway 初始化。也可以在控制台手动填写 Gateway URL 和 Key；配置以权限 `0600` 写入用户数据目录（默认 `${XDG_CONFIG_HOME:-~/.config}/magpie-lm-detector/config.json`）。已有 Key 可以在控制台留空以保留。

只接受 Gateway 根地址或 `/v1`，不接受 URL 中的凭据、查询参数、片段或其他路径。检测会发送额外的计费请求。只选择具体模型，拒绝 `group/`、`auto/` 等路由别名，以减少混合采样。

## 检测能力

支持 OpenAI Responses、Chat Completions 和 Anthropic Messages；1–3 个挑战、1–3 并发、1–20 轮重复、SSE、严格模式、推理强度、超时以及中途取消。最多允许两个任务同时运行，任务历史保留在插件宿主内存中，重启后会丢失。已完成轮次单独评分，不会合并概率。

**SDK 限制**：当前 `detector.detect()` 提供整轮完成后的结果，不公开逐样本/逐 token 进度或 TTFT/TPS。独立控制台只展示已完成轮次和结果；SDK 的 `AbortSignal` 可用于取消整轮请求。日后 SDK 提供进度回调时可以改为更细粒度的 UI。SDK 的排名是**闭集候选概率**，不能证明模型真实身份。

SDK 参考数据默认在首次检测或首次加载参考数据状态时联网下载约 3.6 MB 压缩数据，缓存后可离线评分；若网络不可用且没有缓存，检测会失败。需要离线数据源时在启动 Magpie 的环境中设置 `LMFPD_DATA_SOURCE=/path/to/data`（目录内有 `unified_bank.json`、`shared_detector.bin`）。

## 与旧版内置插件并存

本仓库实现完全独立；**没有删除、替换或修改** `NoneMore/magpie/plugins/lm-detector`，也不提供覆盖既有嵌入插件的自动迁移。外置版使用独立包名 `magpie-lm-detector-external`，不会与内置版的 `magpie-lm-detector` 抢占插件身份；两个版本可以同时安装，但会看到两个入口并且需要分别管理；建议仅在外置插件确认可用后由用户自行选择启用哪一个。这里没有 Provider 行动作和 Magpie 内嵌侧边栏页面，因为上游不支持 Fork 的 Page Tool Bridge。

## 开发与致谢

参考 [mu-zi-lee/magpie-intelligence-check](https://github.com/mu-zi-lee/magpie-intelligence-check) 中利用 Magpie 插件认证入口打开独立控制台的方式；检测实现依赖 [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector) 官方 TypeScript SDK（MIT）。原 Fork 的 Page 交互与多轮参数作为独立版功能设计参考；没有复制或固定旧算法 / 指纹库文件。
