# Shopcity FB Auto Controller

Shopcity Facebook 广告自动控制脚本，支持广告检测、暂停/复核、飞书多维表格同步和 GitHub 在线版本管理。

## Shop ID 自动获取

v1.8.1 起，脚本打开 ShopCity Facebook 转化页面后会自动识别当前登录店铺的 Shop ID。识别顺序为 `https://api.shopcity.vip/sail/seller/check-user` 登录状态接口、当前网址、页面数据、Cookie 和浏览器存储。手动填写仍保留为兜底；自动检测到的值与现有手动值不同时，不会在后台静默覆盖，可点击面板中的“自动获取”按钮主动替换。

## 安装最新稳定版

在已安装 Tampermonkey 的浏览器中打开：

https://raw.githubusercontent.com/harmony-s/sc-fb-auto-controller/master/Shopcity_FB_Auto_Controller.user.js

Tampermonkey 会显示安装或更新确认页。

## 版本中心

脚本从仓库根目录的 `versions.json` 读取可用版本，支持：

- `stable`：审核后的稳定版。
- `beta`：用于小范围测试的版本。
- `dev`：开发验证版本。
- `historical`：历史快照，只在“全部历史版本”中显示。

安装前会下载目标脚本并校验 SHA-256；校验通过后才打开 Tampermonkey 确认页。脚本不会用 `eval` 或 `new Function` 静默执行远程代码。

## 仓库结构

```text
Shopcity_FB_Auto_Controller.user.js   # 最新稳定版安装入口
versions.json                          # 版本清单
releases/<version>/                    # 不可随意覆盖的版本快照
```

## 多开发者发布规则

1. 每位开发者在独立分支修改脚本，不直接覆盖稳定版。
2. 新版本必须更新 userscript 头部的 `@version` 和代码中的 `CURRENT_VERSION`。
3. 将定稿放入 `releases/<version>/Shopcity_FB_Auto_Controller.user.js`。
4. 计算 SHA-256，然后在 `versions.json` 新增记录，写明 `developer`、`channels`、发布日期和更新说明。
5. 通过语法、功能和安全审核后，才能加入 `stable` 通道并更新根目录安装入口。

请保持 `@name` 和 `@namespace` 不变，以便升级或回退时保留原有运行参数及飞书配置。
