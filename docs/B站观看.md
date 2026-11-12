# B站观看功能

> 通过 DSH 现有的 LLM / 记忆 / 定时器能力实现；没有安装额外 B站插件。B站网页/API 用系统 `curl` 访问（Node 原生 fetch 容易被 B站 WAF 返回 412）。

## 1. 她会做什么

- **看视频统一在晚上 19:00–23:00** 之间随机选 4 个时间点；
- 每个时间点看 **最多 5 个** B站视频，每天总计 **最多 20 个**；
- 视频先看完并放进待分享队列；**分享/评论/写记忆仍按原来的随机时间窗口 09:00–23:00**，到分享时间才发评论并写入记忆；
- 搜索来源：当前「感兴趣标签」+ 人设 / 近期记忆生成的初始兴趣；
- 只挑标题/标签与兴趣相关的视频；
- 每个视频读标题、UP主、简介、标签、热门评论；登录 Cookie 可用时再读字幕和 B站 AI 总结；
- 每个视频在**分享时间**写成一条 **短期记忆**（source=`bilibili`，category=`事件`），最长 **30000 字**；记忆以第一人称写成「我自己刷 B 站时点开的、看完想分享给主人」，关键词和 metadata.who 固定包含「奥菲莉亚」「主人」，segments.who 也补成「奥菲莉亚、主人」；内容要求具体，不是平台推送；之后的层级压缩/维护按记忆规则自动处理；
- 有趣的视频会把 LLM 判断出的标签加入「感兴趣标签」；
- 配置了 B站 Cookie + 主人 UID 后，有趣的视频会在**分享时间**评论区发一句 **10–30 字**、以 `@主人` 开头的推荐；每天最多 5 条（可配置）。

## 2. 登录（推荐扫码，不用手抄 Cookie）

重启 Harness 后，打开：

```text
http://127.0.0.1:<当前 DSH 端口>/dsh-companion/bili/login
```

例如 Web GUI 是 `http://127.0.0.1:12345`，就打开：

```text
http://127.0.0.1:12345/dsh-companion/bili/login
```

在页面里：

1. 点「生成登录二维码」；
2. 用**她的 B站账号**（不是主人的号）手机 B站 App 扫码并确认；
3. 二维码约 3 分钟有效，过期可重新生成；
4. 登录成功后，页面会显示她的 B站昵称/UID；
5. 在「主人 B站账号」填主人的 **UID** 和昵称；
6. 需要评论区 @ 时勾选「允许她在有趣视频评论区 @ 我」，再点保存。

登录成功后 Cookie 只会写入角色数据目录：

```text
<数据目录>\characters\ophelia\bilibili\account.json
```

页面和日志都不会回显 Cookie。扫码保存后 watcher 会自动重新加载账号，不需要再次重启。

### 2.1 手动 Cookie（备用）

如果扫码不可用，也可以手动编辑 `account.json`：

```json
{
  "cookie": "SESSDATA=...; bili_jct=...; DedeUserID=...; buvid3=...",
  "csrf": "",
  "ownerUid": "主人的B站UID（纯数字）",
  "ownerName": "主人的B站昵称",
  "commentEnabled": true
}
```

- `cookie` 至少要有 `SESSDATA`、`bili_jct`；有 `buvid3` 更稳；
- `csrf` 可留空，会自动从 `bili_jct` 读取；
- `ownerUid` 是主人 B站主页 URL 里的数字 UID，不是 QQ 号；
- `commentEnabled` 必须为 `true` 才会真正发评论。

> `account.json` 含登录凭证。不要发到聊天里、不要提交到 Git、不要截图。评论会公开出现在 B站评论区。

### 2.2 数据文件

```text
<数据目录>\characters\ophelia\bilibili\
├── state.json     # 当天随机时间、已看/已评论、兴趣标签、历史（插件自动维护）
└── account.json   # B站登录凭证、机器人/主人 UID、评论开关（扫码或手填）
```

## 3. 开关和参数

在 `<repo>\companion-bundle\cordis.patch.yml` 的 `companion-host` 配置：

```yaml
bilibili:
  enabled: true
  dailyLimit: 20
  sessionSize: 5
  maxSessions: 4
  startHour: 9
  endHour: 23
  watchStartHour: 19     # 看视频的晚间窗口
  watchEndHour: 23
  summaryMaxChars: 30000
  commentEnabled: true      # 总开关；account.commentEnabled 也要 true
  commentMaxPerDay: 5
  searchPages: 2
```

改完重启 Harness 生效。

## 4. 状态查看

- `bilibili/state.json`：`watchedToday`、`commentsToday`、`interests`、`nextSessionAt`、`history`；
- `bilibili/account.json`：你的配置（不要把 Cookie 贴给别人）；
- 记忆：`memory/short-term.json` 里 `source: "bilibili"` 的条目。

## 5. 已知限制

- 没有 Cookie 时只能看公开的标题/简介/标签/评论，字幕和 B站 AI 总结需要登录；
- B站 WAF 可能短时间返回 412；客户端已使用 `curl + buvid3` 降低概率，但仍需合理频率；
- 评论接口需要有效 Cookie、CSRF、主人 UID；失效时需要重新导出 Cookie；
- “看视频”不是播放音视频，而是读取视频公开内容/字幕/评论后总结；没有字幕或 AI 总结时，总结深度有限；
- 每日 20 个、每次 5 个是上限，实际可能因搜索/接口失败少于这个数。
