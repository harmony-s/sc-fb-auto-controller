# 发布检查清单

提交新版本前必须确认：

- `@name` 仍为 `Shopcity Facebook 广告自动控制器`。
- `@namespace` 仍为 `xh-shopcity`。
- `@version` 与 `CURRENT_VERSION` 完全一致。
- 未将飞书 App Secret、GitHub Token 或 Shopcity 密码写入仓库。
- 脚本通过 `node --check`。
- `versions.json` 通过 JSON 解析，其 SHA-256 与对应发布文件一致。
- 新增远程域名时，已有明确的 userscript `@connect` 权限且经过审核。
- 稳定版已用观察模式完成至少一轮验证。

`stable` 通道只允许审核通过的版本；未完成验证的版本应放入 `beta` 或 `dev`。
