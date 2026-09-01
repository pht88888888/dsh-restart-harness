# dsh-restart-harness

一个独立的 DeepSeek Harness Web 重启插件。

它在「设置 → 通用设置」中提供重启按钮，并注册一个可由 AI 调用的 `restart_harness` 工具。插件不依赖 `dshmarket`，可以独立安装和运行。

## 功能

- Windows、macOS、Linux 的自重启流程；
- 等待旧 Web 端口释放后再启动新进程；
- 复用当前正在运行的 DSH 启动参数；
- 自动为重启拉起的 Web 进程加入 `--no-open`，避免重复打开浏览器标签页；
- AI 工具要求提供 `reason` 和 `confirm: true`；
- AI 工具重启后，记录原会话并尝试恢复 Agent；
- 恢复后向原会话发送通知并唤醒后续工作；
- 诊断日志写入 `$DSH_HOME/dsh-restart-harness.log`。

## 安装

在目标 Web profile 目录执行：

```powershell
dsh plugin --profile web add dsh-restart-harness
```

如果使用本地 checkout，也可以把插件目录放入目标 profile 的 `node_modules`，然后将下面的条目加入该 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-restart-harness
      name: 'dsh-restart-harness'
```

安装或修改 Host 端代码后，重启一次 Harness 使插件加载。

## AI 工具

工具名称：`restart_harness`

参数：

```json
{
  "reason": "说明为什么需要重启",
  "confirm": true
}
```

AI 在调用前应先说明重启会中断当前进程。工具执行后，当前进程会退出，独立助手会重新执行原始 `dsh web` 启动命令。

## 诊断

日志路径：

```text
$DSH_HOME/dsh-restart-harness.log
```

只读 HTTP 诊断接口：

```text
GET /dsh-restart/log
```

## 安全说明

重启接口只接受本机回环连接，并要求 `Origin` 与 `Host` 一致，同时拒绝常见代理转发头。不要将 Web 端口暴露到不可信网络。

## 兼容性

需要 DeepSeek Harness 支持 Web profile、Cordis loader、WebServer、Tools 和 Timer 能力。会话恢复依赖当前部署启用了 session persistence 和 agent registry。

## 许可证

MIT
