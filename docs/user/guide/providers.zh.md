# 配置模型

[English](providers.md) | 中文

本指南假定你已按照[根 README](../../../README.zh.md#run)启动 Web UI。模型变更会在下一次请求时生效，不需要重启服务器。

## 配置 DeepSeek

打开**设置 → 模型**。DeepSeek 卡片提供一个 API 密钥字段；输入密钥并保存。

![模型页：DeepSeek 卡片，以及添加提供方与添加自定义提供方两个入口](providers-models-page.zh.png)

密钥是只写的。保存后，页面只会收到脱敏描述符，永远不会收到明文密钥。密钥存储在 `$DSH_HOME/.credentials.yaml` 中，settings 只保留它的凭据引用。

## 添加目录提供方

选择**添加提供方**，选取 Anthropic 或 OpenAI 等提供方，输入其 API 密钥并保存。已安装目录会提供端点、协议和模型列表。

使用原生认证的提供方需要各自的原生凭据。Bedrock、Vertex 和 Azure 分别使用 AWS 凭据与区域、ADC 项目和 `api-version`。Codex 通过 `/login openai-codex` 使用 ChatGPT OAuth；Cursor 使用 `/login cursor`；Antigravity 使用 `/login google-antigravity`。只填写 API 密钥字段无法完成配置。

## 登录 OpenAI Codex

Codex 使用 ChatGPT 订阅，而不是 API 密钥。在 Web UI、CLI 或 ACP 对话中运行一次 `/login openai-codex`，完成 ChatGPT 登录，然后选择一个 `openai-codex` 模型。`/logout openai-codex` 删除已存储的 token。

Web UI 会在这次按键手势里打开新标签。若标签没有出现，请允许 dsh 源的弹出式窗口。第一次标签仍在等待时，第二次 `/login` 会被拒绝。不要把终端里更早的授权 URL 粘贴回去：每次尝试都有自己的 `state`，mismatch 会显示 OpenAI 的 **Authentication failed** 页。

若授权页报告 `missing_required_parameter`，把服务器终端里打印的完整 URL 粘贴到地址栏。点击被换行截断的链接会丢掉 `client_id` 和其余查询参数。

token 存放在 `$DSH_HOME/oauth-credentials.json`（仅属主可读）。它们不是环境变量，也绝不会出现在日志里。模型页不提供 Codex 密钥卡片。

本构建不包含无界面／SSH 的 device-code 登录。

## 登录 Cursor

Cursor 使用 Cursor 订阅，而不是 API 密钥。在 Web UI、CLI 或 ACP 对话中运行一次 `/login cursor`，完成 Cursor 登录，然后选择一个 `cursor` 模型。`/logout cursor` 删除已存储的 token。

Web UI 会像 Codex 一样在这次按键手势里打开新标签。第一次登录仍在等待时，第二次 `/login` 对任一提供方都会被拒绝。

这条非官方 Cursor 后端不是公开 API；Cursor 可能改协议或限制账号。token 与 Codex 共用 `$DSH_HOME/oauth-credentials.json`。模型页不提供 Cursor 密钥卡片。

## 登录 Antigravity

Antigravity 使用 Google 账号和 Cloud Code Assist，而不是 Gemini API 密钥。在 Web UI、CLI 或 ACP 对话中运行一次 `/login google-antigravity`，完成 Google 登录，然后选择一个 `google-antigravity` 模型。`/logout google-antigravity` 删除已存储的 token。

Web UI 会像 Codex 一样在这次按键手势里打开新标签。第一次登录仍在等待时，第二次 `/login` 对任一托管提供方都会被拒绝。

这条非官方 Cloud Code Assist 后端不是公开 API；Google 可能改协议或限制账号。token 与 Codex 共用 `$DSH_HOME/oauth-credentials.json`。模型页不提供 Antigravity 密钥卡片。这不是已安装的 `google` API 密钥 catalog 提供方。

## 添加自定义提供方

对于公司网关、自建服务器或已安装目录中不存在的提供方，选择**添加自定义提供方**。提供小写 Provider ID、基础 URL、API 协议、凭据和至少一个模型。

![自定义提供方表单：Provider ID、显示名称、API 地址、API 协议、API 密钥](providers-custom-form.zh.png)

Provider ID 是永久的，因为请求、已保存会话、模型默认值和凭据引用都会使用它。如需重命名提供方，请添加新提供方并删除旧提供方。显示名称、基础 URL、协议、凭据和模型仍可编辑。

在**模型目录**中选择**获取可用模型**，可查询表单当前显示的基础 URL 和凭据。选择候选项只会更新草稿；保存前不会存储提供方。目录提供方使用已安装目录，不发起网络请求。

### 图片输入

手动输入的模型在自己声明之前一律按纯文本对待，因为没有任何环节能去询问端点接受哪些模态。给这类模型附加图片，会在发送前就被拒绝，并点名该模型。

因此自定义提供方下的视觉模型需要加一行。表单没有对应字段；请在 `$DSH_HOME/settings.yaml` 中给该模型加上 `input`：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: legacy-chat
        - id: vision-preview
          input: [text, image]
```

`input` 接受 `text` 和 `image`，且只作用于该模型，因此一条路由可以同时服务两类模型。省略它——或写成空列表，两者同义——则保留已安装目录为该模型记录的模态；目录未描述的模型则回退到该路由的 `defaultInput`。

如果你手动录入的模型全都接受图片，可以在路由上设置一次回退值，不必逐个模型写：

```yaml
llm-pi-ai:
  providers:
    vision-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://vision.example/v1
      defaultInput: [text, image]
      models:
        - id: first-model
        - id: second-model
```

`defaultInput` 是回退值而不是覆盖值，默认为 `[text]`：在目录提供方上，它只为目录未描述的模型作答，因此绝不会把目录中本就具备图片能力的模型的该能力去掉。要收窄这类模型，请用它自己的 `input`。目录提供方没有可供填写的 `models` 列表，因此写在 `modelOverrides` 下，以模型 id 为键：

```yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        claude-sonnet-4-5:
          input: [text]
```

除模型自身的列表外，每个列表都至少要写一项模态；模型自身的空列表与省略它同义。未知模态在任何位置写入都会被拒绝。

这两个字段都是对你端点的断言，而不是对它的检查。声明了端点并不提供的图片能力的模型不会在这里被拦下，改由提供方拒绝该请求。

### 请求兼容性

网关可能持有可用的密钥、地址也通得到，却仍然拒绝每一个请求。pi-ai 依据端点的 URL 决定请求的形状——系统提示词由哪个角色承载、输出上限写在哪个字段、思考级别如何传输——而对于它无法识别的地址，会当作 OpenAI 本身来对待。多数 OpenAI 兼容网关至少会拒绝 OpenAI 所接受的某一样东西。

其中两样占了绝大多数。声明了推理能力的模型，其系统提示词会以 `role: "developer"` 发出，很多网关直接拒绝；输出上限则写作 `max_completion_tokens`，只认 `max_tokens` 的服务端会拒绝。表单里没有这两个字段；请在 `$DSH_HOME/settings.yaml` 的路由上更正：

```yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: my-model
```

路由的 `compat` 是其模型的默认值，模型自身的则逐字段胜出，因此更正某一个模型无需重述整条路由：

```yaml
      models:
        - id: my-model
        - id: my-reasoner
          compat:
            thinkingFormat: deepseek
```

两者都未设置的字段，沿用已安装 catalog 为该模型记录的值；catalog 也未描述的，落到 pi-ai 的检测。凡是写下的开关都要给值：冒号后留空的键（`supportsDeveloperRole:`）会被拒绝而不是被忽略，因为空值会抹掉 catalog 已知的信息，却又没有给出任何替代。任何协议都不接受的名字同样会被拒绝，报错会列出可用的那些。

每个开关归属于声明了它的那些协议，因此在某个 `api` 上合法的开关，在另一个上可能被拒绝——报错会点名该协议实际提供哪些。与上面的 `input` 一样，开关陈述的是关于你的端点的一个断言，而不是对它的检查：设置一个网关其实并不需要的开关，只是发出一个不同的请求而已。

全部开关、各自接受的取值，以及接受它们的协议，都列在[生成的 `dsh-llm-pi-ai` 配置参考](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai)的 `PiAiCompatProfile` 之下——该参考派生自源码，因此不会落后于适配器实际接受的内容。

## 选择模型

已配置的提供方会出现在模型选择器中。选择模型也会将其设为新会话的默认值。已发送过请求的会话会保留自身日志中记录的模型。

如果已保存默认值指向已删除的提供方，输入框会显示**选择模型**，并在选择其他模型前阻止输入。

## 排错

- **`MISSING_CREDENTIAL`**：通过模型页存储提供方密钥，提供被引用的环境变量，或对 Codex 运行 `/login openai-codex`，对 Cursor 运行 `/login cursor`，对 Antigravity 运行 `/login google-antigravity`。
- **`UNKNOWN_MODEL`**：选择已配置的模型，或向自定义提供方添加缺失的模型。
- **获取可用模型返回 401**：检查密钥。模型发现会调用 OpenAI 兼容的 `GET /models` 端点；对于不提供该端点的服务，请手动输入模型。
- **密钥与地址都正确，网关却拒绝每一个请求**：它的请求形状与 OpenAI 不同。先在路由上设 `compat.supportsDeveloperRole: false` 与 `compat.maxTokensField: max_tokens`。
- **只有推理模型失败**：pi-ai 把它们的系统提示词以 `developer` 角色发出，而网关拒绝该角色。设 `compat.supportsDeveloperRole: false`。
- **某个 compat 开关因没有值而被拒绝**：冒号后什么都没写。给它一个值，或删掉该键以沿用已安装 catalog 的值。
- **图片在发送前被拒绝**：该模型未声明图片模态。请给自定义提供方的模型加上 `input: [text, image]`；DeepSeek 自身的 chat-completions 路由是纯文本的，且无法通过配置改变。
- **提供方拒绝了带图片的请求**：该模型声明了其端点实际并不提供的图片能力。请从授予它图片能力的那个列表中移除 `image`——可能是模型的 `input`，也可能是路由的 `defaultInput`——然后开启新会话：附加的图片会留在会话日志里，因此在会话离开它之前，同一个请求会不断重复。

## 进阶配置

自动生成的[插件配置目录](../../config-catalog.zh.md)列出每个插件的所有受支持字段与默认值；[`dsh-llm-pi-ai`](../../config-catalog.zh.md#deepseek-aidsh-llm-pi-ai) 就是本页所配置的那个提供方段落。[`dsh-llm-pi-ai`](../../../packages/llm/llm-pi-ai/README.zh.md) 和 [`dsh-llm-deepseek`](../../../packages/llm/llm-deepseek/README.zh.md) 参考文档负责直接 `settings.yaml` 配置、目录解析、推理控制、凭据与适配器错误。
