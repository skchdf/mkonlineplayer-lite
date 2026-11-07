# MKOnlinePlayer Lite

> MKOnlinePlayer 的小幅优化改动版：保留原版界面和交互，补上可直接运行的自托管后端，并做了一些实用上的小改动。

原项目：[mengkunsoft/MKOnlineMusicPlayer](https://github.com/mengkunsoft/MKOnlineMusicPlayer)
（2021 年起停止维护，作者移除了后端，只保留 UI。）

## 这个版本改了什么

- 用 **Node.js + [Meting](https://github.com/metowolf/Meting)（`@meting/core`）** 重写后端，复刻旧 `api.php` 的 `types=` 协议，只接网易云音源。
- 移除在线歌单、账号同步、音源切换等依赖旧后端的入口，只保留 **搜索 / 播放 / 下载 / 歌词**。
- 删除“外链”入口（它和下载用的是同一个播放地址），原位置改为 **下载歌词文件**。
- 支持显示歌词翻译（`tlyric`）：翻译显示在原文下方，正在播放的那一句会同步高亮。
- 下载的 `.lrc` 会合并原文和翻译；带 UTF-8 BOM，Windows 播放器也能正常识别。
- 网易云部分歌曲的 `tlyric` 时间轴会整体错位一行。原文和翻译的有效行数一致时，按行顺序配对，自动纠正这类错位；行数不一致时回退到时间戳匹配。
- 后端统一把网易云的 `http://` 播放地址改写成 `https://`，并对上游请求做超时兜底和短缓存。

## 快速开始

需要 Node.js 18+。

```bash
npm install
./start.sh
```

默认监听 `[::]:8099`（IPv4 + IPv6 双栈），浏览器打开 `http://127.0.0.1:8099`。

```bash
PORT=9000 ./start.sh            # 换端口
HOST=127.0.0.1 ./start.sh       # 只允许本机访问
HOST=0.0.0.0 ./start.sh         # 只监听 IPv4
```

也可以直接运行：

```bash
node server.mjs
PORT=9000 HOST=:: node server.mjs
```

## 接口

与旧版 `api.php` 保持兼容，支持 `&callback=cb` 的 JSONP：

| 用途 | 请求 |
|---|---|
| 搜索 | `/api.php?types=search&source=netease&name=周杰伦&count=20&pages=1` |
| 歌曲地址 | `/api.php?types=url&source=netease&id=5257138` |
| 封面 | `/api.php?types=pic&source=netease&id=<pic_id>` |
| 歌词 | `/api.php?types=lyric&source=netease&id=5257138` |

`source` 参数仅为兼容旧客户端保留，传其它值也会按网易云处理。
歌词接口返回 `{ lyric, tlyric }`。

## 目录

```
mkplayer/
├── server.mjs        # 静态托管 + /api.php 适配层
├── start.sh          # 启动脚本（局域网 + 公网 IPv6）
├── package.json
├── public/           # 精简后的前端
│   ├── index.html
│   ├── css/
│   ├── js/           # 播放器、歌词、搜索、列表
│   ├── images/
│   └── plugns/layer/ # 弹窗插件
└── node_modules/     # 只有 @meting/core
```

## 已知限制

- 只使用网易云音源；VIP / 版权受限歌曲返回空地址，前端会自动跳到下一首。
- 不提供在线歌单和网易云账号歌单同步。
- 翻译内容来自网易云，个别歌曲的翻译本身存在拆行或语序问题，无法靠时间轴自动修正。
- 仅供本地学习和个人使用，请勿部署为公开的盗版音乐站。

## 版权与致谢

- 前端 UI 及原始代码版权归 [mengkun](https://mkblog.cn) / [mengkunsoft/MKOnlineMusicPlayer](https://github.com/mengkunsoft/MKOnlineMusicPlayer) 所有。
- 后端使用 [@meting/core](https://github.com/metowolf/Meting)，弹窗使用 layer，滚动条使用 jQuery mCustomScrollbar。
- 原项目仓库未声明开源许可证；本仓库仅作学习交流用途，请保留原作者的版权信息。
