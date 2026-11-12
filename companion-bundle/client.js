window.__ModuleLoader__.load({
  id: '@local/dsh-companion',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'companionModels';
    /** Panel id shared by the sidebar entry and the main-area page. */
    const PANEL_ID = 'companion-models';
    /** Same-origin routes registered by the Host halves. */
    const CATALOG_URL = '/dsh-companion/models/catalog';
    const DEFAULT_URL = '/dsh-companion/models/default';
    const PRESETS_URL = '/dsh-companion/models/presets';
    const QQ_URL = '/dsh-companion/qq/model';
    const QQ_RESET_URL = '/dsh-companion/qq/model/reset';
    const CHANNEL_URL = '/dsh-companion/qq/channel';
    const CHANNEL_ALLOW_URL = '/dsh-companion/qq/channel/allow';
    const CHANNEL_DENY_URL = '/dsh-companion/qq/channel/deny';

    const zh = {
      'panel.title': '模型',
      'page.title': '模型切换',
      'page.subtitle': '上方选择 QQ 接入通道；下方点一下快捷模型立即切换，也可以手动填入新的 provider / 模型 id。',
      'action.refresh': '刷新',
      'action.back': '返回会话',
      'action.apply': '应用',
      'action.saveApply': '保存并应用',
      'action.resetQq': '恢复插件配置',
      'action.manual': '手动输入新模型',
      'action.closeManual': '收起手动输入',
      'section.channel.title': 'QQ 接入通道',
      'section.channel.hint': '选择用 NapCat 还是 QQ 官方机器人接收消息。切换会重建 QQ 连接，不影响模型设置与记忆。',
      'channel.napcat.label': 'NapCat / OneBot 11',
      'channel.napcat.desc': '本地 NapCat 连接，功能完整（主动分享、输入状态等）；需要 NapCat 保持在线。',
      'channel.qqbot.label': 'QQ 官方机器人',
      'channel.qqbot.desc': 'QQ 开放平台官方接口，不需要 NapCat；只能被动回复，主动分享不可用。',
      'channel.current': '当前',
      'channel.configured': '已配置',
      'channel.notConfigured': '未配置',
      'channel.switching': '切换中…',
      'channel.appId': 'AppID',
      'channel.secret': 'AppSecret',
      'channel.secretSaved': '已保存，留空则不修改',
      'channel.sandbox': '使用沙盒环境',
      'channel.saveConnect': '保存并连接',
      'channel.cancel': '取消',
      'channel.edit': '修改凭据',
      'channel.pending.title': '待批准的 QQBot 用户',
      'channel.pending.desc': 'QQ 官方机器人用 openid 标识用户，和 NapCat 的 QQ 号白名单不通用。第一次私聊后会出现在这里，批准后才进入人设回复。',
      'channel.pending.allow': '批准',
      'channel.pending.deny': '忽略',
      'channel.pending.empty': '暂无待批准用户',
      'channel.allowOpenids': '已批准 openid：',
      'channel.adapterState': '连接状态：{state}',
      'channel.error': 'QQ 通道状态读取失败：{message}',
      'notice.channelSwitched': '已切换到 {name}',
      'notice.channelSaved': '凭据已保存，正在连接 QQ 官方机器人',
      'notice.userAllowed': '已批准这个 QQBot 用户',
      'notice.userDenied': '已忽略这个待审批用户',
      'error.channelEmpty': '请填写 AppID 和 AppSecret',
      'section.qq.title': 'QQ 聊天模型',
      'section.qq.hint': '只影响 QQ 通道的文字回复；切换后下一条消息立即使用新模型，不需要重启或断开连接。',
      'section.default.title': 'Harness 默认模型',
      'section.default.hint': '用于 Web UI 新会话，以及记忆整理、生活事件、B站总结、生图提示词等工具调用。',
      'section.quick': '快捷切换',
      'quick.empty': '还没有可用的模型。',
      'quick.busy': '正在应用…',
      'quick.tag.current': '当前',
      'quick.tag.config': '配置',
      'current.label': '当前',
      'source.override': '面板覆盖',
      'source.config': '插件配置',
      'source.default': '默认配置',
      'source.unknown': '未知',
      'field.provider': '模型提供方',
      'field.model': '模型',
      'placeholder.provider': '例如 deepseek-account',
      'placeholder.model': '例如 deepseek-flash',
      'manual.hint': '手动输入会直接写入模型路由；provider 需要是 Harness 已注册的提供方。手动模型可以「保存并应用」，下次会出现在快捷切换里。',
      'status.loading': '读取中…',
      'status.updated': '更新于 {time}',
      'status.catalogError': '模型目录读取失败：{message}',
      'status.qqError': 'QQ 模型状态读取失败：{message}',
      'status.defaultError': '默认模型读取失败：{message}',
      'notice.applied': '已切换为 {provider}/{model}',
      'notice.appliedSaved': '已保存并切换为 {provider}/{model}',
      'notice.savedFailed': '已切换，但快捷模型保存失败：{message}',
      'notice.reset': '已恢复插件配置里的模型',
      'notice.failed': '操作失败：{message}',
      'error.unreachable': 'Harness 接口不可用，请刷新页面；若仍然 404，需要重启 Harness 让新路由生效',
      'error.generic': '请求失败',
      'error.emptyRoute': '请先填写 provider 和模型 id',
    };

    const en = {
      'panel.title': 'Models',
      'page.title': 'Model switching',
      'page.subtitle': 'Choose a QQ connection channel above; below, click a quick model or enter a new provider / model id manually.',
      'action.refresh': 'Refresh',
      'action.back': 'Back to conversation',
      'action.apply': 'Apply',
      'action.saveApply': 'Save & apply',
      'action.resetQq': 'Reset to plugin config',
      'action.manual': 'Enter a new model',
      'action.closeManual': 'Hide manual input',
      'section.channel.title': 'QQ connection channel',
      'section.channel.hint': 'Choose NapCat or the official QQ bot. Switching rebuilds the QQ connection; model settings and memories are untouched.',
      'channel.napcat.label': 'NapCat / OneBot 11',
      'channel.napcat.desc': 'Local NapCat connection with the full feature set; NapCat must stay online.',
      'channel.qqbot.label': 'Official QQ bot',
      'channel.qqbot.desc': 'QQ Open Platform; no NapCat needed. Passive replies only; proactive sharing is unavailable.',
      'channel.current': 'Current',
      'channel.configured': 'Configured',
      'channel.notConfigured': 'Not configured',
      'channel.switching': 'Switching…',
      'channel.appId': 'AppID',
      'channel.secret': 'AppSecret',
      'channel.secretSaved': 'Saved; leave blank to keep it',
      'channel.sandbox': 'Use sandbox environment',
      'channel.saveConnect': 'Save & connect',
      'channel.cancel': 'Cancel',
      'channel.edit': 'Edit credentials',
      'channel.pending.title': 'QQBot users awaiting approval',
      'channel.pending.desc': 'The official bot identifies users by openid, which differs from NapCat QQ numbers. The first private message appears here and is answered only after approval.',
      'channel.pending.allow': 'Allow',
      'channel.pending.deny': 'Ignore',
      'channel.pending.empty': 'No pending users',
      'channel.allowOpenids': 'Approved openids: ',
      'channel.adapterState': 'Connection state: {state}',
      'channel.error': 'QQ channel state failed: {message}',
      'notice.channelSwitched': 'Switched to {name}',
      'notice.channelSaved': 'Credentials saved; connecting the official QQ bot',
      'notice.userAllowed': 'Approved this QQBot user',
      'notice.userDenied': 'Ignored this pending user',
      'error.channelEmpty': 'Fill in AppID and AppSecret',
      'section.qq.title': 'QQ chat model',
      'section.qq.hint': 'Affects only QQ text replies. The next message uses the new model; no restart or reconnect needed.',
      'section.default.title': 'Harness default model',
      'section.default.hint': 'Used by new Web UI sessions, memory analysis, life events, Bilibili summaries and image prompts.',
      'section.quick': 'Quick switch',
      'quick.empty': 'No models are available yet.',
      'quick.busy': 'Applying…',
      'quick.tag.current': 'Current',
      'quick.tag.config': 'Config',
      'current.label': 'Current',
      'source.override': 'Panel override',
      'source.config': 'Plugin config',
      'source.default': 'Default config',
      'source.unknown': 'Unknown',
      'field.provider': 'Provider',
      'field.model': 'Model',
      'placeholder.provider': 'e.g. deepseek-account',
      'placeholder.model': 'e.g. deepseek-flash',
      'manual.hint': 'Manual input writes the route directly; the provider must be registered in Harness. "Save & apply" keeps it in the quick-switch list for next time.',
      'status.loading': 'Loading…',
      'status.updated': 'Updated {time}',
      'status.catalogError': 'Model catalog failed: {message}',
      'status.qqError': 'QQ model state failed: {message}',
      'status.defaultError': 'Default model failed: {message}',
      'notice.applied': 'Switched to {provider}/{model}',
      'notice.appliedSaved': 'Saved and switched to {provider}/{model}',
      'notice.savedFailed': 'Switched, but saving the quick model failed: {message}',
      'notice.reset': 'Restored the model from plugin config',
      'notice.failed': 'Action failed: {message}',
      'error.unreachable': 'Harness route unavailable; refresh the page, or restart Harness if it still returns 404',
      'error.generic': 'Request failed',
      'error.emptyRoute': 'Fill in both provider and model id first',
    };

    const CSS = [
      '.cmkRoot{box-sizing:border-box;height:100%;overflow-y:auto;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent)}',
      '.cmkInner{box-sizing:border-box;max-width:860px;margin:0 auto;padding:28px 32px 56px;display:flex;flex-direction:column;gap:18px}',
      '@media (max-width:768px){.cmkInner{padding:20px 20px 48px}}',
      '.cmkHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.cmkHeading{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cmkTitle{margin:0;font-size:20px;font-weight:600;line-height:1.3}',
      '.cmkSubtitle{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cmkButton{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;font-family:inherit;font-size:13px;line-height:1;color:var(--dsw-alias-label-primary,inherit);background:transparent;border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:var(--dsw-radius-sm,6px);cursor:pointer;transition:background 120ms,opacity 120ms}',
      '@media (hover:hover){.cmkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
      '.cmkButton:disabled{opacity:.5;cursor:default}',
      '.cmkButton:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}',
      '.cmkButton[data-tone=primary]{border-color:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cmkStatusLine{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}',
      '.cmkStatusLine[data-tone=error]{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.cmkSection{display:flex;flex-direction:column;gap:14px;padding:18px;border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:12px}',
      '.cmkSectionHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.cmkSectionTitle{margin:0;font-size:15px;font-weight:600}',
      '.cmkSectionHint{margin:4px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkCurrent{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}',
      '.cmkCurrentLabel{color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkRoute{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;overflow-wrap:anywhere}',
      '.cmkBadge{display:inline-flex;align-items:center;padding:0 8px;font-size:11px;line-height:20px;border-radius:999px;border:.5px solid transparent}',
      '.cmkBadge[data-tone=override]{color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent)}',
      '.cmkBadge[data-tone=config],.cmkBadge[data-tone=unknown]{color:var(--dsw-alias-label-secondary,#666);border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc))}',
      '.cmkQuick{display:flex;flex-direction:column;gap:8px}',
      '.cmkQuickHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cmkQuickLabel{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkQuickBusy{font-size:12px;color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cmkChips{display:flex;flex-wrap:wrap;gap:8px}',
      '.cmkChip{appearance:none;display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:100%;padding:7px 10px;font-family:inherit;text-align:left;color:var(--dsw-alias-label-primary,inherit);background:transparent;border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:8px;cursor:pointer;transition:background 120ms,border-color 120ms,opacity 120ms}',
      '@media (hover:hover){.cmkChip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
      '.cmkChip:disabled{opacity:.5;cursor:default}',
      '.cmkChip:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}',
      '.cmkChip[data-active=true]{border-color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 10%,transparent)}',
      '.cmkChipModel{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.4}',
      '.cmkChipProvider{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:1.4;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkChipTag{font-size:10px;line-height:1.4;color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cmkManual{display:flex;flex-direction:column;gap:8px;border-top:.5px solid var(--dsw-alias-border-l3,#ddd);padding-top:12px}',
      '.cmkTextButton{appearance:none;align-self:flex-start;padding:0;font-family:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-business-primary,#4176e6);background:transparent;border:0;cursor:pointer}',
      '.cmkTextButton:hover{text-decoration:underline}',
      '.cmkManualBody{display:flex;flex-direction:column;gap:10px}',
      '.cmkForm{display:flex;flex-direction:column;gap:10px}',
      '.cmkField{display:flex;flex-direction:column;gap:5px}',
      '.cmkFieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkControl{box-sizing:border-box;width:100%;height:32px;padding:0 10px;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-base,transparent);border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:var(--dsw-radius-sm,6px)}',
      '.cmkControl:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}',
      '.cmkHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkHint[data-tone=error]{color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.cmkNotice{font-size:13px;line-height:1.5;padding:8px 12px;border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:8px;color:var(--dsw-alias-label-primary,inherit)}',
      '.cmkNotice[data-tone=success]{border-color:var(--dsw-alias-state-done-primary,#2e7d32);color:var(--dsw-alias-state-done-primary,#2e7d32)}',
      '.cmkNotice[data-tone=error]{border-color:var(--dsw-alias-state-error-primary,#c62828);color:var(--dsw-alias-state-error-primary,#c62828)}',
      '.cmkChannels{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
      '.cmkChannelOption{appearance:none;display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:12px;font-family:inherit;text-align:left;color:var(--dsw-alias-label-primary,inherit);background:transparent;border:.5px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l3,#ccc));border-radius:10px;cursor:pointer;transition:background 120ms,border-color 120ms,opacity 120ms}',
      '@media (hover:hover){.cmkChannelOption:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}}',
      '.cmkChannelOption:disabled{opacity:.5;cursor:default}',
      '.cmkChannelOption:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}',
      '.cmkChannelOption[data-active=true]{border-color:var(--dsw-alias-state-business-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 10%,transparent)}',
      '.cmkChannelName{font-size:14px;font-weight:600;line-height:1.3}',
      '.cmkChannelDesc{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary,#666)}',
      '.cmkChannelMeta{font-size:11px;line-height:1.4;color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cmkChannelForm{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l3,#ddd);padding-top:12px}',
      '.cmkCheckbox{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}',
      '.cmkCheckbox input{accent-color:var(--dsw-alias-state-business-primary,#4176e6)}',
      '.cmkPending{display:flex;flex-direction:column;gap:6px;border-top:.5px solid var(--dsw-alias-border-l3,#ddd);padding-top:12px}',
      '.cmkPendingRow{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:7px 0}',
      '.cmkPendingId{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;overflow-wrap:anywhere;max-width:100%}',
    ].join('');

    /** Error carrying the route's error code. */
    function apiError(code, message) {
      const error = new Error(message);
      error.code = code;
      return error;
    }

    /** Call one same-origin route and unwrap its envelope. */
    async function callApi(method, path, body) {
      const options = {
        method,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      };
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      let response;
      try {
        response = await fetch(path, options);
      } catch {
        throw apiError('unreachable', 'Harness route unavailable');
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (response.status === 404 || response.status === 405) {
        throw apiError('unreachable', 'Harness route unavailable');
      }
      if (!response.ok || !payload || payload.ok !== true) {
        throw apiError(
          payload && payload.error ? payload.error.code : 'http',
          payload && payload.error ? payload.error.message : 'HTTP ' + response.status,
        );
      }
      return payload.data;
    }

    /** Localized text for one request failure. */
    function describeError(error, t) {
      if (error && error.code === 'unreachable') return t('error.unreachable');
      return error && error.message ? error.message : t('error.generic');
    }

    /** True for a usable provider/model pair. */
    function isRoute(value) {
      return Boolean(value && typeof value.provider === 'string' && value.provider.trim() && typeof value.model === 'string' && value.model.trim());
    }

    /** Stable key for deduplicating routes. */
    function routeKey(provider, model) {
      return String(provider) + '\u0000' + String(model);
    }

    /** All provider/model pairs returned by the catalog. */
    function catalogRoutes(catalog) {
      const routes = [];
      for (const provider of catalog.providers || []) {
        if (!provider || typeof provider.provider !== 'string') continue;
        for (const model of provider.models || []) {
          if (!model || typeof model.id !== 'string' || !model.id) continue;
          routes.push({ provider: provider.provider, model: model.id });
        }
      }
      return routes;
    }

    /** Provider ids for datalist suggestions. */
    function providerIds(catalog) {
      const ids = [];
      for (const provider of catalog.providers || []) {
        if (provider && typeof provider.provider === 'string' && ids.indexOf(provider.provider) === -1) ids.push(provider.provider);
      }
      return ids;
    }

    /** Model ids for one provider's datalist. */
    function modelIdsFor(catalog, provider) {
      const ids = [];
      for (const entry of catalog.providers || []) {
        if (!entry || entry.provider !== provider) continue;
        for (const model of entry.models || []) {
          if (model && typeof model.id === 'string' && model.id && ids.indexOf(model.id) === -1) ids.push(model.id);
        }
      }
      return ids;
    }

    /** Provider discovery error, shown under the manual inputs. */
    function providerError(catalog, provider) {
      for (const entry of catalog.providers || []) {
        if (entry && entry.provider === provider && entry.error) return entry.error;
      }
      return undefined;
    }

    /** Format one route for display. */
    function routeText(route) {
      if (!isRoute(route)) return '';
      return route.provider + ' / ' + route.model + (route.reasoningEffort ? ' · ' + route.reasoningEffort : '');
    }

    /** Ordered quick-switch choices: current, saved, config fallback, then catalog. */
    function quickChoices(catalog, current, fallback, saved) {
      const out = [];
      const seen = new Set();
      const push = (route, tag) => {
        if (!isRoute(route)) return;
        const provider = route.provider.trim();
        const model = route.model.trim();
        const key = routeKey(provider, model);
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ provider, model, key, ...(tag ? { tag } : {}) });
      };
      push(current, 'current');
      push(fallback, 'config');
      for (const route of saved) push(route, undefined);
      for (const route of catalogRoutes(catalog)) push(route, undefined);
      return out;
    }

    /** Sidebar entry glyph. */
    function PanelGlyph({ size }) {
      const side = typeof size === 'number' ? size : 16;
      return h('svg', {
        width: side,
        height: side,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M2.5 4.25h1.4M7.6 4.25h5.9M2.5 8h7.1M12.1 8h1.4M2.5 11.75h2.4M8.6 11.75h4.9', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('circle', { cx: 5.5, cy: 4.25, r: 1.45, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 10.5, cy: 8, r: 1.45, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 6.5, cy: 11.75, r: 1.45, stroke: 'currentColor', strokeWidth: 1.2 }),
      );
    }

    /** Build the model page component bound to the client context and locale binding. */
    function createPage(context, fallbackT) {
      return function CompanionModelsPage(props) {
        const t = props && typeof props.t === 'function' ? props.t : fallbackT;
        const [catalog, setCatalog] = React.useState({ state: 'loading', providers: [], error: null, fetchedAt: null });
        const [qq, setQq] = React.useState({ state: 'loading', data: null, error: null });
        const [channel, setChannel] = React.useState({ state: 'loading', data: null, error: null });
        const [def, setDef] = React.useState({ state: 'loading', data: null, error: null });
        const [saved, setSaved] = React.useState([]);
        const [manualValues, setManualValues] = React.useState({ qq: { provider: '', model: '' }, default: { provider: '', model: '' } });
        const [manualOpen, setManualOpen] = React.useState({ qq: false, default: false });
        const [channelForm, setChannelForm] = React.useState({ open: false, appId: '', clientSecret: '', sandbox: false });
        const [pendingBusy, setPendingBusy] = React.useState(null);
        const [busy, setBusy] = React.useState(null);
        const [notice, setNotice] = React.useState(null);
        const mounted = React.useRef(true);

        React.useEffect(() => {
          mounted.current = true;
          return () => {
            mounted.current = false;
          };
        }, []);

        const loadCatalog = React.useCallback(async () => {
          try {
            const data = await callApi('GET', CATALOG_URL);
            if (!mounted.current) return;
            setCatalog({ state: 'ready', providers: data.providers || [], error: data.error || null, fetchedAt: data.fetchedAt || null });
          } catch (error) {
            if (!mounted.current) return;
            setCatalog({ state: 'error', providers: [], error: describeError(error, t), fetchedAt: null });
          }
        }, [t]);

        const loadQq = React.useCallback(async () => {
          try {
            const data = await callApi('GET', QQ_URL);
            if (!mounted.current) return;
            setQq({ state: 'ready', data, error: null });
          } catch (error) {
            if (!mounted.current) return;
            setQq({ state: 'error', data: null, error: describeError(error, t) });
          }
        }, [t]);

        const loadChannel = React.useCallback(async () => {
          try {
            const data = await callApi('GET', CHANNEL_URL);
            if (!mounted.current) return;
            setChannel({ state: 'ready', data, error: null });
            if (data && data.qqbot) {
              setChannelForm((previous) => ({
                ...previous,
                appId: previous.appId || data.qqbot.appId || '',
                sandbox: typeof previous.sandbox === 'boolean' && previous.sandbox
                  ? previous.sandbox
                  : Boolean(data.qqbot.sandbox),
              }));
            }
          } catch (error) {
            if (!mounted.current) return;
            setChannel({ state: 'error', data: null, error: describeError(error, t) });
          }
        }, [t]);

        const loadDefault = React.useCallback(async () => {
          try {
            const data = await callApi('GET', DEFAULT_URL);
            if (!mounted.current) return;
            setDef({ state: 'ready', data, error: null });
          } catch (error) {
            if (!mounted.current) return;
            setDef({ state: 'error', data: null, error: describeError(error, t) });
          }
        }, [t]);

        const loadPresets = React.useCallback(async () => {
          try {
            const data = await callApi('GET', PRESETS_URL);
            if (!mounted.current) return;
            setSaved(Array.isArray(data.presets) ? data.presets : []);
          } catch {
            // 快捷模型读取失败不影响主面板；保留已有列表。
          }
        }, []);

        const loadAll = React.useCallback(async () => {
          setBusy('refresh');
          setNotice(null);
          await Promise.allSettled([loadCatalog(), loadQq(), loadChannel(), loadDefault(), loadPresets()]);
          if (mounted.current) setBusy(null);
        }, [loadCatalog, loadQq, loadChannel, loadDefault, loadPresets]);

        React.useEffect(() => {
          void loadAll();
        }, [loadAll]);

        const savePreset = async (provider, model) => {
          try {
            const data = await callApi('POST', PRESETS_URL, { provider, model });
            if (mounted.current && Array.isArray(data.presets)) setSaved(data.presets);
            return true;
          } catch {
            return false;
          }
        };

        const applyRoute = async (section, provider, model, options = {}) => {
          if (busy !== null) return;
          const nextProvider = String(provider || '').trim();
          const nextModel = String(model || '').trim();
          if (!nextProvider || !nextModel) {
            setNotice({ tone: 'error', text: t('error.emptyRoute') });
            return;
          }
          setBusy(section);
          setNotice(null);
          try {
            const data = await callApi('POST', section === 'qq' ? QQ_URL : DEFAULT_URL, { provider: nextProvider, model: nextModel });
            if (!mounted.current) return;
            if (section === 'qq') setQq({ state: 'ready', data, error: null });
            else setDef({ state: 'ready', data, error: null });
            if (options.remember) {
              const savedOk = await savePreset(nextProvider, nextModel);
              if (!mounted.current) return;
              if (savedOk) {
                setNotice({ tone: 'success', text: t('notice.appliedSaved', { provider: nextProvider, model: nextModel }) });
              } else {
                setNotice({ tone: 'error', text: t('notice.savedFailed', { message: t('error.generic') }) });
              }
              return;
            }
            setNotice({ tone: 'success', text: t('notice.applied', { provider: nextProvider, model: nextModel }) });
          } catch (error) {
            if (!mounted.current) return;
            setNotice({ tone: 'error', text: t('notice.failed', { message: describeError(error, t) }) });
          } finally {
            if (mounted.current) setBusy(null);
          }
        };

        const resetQq = async () => {
          if (busy !== null) return;
          setBusy('qq');
          setNotice(null);
          try {
            const data = await callApi('POST', QQ_RESET_URL, {});
            if (!mounted.current) return;
            setQq({ state: 'ready', data, error: null });
            setNotice({ tone: 'success', text: t('notice.reset') });
          } catch (error) {
            if (!mounted.current) return;
            setNotice({ tone: 'error', text: t('notice.failed', { message: describeError(error, t) }) });
          } finally {
            if (mounted.current) setBusy(null);
          }
        };

        const openChannelForm = () => {
          const qqbot = channel.data && channel.data.qqbot ? channel.data.qqbot : {};
          setChannelForm({
            open: true,
            appId: qqbot.appId || '',
            clientSecret: '',
            sandbox: Boolean(qqbot.sandbox),
          });
        };

        const postChannel = async (nextChannel, qqbot, successText) => {
          if (busy !== null) return;
          setBusy('channel');
          setNotice(null);
          try {
            const data = await callApi('POST', CHANNEL_URL, {
              channel: nextChannel,
              ...(qqbot ? { qqbot } : {}),
            });
            if (!mounted.current) return;
            setChannel({ state: 'ready', data, error: null });
            if (qqbot) setChannelForm((previous) => ({ ...previous, open: false, clientSecret: '' }));
            const label = data && data.channelLabel
              ? data.channelLabel
              : nextChannel === 'qqbot'
                ? t('channel.qqbot.label')
                : t('channel.napcat.label');
            setNotice({ tone: 'success', text: successText || t('notice.channelSwitched', { name: label }) });
            if (data && data.adapter && data.adapter.state === 'starting') {
              setTimeout(() => {
                if (mounted.current) void loadChannel();
              }, 2000);
            }
          } catch (error) {
            if (!mounted.current) return;
            setNotice({ tone: 'error', text: t('notice.failed', { message: describeError(error, t) }) });
          } finally {
            if (mounted.current) setBusy(null);
          }
        };

        const switchChannel = async (nextChannel) => {
          const data = channel.data;
          if (!data) return;
          if (nextChannel === 'qqbot' && !(data.qqbot && data.qqbot.configured)) {
            openChannelForm();
            return;
          }
          if (nextChannel === data.channel) return;
          await postChannel(nextChannel);
        };

        const saveChannelCredentials = async () => {
          const appId = channelForm.appId.trim();
          const clientSecret = channelForm.clientSecret.trim();
          const existing = channel.data && channel.data.qqbot ? channel.data.qqbot : null;
          if (!appId || (!clientSecret && !(existing && existing.secretConfigured))) {
            setNotice({ tone: 'error', text: t('error.channelEmpty') });
            return;
          }
          await postChannel(
            'qqbot',
            { appId, clientSecret, sandbox: channelForm.sandbox },
            t('notice.channelSaved'),
          );
        };

        const handlePendingUser = async (action, openid) => {
          if (pendingBusy !== null || busy !== null) return;
          setPendingBusy(action + ':' + openid);
          setNotice(null);
          try {
            const url = action === 'allow' ? CHANNEL_ALLOW_URL : CHANNEL_DENY_URL;
            const data = await callApi('POST', url, { openid });
            if (!mounted.current) return;
            setChannel({ state: 'ready', data, error: null });
            setNotice({ tone: 'success', text: action === 'allow' ? t('notice.userAllowed') : t('notice.userDenied') });
          } catch (error) {
            if (!mounted.current) return;
            setNotice({ tone: 'error', text: t('notice.failed', { message: describeError(error, t) }) });
          } finally {
            if (mounted.current) setPendingBusy(null);
          }
        };

        const toggleManual = (section, current) => {
          const isOpen = manualOpen[section] === true;
          if (!isOpen) {
            const filled = manualValues[section];
            if (!filled.provider && !filled.model && isRoute(current)) {
              setManualValues((previous) => ({ ...previous, [section]: { provider: current.provider, model: current.model } }));
            }
          }
          setManualOpen((previous) => ({ ...previous, [section]: !isOpen }));
        };

        const setManualField = (section, field, value) => {
          setManualValues((previous) => ({ ...previous, [section]: { ...previous[section], [field]: value } }));
        };

        const renderCurrent = (route, source) => {
          const tone = source === 'override' ? 'override' : source === 'config' || source === 'default' ? 'config' : 'unknown';
          const label = source === 'override'
            ? t('source.override')
            : source === 'config'
              ? t('source.config')
              : source === 'default'
                ? t('source.default')
                : t('source.unknown');
          return h('div', { className: 'cmkCurrent' },
            h('span', { className: 'cmkCurrentLabel' }, t('current.label')),
            h('span', { className: 'cmkRoute' }, routeText(route) || '—'),
            h('span', { className: 'cmkBadge', 'data-tone': tone }, label),
          );
        };

        const renderQuick = (section, current, fallback) => {
          const choices = quickChoices(catalog, current, fallback, saved);
          return h('div', { className: 'cmkQuick' },
            h('div', { className: 'cmkQuickHead' },
              h('span', { className: 'cmkQuickLabel' }, t('section.quick')),
              busy === section ? h('span', { className: 'cmkQuickBusy' }, t('quick.busy')) : null,
            ),
            choices.length === 0
              ? h('p', { className: 'cmkHint' }, t('quick.empty'))
              : h('div', { className: 'cmkChips' }, choices.map((choice) => {
                const tag = choice.tag === 'current'
                  ? t('quick.tag.current')
                  : choice.tag === 'config'
                    ? t('quick.tag.config')
                    : null;
                return h('button', {
                  type: 'button',
                  className: 'cmkChip',
                  key: choice.key,
                  'data-active': isRoute(current) && routeKey(current.provider, current.model) === choice.key ? 'true' : 'false',
                  disabled: busy !== null,
                  title: choice.provider + ' / ' + choice.model,
                  onClick: () => { void applyRoute(section, choice.provider, choice.model); },
                },
                  h('span', { className: 'cmkChipModel' }, choice.model),
                  h('span', { className: 'cmkChipProvider' }, choice.provider),
                  tag ? h('span', { className: 'cmkChipTag' }, tag) : null,
                );
              })),
          );
        };

        const renderManual = (section, current) => {
          const open = manualOpen[section] === true;
          const value = manualValues[section];
          const providerList = providerIds(catalog);
          const modelList = modelIdsFor(catalog, value.provider);
          const discoveryError = providerError(catalog, value.provider);
          return h('div', { className: 'cmkManual' },
            h('button', {
              type: 'button',
              className: 'cmkTextButton',
              onClick: () => toggleManual(section, current),
            }, open ? t('action.closeManual') : t('action.manual')),
            open ? h('div', { className: 'cmkManualBody' },
              h('div', { className: 'cmkForm' },
                h('label', { className: 'cmkField' },
                  h('span', { className: 'cmkFieldLabel' }, t('field.provider')),
                  h('input', {
                    className: 'cmkControl',
                    type: 'text',
                    value: value.provider,
                    placeholder: t('placeholder.provider'),
                    list: 'cmk-providers-' + section,
                    onChange: (event) => setManualField(section, 'provider', event.target.value),
                  }),
                ),
                h('label', { className: 'cmkField' },
                  h('span', { className: 'cmkFieldLabel' }, t('field.model')),
                  h('input', {
                    className: 'cmkControl',
                    type: 'text',
                    value: value.model,
                    placeholder: t('placeholder.model'),
                    list: 'cmk-models-' + section,
                    onChange: (event) => setManualField(section, 'model', event.target.value),
                  }),
                ),
                h('datalist', { id: 'cmk-providers-' + section }, providerList.map((provider) => h('option', { value: provider, key: provider }))),
                h('datalist', { id: 'cmk-models-' + section }, modelList.map((model) => h('option', { value: model, key: model }))),
              ),
              h('div', { className: 'cmkActions' },
                h('button', {
                  type: 'button',
                  className: 'cmkButton',
                  'data-tone': 'primary',
                  disabled: busy !== null,
                  onClick: () => { void applyRoute(section, value.provider, value.model); },
                }, t('action.apply')),
                h('button', {
                  type: 'button',
                  className: 'cmkButton',
                  disabled: busy !== null,
                  onClick: () => { void applyRoute(section, value.provider, value.model, { remember: true }); },
                }, t('action.saveApply')),
              ),
              h('p', { className: 'cmkHint' }, t('manual.hint')),
              discoveryError ? h('p', { className: 'cmkHint', 'data-tone': 'error' }, discoveryError) : null,
            ) : null,
          );
        };

        const renderChannelSection = () => {
          const data = channel.data;
          const active = data ? data.channel : null;
          const qqbot = data && data.qqbot ? data.qqbot : null;
          const options = data && Array.isArray(data.options)
            ? data.options
            : [
                { id: 'napcat', label: t('channel.napcat.label'), description: t('channel.napcat.desc'), configured: false },
                { id: 'qqbot', label: t('channel.qqbot.label'), description: t('channel.qqbot.desc'), configured: false },
              ];
          const showForm = channelForm.open || (active === 'qqbot' && qqbot && !qqbot.configured);
          const adapterState = data && data.adapter && data.adapter.state ? data.adapter.state : 'unknown';
          const adapterError = data && data.adapter && data.adapter.lastError ? data.adapter.lastError : '';
          return h('section', { className: 'cmkSection' },
            h('div', { className: 'cmkSectionHead' },
              h('div', null,
                h('h2', { className: 'cmkSectionTitle' }, t('section.channel.title')),
                h('p', { className: 'cmkSectionHint' }, t('section.channel.hint')),
              ),
            ),
            channel.state === 'error'
              ? h('p', { className: 'cmkHint', 'data-tone': 'error' }, t('channel.error', { message: channel.error }))
              : null,
            channel.state === 'loading'
              ? h('p', { className: 'cmkHint' }, t('status.loading'))
              : h('div', { className: 'cmkChannels' }, options.map((option) => {
                const optionActive = active === option.id;
                const optionLabel = t(option.id === 'qqbot' ? 'channel.qqbot.label' : 'channel.napcat.label');
                const optionDescription = t(option.id === 'qqbot' ? 'channel.qqbot.desc' : 'channel.napcat.desc');
                return h('button', {
                  type: 'button',
                  className: 'cmkChannelOption',
                  key: option.id,
                  'data-active': optionActive ? 'true' : 'false',
                  disabled: busy !== null,
                  onClick: () => { void switchChannel(option.id); },
                },
                  h('span', { className: 'cmkChannelName' }, optionLabel),
                  h('span', { className: 'cmkChannelDesc' }, optionDescription),
                  h('span', { className: 'cmkChannelMeta' },
                    optionActive
                      ? busy === 'channel' ? t('channel.switching') : t('channel.current')
                      : option.configured
                        ? t('channel.configured')
                        : t('channel.notConfigured'),
                  ),
                );
              })),
            data
              ? h('div', { className: 'cmkCurrent' },
                  h('span', { className: 'cmkCurrentLabel' }, t('channel.adapterState', { state: adapterState })),
                  qqbot && qqbot.appId ? h('span', { className: 'cmkRoute' }, `AppID ${qqbot.appId}`) : null,
                  qqbot && qqbot.sandbox ? h('span', { className: 'cmkBadge', 'data-tone': 'config' }, t('channel.sandbox')) : null,
                )
              : null,
            adapterError
              ? h('p', { className: 'cmkHint', 'data-tone': 'error' }, adapterError)
              : null,
            active === 'qqbot' && qqbot && qqbot.configured && !showForm
              ? h('div', { className: 'cmkActions' },
                  h('button', {
                    type: 'button',
                    className: 'cmkButton',
                    disabled: busy !== null,
                    onClick: openChannelForm,
                  }, t('channel.edit')),
                )
              : null,
            showForm
              ? h('div', { className: 'cmkChannelForm' },
                  h('label', { className: 'cmkField' },
                    h('span', { className: 'cmkFieldLabel' }, t('channel.appId')),
                    h('input', {
                      className: 'cmkControl',
                      type: 'text',
                      value: channelForm.appId,
                      placeholder: '例如 102012345',
                      disabled: busy !== null,
                      onChange: (event) => setChannelForm((previous) => ({ ...previous, appId: event.target.value })),
                    }),
                  ),
                  h('label', { className: 'cmkField' },
                    h('span', { className: 'cmkFieldLabel' }, t('channel.secret')),
                    h('input', {
                      className: 'cmkControl',
                      type: 'password',
                      value: channelForm.clientSecret,
                      placeholder: qqbot && qqbot.secretConfigured ? t('channel.secretSaved') : 'AppSecret',
                      disabled: busy !== null,
                      onChange: (event) => setChannelForm((previous) => ({ ...previous, clientSecret: event.target.value })),
                    }),
                  ),
                  h('label', { className: 'cmkCheckbox' },
                    h('input', {
                      type: 'checkbox',
                      checked: channelForm.sandbox === true,
                      disabled: busy !== null,
                      onChange: (event) => setChannelForm((previous) => ({ ...previous, sandbox: event.target.checked })),
                    }),
                    h('span', null, t('channel.sandbox')),
                  ),
                  h('div', { className: 'cmkActions' },
                    h('button', {
                      type: 'button',
                      className: 'cmkButton',
                      'data-tone': 'primary',
                      disabled: busy !== null,
                      onClick: () => { void saveChannelCredentials(); },
                    }, t('channel.saveConnect')),
                    active === 'qqbot' && qqbot && !qqbot.configured
                      ? null
                      : h('button', {
                          type: 'button',
                          className: 'cmkButton',
                          disabled: busy !== null,
                          onClick: () => setChannelForm((previous) => ({ ...previous, open: false })),
                        }, t('channel.cancel')),
                  ),
                )
              : null,
            active === 'qqbot'
              ? h('div', { className: 'cmkPending' },
                  h('div', { className: 'cmkQuickLabel' }, t('channel.pending.title')),
                  h('p', { className: 'cmkHint' }, t('channel.pending.desc')),
                  qqbot && Array.isArray(qqbot.allowOpenids) && qqbot.allowOpenids.length > 0
                    ? h('p', { className: 'cmkHint' },
                        t('channel.allowOpenids'),
                        qqbot.allowOpenids.map((openid) => h('span', { className: 'cmkPendingId', key: openid }, openid)).reduce((left, right) => left ? [left, ', ', right] : right, null),
                      )
                    : null,
                  qqbot && Array.isArray(qqbot.pendingUsers) && qqbot.pendingUsers.length > 0
                    ? qqbot.pendingUsers.map((user) => h('div', { className: 'cmkPendingRow', key: user.userId },
                        h('div', null,
                          h('div', { className: 'cmkPendingId' }, user.userId),
                          user.userName || user.at
                            ? h('div', { className: 'cmkHint' }, [user.userName || '', user.at || ''].filter(Boolean).join(' · '))
                            : null,
                        ),
                        h('div', { className: 'cmkActions' },
                          h('button', {
                            type: 'button',
                            className: 'cmkButton',
                            'data-tone': 'primary',
                            disabled: busy !== null || pendingBusy !== null,
                            onClick: () => { void handlePendingUser('allow', user.userId); },
                          }, t('channel.pending.allow')),
                          h('button', {
                            type: 'button',
                            className: 'cmkButton',
                            disabled: busy !== null || pendingBusy !== null,
                            onClick: () => { void handlePendingUser('deny', user.userId); },
                          }, t('channel.pending.deny')),
                        ),
                      ))
                    : h('p', { className: 'cmkHint' }, t('channel.pending.empty')),
                )
              : null,
          );
        };

        const catalogTime = catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleTimeString() : '';
        const statusLine = catalog.state === 'loading'
          ? t('status.loading')
          : catalog.state === 'error'
            ? t('status.catalogError', { message: catalog.error || t('error.generic') })
            : catalogTime
              ? t('status.updated', { time: catalogTime })
              : '';
        const qqCurrent = qq.data && qq.data.current ? qq.data.current : null;
        const qqFallback = qq.data && qq.data.fallback ? qq.data.fallback : null;
        const qqSource = qq.data ? (qq.data.override ? 'override' : 'config') : 'unknown';
        const defaultSelection = def.data && def.data.selection ? def.data.selection : null;

        return h('div', { className: 'cmkRoot' },
          h('style', null, CSS),
          h('div', { className: 'cmkInner' },
            h('div', { className: 'cmkHeader' },
              h('div', { className: 'cmkHeading' },
                h('h1', { className: 'cmkTitle' }, t('page.title')),
                h('p', { className: 'cmkSubtitle' }, t('page.subtitle')),
              ),
              h('div', { className: 'cmkActions' },
                h('button', {
                  type: 'button',
                  className: 'cmkButton',
                  disabled: busy !== null,
                  onClick: () => { void loadAll(); },
                }, t('action.refresh')),
                h('button', {
                  type: 'button',
                  className: 'cmkButton',
                  onClick: () => { context.layout.selectPanel(null); },
                }, t('action.back')),
              ),
            ),
            statusLine ? h('div', { className: 'cmkStatusLine', 'data-tone': catalog.state === 'error' ? 'error' : undefined }, statusLine) : null,
            notice ? h('div', { className: 'cmkNotice', 'data-tone': notice.tone }, notice.text) : null,
            renderChannelSection(),
            h('section', { className: 'cmkSection' },
              h('div', { className: 'cmkSectionHead' },
                h('div', null,
                  h('h2', { className: 'cmkSectionTitle' }, t('section.qq.title')),
                  h('p', { className: 'cmkSectionHint' }, t('section.qq.hint')),
                ),
              ),
              qq.state === 'error' ? h('p', { className: 'cmkHint', 'data-tone': 'error' }, t('status.qqError', { message: qq.error })) : null,
              renderCurrent(qqCurrent, qqSource),
              renderQuick('qq', qqCurrent, qqFallback),
              renderManual('qq', qqCurrent),
              h('div', { className: 'cmkActions' },
                h('button', {
                  type: 'button',
                  className: 'cmkButton',
                  disabled: busy !== null || !qq.data || !qq.data.override,
                  onClick: () => { void resetQq(); },
                }, t('action.resetQq')),
              ),
            ),
            h('section', { className: 'cmkSection' },
              h('div', { className: 'cmkSectionHead' },
                h('div', null,
                  h('h2', { className: 'cmkSectionTitle' }, t('section.default.title')),
                  h('p', { className: 'cmkSectionHint' }, t('section.default.hint')),
                ),
              ),
              def.state === 'error' ? h('p', { className: 'cmkHint', 'data-tone': 'error' }, t('status.defaultError', { message: def.error })) : null,
              renderCurrent(defaultSelection, defaultSelection ? 'default' : 'unknown'),
              renderQuick('default', defaultSelection, null),
              renderManual('default', defaultSelection),
            ),
          ),
        );
      };
    }

    /** Register the sidebar entry, its page and the locale dictionaries. */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'companion-models: dictionaries');
      const t = ctx.locale.bind(NS);
      const Page = createPage(ctx, t);
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => t('panel.title'),
        locale: NS,
      }, PanelGlyph));
      ctx.effect(() => () => {
        try {
          if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) ctx.layout.selectPanel(null);
        } catch {
          /* layout already disposed */
        }
      }, 'companion-models: release panel selection');
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply,
    };
  },
});
