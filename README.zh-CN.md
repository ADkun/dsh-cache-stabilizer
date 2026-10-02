# dsh-cache-stabilizer

[![CI](https://github.com/dongsheng123132/dsh-cache-stabilizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/dsh-cache-stabilizer/actions/workflows/ci.yml)
[![MIT 许可证](https://img.shields.io/github/license/dongsheng123132/dsh-cache-stabilizer)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-%E5%B7%B2%E9%AA%8C%E8%AF%81%E5%AE%9E%E9%AA%8C-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins/blob/main/README.zh-CN.md#2origin-%E6%8F%92%E4%BB%B6%E5%AE%9E%E9%AA%8C%E5%AE%A4)

一个 MIT 开源的 DeepSeek Harness 缓存前缀稳定插件。它不伪造缓存，也不会为了命中率使用过期上下文。

它做两项不改变语义的处理：

- 把 DSH 已知默认 persona 中的工作目录从系统提示词前缀移到运行时上下文。不同项目因此能复用相同的系统前缀，同时每次请求仍会收到正确的 `cwd`。
- 递归固定工具 schema 的对象键顺序。DSH 自己已经固定了工具名称顺序。

插件还注册了仅供人使用的 `/cache` 命令：显示模型供应商实际返回的命中 token、未命中 token、写缓存 token，**逐请求归因**每次未命中，并报告搬运是否真的在生效。它绝不臆造命中。

## `/cache` 的输出

```
Cache hit rate: 78.6% (cacheRead / (cacheRead + uncached input); cache-write excluded)
Hit / Miss / Write tokens: 81700 / 22200 / 0
Usage-bearing responses: 6/6
Miss tokens by cause: cold start 14500, no header change 7700
  (no header change = no logged header change: provider TTL expiry or a client-side rewrite)
Recent requests (hit% / miss / cause):
  #5 94.3% miss 1300 no header change
  #6 86.9% miss 2900 no header change
Relocation: active — the cwd sentence left the persona slot on 6/6 assemblies; cwd now arrives in context "dsh-cache-stabilizer:cwd".
```

- 命中率口径为 `cacheRead / (cacheRead + 未命中输入)`，并在输出里写明"不含写缓存"，因为 DSH 这三个计数是互斥的。
- 归因来自会话自身的 `request/header` 事件：`cold start`（首个请求）、`prompt rewritten`（请求面被重写：压缩折叠或系统提示词更新）、`tools changed`、`route changed`（供应商/模型/配置变化），其余归入 `header changed`。`no header change` 是诚实的"无法归因"桶：DSH 的 header 只带工具清单与调用配置、**不带系统提示词**，所以 header 没变时的未命中只能来自供应商 TTL 过期或客户端重写，无法再细分。
- 最近请求列表给出最后 8 条请求的逐条命中率、未命中 token 与归因，避免一次冷启动被误读成常态命中率。
- Relocation 行直接回答"插件到底有没有生效"（见下）。

命令结果不会进入模型上下文（DSH 解析命令不需要模型轮次），因此 `/cache` 本身既不改变提示词也不消耗 token。

## 收益到底在哪里

如实说明收益大小比夸大它更重要：

- 标准 0.2.x preset 把这句话放在 `deployment:persona-suffix`，其 section order 是 `DEPLOYMENT_PERSONA_SUFFIX`（10200）——系统提示词的**最后一段**。在这里搬运大约只能回收尾部一行字节，真正的价值是正确性与保险：工作目录不再因为换项目或改 cwd 而成为前缀波动源。
- 完整收益出现在把这句话放在 `deployment:persona-prefix`（order 0）、或 DSH 0.1.x 单一 `deployment:persona` 段的部署里：那里的 cwd 字节位于所有内容之前，换项目就会让整段缓存前缀失效。
- 插件**刻意不碰**的尾部波动段：`harness:source`（10000，harness checkout 路径）与 `app:web-surface`（10100，本地 web 端口）。这些事实由 DSH 自己注册，改写它们超出稳定插件的职责。

## 静默失效与检测

搬运依赖逐字匹配那一句 `Your working directory is {{cwd}}.`。如果 DSH 将来改了措辞，搬运会静默失效——表现就是"插件装了但缓存照旧不命中"。

插件会检测这种情况：每个会话只记一条 warning 日志，`/cache` 也会打印

```
Relocation: INACTIVE — 3/3 assemblies carried a known persona section without "Your working directory is {{cwd}}." verbatim; DSH may have reworded it.
```

统计状态只含计数器与名字，其派生内容**从不写入提示词**，因此稳定后的字节与该状态无关。

## 安装

```sh
dsh plugin --profile web add dsh-cache-stabilizer
```

重启 DSH，完成几轮对话后输入 `/cache`。

如果包没有发布到你的 registry，可以直接从 git 安装本 fork：

```sh
dsh plugin --profile web add github:ADkun/dsh-cache-stabilizer
```

自定义 profile 时把 `web` 换成对应名字。在 profile patch 里可以关掉任一优化：

```yaml
- id: dsh-cache-stabilizer
  config:
    relocateCwd: false
    canonicalizeTools: false
    cwdContextName: dsh-cache-stabilizer:cwd
```

`cwdContextName` 是新增的运行时上下文条目名，会原样显示在客户端的 runtime-context 面板里。想与旧版本保持逐字节一致，就不要改它。

## 安全边界

插件只改写 DSH 标准 coding persona 的那一句固定模板。自定义 persona 里其他形式的 `{{cwd}}` 不会被猜测式搬运。插件同时识别两种 persona 布局：DSH 0.1.x 的单一 `deployment:persona` 段，以及 0.2.x 起拆分的 `deployment:persona-prefix` / `deployment:persona-suffix`。只有这几个槽位会被考虑，且必须逐字包含那句模板。插件不会冻结工具清单、复用陈旧状态、代理模型响应，也不会另外造一层结果缓存。

DeepSeek 的供应商缓存是自动的，依赖从 token 0 开始的精确前缀匹配；存储与淘汰仍由供应商控制。

## 验证

- **默认输出与 0.1.2 逐字节一致。** `test/parity.test.mjs` 把当前实现与**已发布的 0.1.2 模块**（以 `test/legacy-0.1.2.mjs` 原样入库，来自 `git show ea27dfd:lib/stabilizer.mjs`）做差分对比，覆盖 12 种 assembly 形态 × 6 种配置，断言深相等、序列化相等、顶层结构相同，且输入 assembly 从未被改写。唯一的有意差异是新增的可选开关 `cwdContextName`。
- **断言的是渲染后的字节，而不只是字段。** `test/render.test.mjs` 镜像 DSH 的 `interpolate` / `joinContextSections`，断言两个项目渲染出**完全相同**的系统提示词、cwd 恰好出现一次且只出现在运行时上下文快照中、重复稳定化幂等。
- **入口点端到端。** `test/plugin.test.mjs` 用 stub context 驱动 `index.js`：搬运、工具键序规范化、一次性告警、`/cache` 文本、无 logger 的 context、以及 profile patch 式配置。
- **分配开销。** 已经规范的 schema 按引用返回，因此 DSH 由字面量构造的 schema 在每个装配步都不产生新分配。

## 开发

```sh
npm test
npm run check
```