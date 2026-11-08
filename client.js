// dsh-craft-anything — Client half.
//
// A "Craft Anything" panel in the sidebar rail (`sidebar.panellist`) and its page in
// the central column (`main`, keyed by the same id). The page reads live install state
// from the Host half's routes (`/craft-anything/api/status|mode|env`); it never touches
// the DOM outside its own React tree and styles itself with the Harness theme tokens.
//
// The page carries its own language switch (中文 / English, remembered in localStorage)
// and an "Environment & dependencies" card whose one-click installs are performed by the
// Host half, so a missing CLI / coding agent / Ghidra can be fixed without leaving the page.

window.__ModuleLoader__.load({
  id: 'dsh-craft-anything',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'craft-anything'
    const STATUS_ROUTE = '/craft-anything/api/status'
    const MODE_ROUTE = '/craft-anything/api/mode'
    const ENV_ROUTE = '/craft-anything/api/env'
    const BRIDGE_ROUTE = '/craft-anything/api/bridge'
    const TOKEN_ROUTE = '/craft-anything/api/token'

    // Every management route requires Authorization: Bearer <token>. The token is minted by the
    // Host half per Harness process; this page bootstraps it from a route that itself sits behind
    // the DSH connection admission, so no user input is involved. A rotated token (plugin reload)
    // shows up as one 401, which re-bootstraps and retries once.
    let tokenPromise = null
    function fetchToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(TOKEN_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`token route answered HTTP ${response.status}`))))
          .then((body) => {
            if (!body || typeof body.token !== 'string' || body.token.length < 16) throw new Error('token route returned no token')
            return body.token
          })
          .catch((error) => { tokenPromise = null; throw error })
      }
      return tokenPromise
    }
    function apiFetch(path, options = {}) {
      const request = (token) => fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(options.headers || {}), authorization: `Bearer ${token}` },
      })
      return fetchToken().then(request).then((response) => {
        if (response.status !== 401) return response
        tokenPromise = null
        return fetchToken().then(request)
      })
    }

    // The status route assembles a whole install report; the mode route only reads one file.
    // Poll the cheap one, keep the expensive one on mount + manual refresh + a slow timer.
    const MODE_REFRESH_MS = 60_000
    const STATUS_REFRESH_MS = 300_000

    // --- language --------------------------------------------------------------------------
    // A tiny module-level store: the page header and the composer chip are different React
    // roots in different slots, so they share the choice through this object instead of props.
    const LANG_KEY = 'dsh-craft-anything:lang'
    function initialLang() {
      try {
        const saved = localStorage.getItem(LANG_KEY)
        if (saved === 'zh' || saved === 'en') return saved
      } catch { /* storage may be unavailable; fall through */ }
      try {
        const nav = (navigator.language || '').toLowerCase()
        return nav.indexOf('zh') === 0 ? 'zh' : 'en'
      } catch { return 'en' }
    }
    const langStore = { lang: initialLang(), listeners: new Set() }
    function useLang() {
      const [lang, setLangState] = React.useState(langStore.lang)
      React.useEffect(() => {
        const listener = () => setLangState(langStore.lang)
        langStore.listeners.add(listener)
        return () => { langStore.listeners.delete(listener) }
      }, [])
      const setLang = React.useCallback((next) => {
        if (next !== 'zh' && next !== 'en') return
        langStore.lang = next
        try { localStorage.setItem(LANG_KEY, next) } catch { /* best effort */ }
        for (const listener of langStore.listeners) listener()
      }, [])
      return [lang, setLang]
    }

    // Copy for every string this page renders. Host-provided dependency names carry both
    // languages in the payload; everything static lives here.
    const STRINGS = {
      en: {
        pageDesc: 'See how any website, app or game works — with evidence — then have a coding agent build your own version.',
        localInstall: 'Local install',
        refresh: 'Refresh',
        checking: 'Checking…',
        checkingInstall: 'Checking the local install…',
        couldNotRead: 'Could not read the status route:',
        hostInactive: 'The Host half of the plugin may not be active. Check it in Settings → Plugins, or run the craft_status tool.',
        cli: 'CLI',
        binary: 'Binary',
        installRoot: 'Install root',
        capabilities: 'Capabilities',
        toolsets: 'toolsets',
        tools: 'tools',
        portable: 'portable',
        notInstalled: 'not installed',
        installed: 'installed',
        codingAgent: 'Coding agent',
        agentMissing: 'not found on PATH — study tools work, rebuild does not',
        ghidra: 'Ghidra',
        ghidraDetected: 'detected by the CLI',
        ghidraSet: 'set, but not detected by the CLI',
        ghidraNone: 'not configured (optional, Deep mode)',
        mcpBridge: 'MCP bridge',
        server: 'Server',
        toolPrefix: 'Tool prefix',
        mode: 'Mode',
        switching: 'switching; the tool list re-syncs when the service restarts…',
        mcpNote: 'The bridge lists the Essentials toolset (about 30 tools; deep mode adds 8 inspection tools). Enable more groups for this Harness process with mcp__craft__list_toolsets and mcp__craft__enable_toolset — native, web, Android, .NET, Apple, Electron and more.',
        workflow: 'Workflow commands',
        workflowHint: 'Run these through the craft_cli tool (or the CLI itself).',
        cleanHint: 'Clean room is the default: nothing inside the target is read. Deep mode reads code, files and page source — switch it from the mode menu here, in the composer row, or with the craft_mode tool.',
        projectsHint: 'Projects are written to Documents\\Craft Anything unless a command names --project-folder. ',
        projectDocs: 'Project documentation',
        bridgeLabel: 'Bridge',
        bridgeOn: 'On',
        bridgeOff: 'Off',
        bridgeAllow: 'Tool allowlist',
        bridgeAllowHint: 'Comma-separated globs; "*" is the only wildcard. Empty means every tool.',
        bridgeSave: 'Save',
        bridgeSaved: 'Saved; DSH re-syncs the tool list in about a second.',
        bridgeTools: 'Tools',
        bridgePresetAll: 'All tools',
        bridgePresetCore: 'Core only',
        bridgePresetInvestigation: 'Investigation',
        bridgeNote: 'Turning the bridge off, or trimming the allowlist, removes the mcp__craft__* tools from the context without restarting the Harness (the CLI keeps running; a clean/deep mode switch still restarts it).',
        bridgeChip: 'Bridge',
        envTitle: 'Environment & dependencies',
        envHint: 'Checks the local environment for this machine and installs what is missing. Checks and install commands follow the operating system.',
        envAllOk: 'Everything this plugin needs is present.',
        envFixAll: 'Install all fixable',
        envGroupCore: 'Core',
        envGroupDeep: 'Deep mode / rebuild',
        envReady: 'Ready',
        envMissing: 'Missing',
        envOptional: 'Optional',
        envInstall: 'Install',
        envInstalling: 'Installing…',
        envUpdate: 'Update',
        envCopy: 'Copy command',
        envCopied: 'Copied',
        envManual: 'Manual',
        envFailed: 'failed:',
        envRunning: 'working…',
        envChecking: 'Checking the environment…',
        envReload: 'Checking…',
        envRestartNote: 'Some installs only take effect after the plugin reloads.',
        langLabel: 'Language',
      },
      zh: {
        pageDesc: '看清任意网站、应用或游戏是怎么工作的（带证据），再让编码智能体重做一个你自己的版本。',
        localInstall: '本地安装',
        refresh: '刷新',
        checking: '检查中…',
        checkingInstall: '正在检查本地安装…',
        couldNotRead: '读取状态接口失败：',
        hostInactive: '插件的 Host 半边可能未激活。到「设置 → 插件」确认，或直接运行 craft_status 工具。',
        cli: 'CLI',
        binary: '程序路径',
        installRoot: '安装目录',
        capabilities: '能力',
        toolsets: '个工具集',
        tools: '个工具',
        portable: '便携版',
        notInstalled: '未安装',
        installed: '已安装',
        codingAgent: '编码智能体',
        agentMissing: '不在 PATH 中——研究类工具可用，rebuild 不可用',
        ghidra: 'Ghidra',
        ghidraDetected: 'CLI 已识别',
        ghidraSet: '已设置，但 CLI 未识别',
        ghidraNone: '未配置（可选，深度模式用）',
        mcpBridge: 'MCP 桥',
        server: '服务名',
        toolPrefix: '工具前缀',
        mode: '模式',
        switching: '切换中，服务重启后工具列表会刷新…',
        mcpNote: '桥默认只列 Essentials 工具集（约 30 个工具；深度模式多 8 个检查工具）。需要更多工具集时，用 mcp__craft__list_toolsets 与 mcp__craft__enable_toolset 在本进程内动态加载：native、web、Android、.NET、Apple、Electron 等。',
        workflow: '工作流命令',
        workflowHint: '通过 craft_cli 工具（或直接调 CLI）运行。',
        cleanHint: '默认是净室模式：不读取目标内部；深度模式会读取代码、文件与页面源码。可在这里的模式菜单、对话框左下角开关或 craft_mode 工具切换。',
        projectsHint: '项目默认写到「文档\\Craft Anything」，除非命令里用 --project-folder 指定。',
        projectDocs: '项目文档',
        bridgeLabel: 'MCP 桥开关',
        bridgeOn: '开',
        bridgeOff: '关',
        bridgeAllow: '工具白名单',
        bridgeAllowHint: '逗号分隔的通配符，只支持 "*"。留空=全部工具。',
        bridgeSave: '保存',
        bridgeSaved: '已保存，DSH 约 1 秒内重新同步工具列表。',
        bridgeTools: '工具',
        bridgePresetAll: '全部工具',
        bridgePresetCore: '仅核心',
        bridgePresetInvestigation: '仅调查流程',
        bridgeNote: '关闭桥或收紧白名单会把 mcp__craft__* 工具从上下文里移除，不需要重启 DSH（CLI 进程保持运行；干净/深度模式切换仍会重启 CLI）。',
        bridgeChip: '桥',
        envTitle: '环境与依赖',
        envHint: '自动检查本机环境，缺什么就一键装什么；检查项与安装命令按操作系统区分。',
        envAllOk: '本插件需要的环境都已就绪。',
        envFixAll: '一键补齐可自动项',
        envGroupCore: '核心',
        envGroupDeep: '深度模式 / 重建',
        envReady: '已就绪',
        envMissing: '缺失',
        envOptional: '可选',
        envInstall: '一键安装',
        envInstalling: '安装中…',
        envUpdate: '更新',
        envCopy: '复制命令',
        envCopied: '已复制',
        envManual: '手动',
        envFailed: '失败：',
        envRunning: '正在处理…',
        envChecking: '正在检查环境…',
        envReload: '检查中…',
        envRestartNote: '部分安装需要插件重载后才生效。',
        langLabel: '语言',
      },
    }
    function useStrings() {
      const [lang, setLang] = useLang()
      return [lang, STRINGS[lang] || STRINGS.en, setLang]
    }

    function CraftIcon(props) {
      const size = props && Number.isFinite(props.size) ? props.size : 20
      const active = Boolean(props && props.active)
      return h('svg', {
        viewBox: '0 0 64 64',
        width: size,
        height: size,
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
      h('path', {
        d: 'M32 6 54 18v28L32 58 10 46V18Z',
        fill: 'none',
        stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        strokeWidth: 4,
        strokeLinejoin: 'round',
      }),
      h('path', {
        d: 'M10 18l22 12 22-12M32 30v28',
        fill: 'none',
        stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        strokeWidth: 3.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        opacity: 0.72,
      }),
      h('circle', { cx: 48, cy: 12, r: 5, fill: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor', opacity: 0.9 }))
    }

    const css = [
      '.dsh-ca-page{box-sizing:border-box;min-height:100%;padding:28px 32px 40px;overflow:auto;color:var(--dsw-alias-label-primary);}',
      '.dsh-ca-inner{max-width:860px;margin:0 auto;}',
      '.dsh-ca-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;}',
      '.dsh-ca-head-main{flex:1;min-width:0;}',
      '.dsh-ca-head-side{flex:none;display:flex;align-items:center;gap:8px;}',
      '.dsh-ca-mark{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary);}',
      '.dsh-ca-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;}',
      '.dsh-ca-sub{margin:4px 0 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;margin-bottom:14px;}',
      '.dsh-ca-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;}',
      '.dsh-ca-card h2{margin:0;font-size:14px;font-weight:600;letter-spacing:.01em;}',
      '.dsh-ca-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;}',
      '.dsh-ca-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-btn:disabled{opacity:.5;cursor:default;}',
      '.dsh-ca-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}',
      '.dsh-ca-rows{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.55;}',
      '.dsh-ca-row{display:flex;gap:12px;align-items:baseline;}',
      '.dsh-ca-key{flex:none;width:132px;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-val{min-width:0;word-break:break-all;}',
      '.dsh-ca-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}',
      '.dsh-ca-ok{color:var(--dsw-alias-state-success-primary);}',
      '.dsh-ca-warn{color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-ca-bad{color:var(--dsw-alias-state-error-primary);}',
      '.dsh-ca-muted{color:var(--dsw-alias-state-idle-primary);}',
      '.dsh-ca-list{margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-code{display:block;margin:6px 0 0;padding:9px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;overflow-x:auto;white-space:pre;}',
      '.dsh-ca-note{margin:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-link{color:var(--dsw-alias-brand-primary);text-decoration:none;}',
      '.dsh-ca-link:hover{text-decoration:underline;}',
      '.dsh-ca-lang{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;}',
      '.dsh-ca-lang-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:6px 10px;cursor:pointer;}',
      '.dsh-ca-lang-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-lang-btn[data-active="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
      '.dsh-ca-dep{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsh-ca-dep:first-child{border-top:0;}',
      '.dsh-ca-dep-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-state-idle-primary);}',
      '.dsh-ca-dep-dot[data-state="ok"]{background:var(--dsw-alias-state-success-primary);}',
      '.dsh-ca-dep-dot[data-state="missing"]{background:var(--dsw-alias-state-warn-primary);}',
      '.dsh-ca-dep-dot[data-state="running"]{background:var(--dsw-alias-brand-primary);}',
      '.dsh-ca-dep-main{flex:1;min-width:0;}',
      '.dsh-ca-dep-name{font-size:13px;font-weight:600;line-height:1.45;}',
      '.dsh-ca-dep-hint{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-dep-detail{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);word-break:break-all;}',
      '.dsh-ca-dep-side{flex:none;display:flex;align-items:center;gap:6px;}',
      '.dsh-ca-dep-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
      '.dsh-ca-dep-status[data-state="ok"]{color:var(--dsw-alias-state-success-primary);}',
      '.dsh-ca-dep-status[data-state="missing"]{color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-ca-dep-log{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:140px;overflow:auto;}',
      '.dsh-ca-group{margin:14px 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;}',
      '.dsh-ca-group:first-child{margin-top:2px;}',
      '.dsh-ca-switch{position:relative;display:inline-flex;}',
      '.dsh-ca-switch-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);box-shadow:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;padding:5px 9px;border-radius:8px;cursor:pointer;white-space:nowrap;}',
      '.dsh-ca-switch-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-switch-btn[data-deep="true"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
      '.dsh-ca-switch-btn:disabled{opacity:.6;cursor:default;}',
      '.dsh-ca-switch-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none;}',
      '.dsh-ca-switch-btn[data-deep="true"] .dsh-ca-switch-dot{background:var(--dsw-alias-state-warn-primary);}',
      '.dsh-ca-switch-caret{font-size:9px;opacity:.7;}',
      '.dsh-ca-menu{position:fixed;z-index:2147483000;min-width:190px;padding:4px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.28);}',
      '.dsh-ca-menu-item{appearance:none;-webkit-appearance:none;display:flex;width:100%;align-items:center;gap:8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.35;text-align:left;padding:7px 8px;border-radius:7px;cursor:pointer;}',
      '.dsh-ca-menu-item:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-menu-item[data-selected="true"]{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-menu-glyph{flex:none;width:16px;text-align:center;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-menu-text{flex:1;min-width:0;}',
      '.dsh-ca-menu-sub{display:block;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-menu-check{flex:none;color:var(--dsw-alias-brand-primary);}',
    ].join('')

    function Row(props) {
      return h('div', { className: 'dsh-ca-row' },
        h('span', { className: 'dsh-ca-key' }, props.label),
        h('span', { className: 'dsh-ca-val' + (props.className ? ' ' + props.className : '') }, props.children))
    }

    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const fetchStatus = React.useCallback((force) => {
        setState((previous) => ({ phase: previous.data ? 'refreshing' : 'loading', data: previous.data }))
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller ? setTimeout(() => controller.abort(), 20_000) : null
        apiFetch(force === true ? `${STATUS_ROUTE}?full=1` : STATUS_ROUTE, { signal: controller ? controller.signal : undefined })
          .then((response) => {
            if (!response.ok) throw new Error(`status route answered HTTP ${response.status}`)
            return response.json()
          })
          .then((body) => setState({ phase: 'ready', data: body && body.status ? body.status : body }))
          .catch((error) => setState((previous) => ({ phase: 'error', data: previous.data, error: String((error && error.message) || error) })))
          .finally(() => { if (timer) clearTimeout(timer) })
      }, [])
      React.useEffect(() => {
        fetchStatus()
        const interval = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') fetchStatus()
        }, STATUS_REFRESH_MS)
        return () => clearInterval(interval)
      }, [fetchStatus])
      return { state, fetchStatus }
    }

    function StatusCard(props) {
      const { state, fetchStatus } = props
      const s = props.s
      const data = state.data || null
      const busy = state.phase === 'loading' || state.phase === 'refreshing'
      const rows = []
      if (data) {
        rows.push(h(Row, { key: 'cli', label: s.cli },
          data.installed
            ? h('span', null, h('span', { className: 'dsh-ca-ok' }, data.version || s.installed), h('span', { className: 'dsh-ca-muted' }, data.portable ? `  ${s.portable}` : ''))
            : h('span', { className: 'dsh-ca-bad' }, s.notInstalled)))
        if (data.cliPath) rows.push(h(Row, { key: 'path', label: s.binary }, h('span', { className: 'dsh-ca-mono' }, data.cliPath)))
        if (data.root) rows.push(h(Row, { key: 'root', label: s.installRoot }, h('span', { className: 'dsh-ca-mono' }, data.root)))
        if (data.capabilities) {
          const parts = []
          if (data.capabilities.toolsets !== undefined) parts.push(`${data.capabilities.toolsets} ${s.toolsets}`)
          if (data.capabilities.tools !== undefined) parts.push(`${data.capabilities.tools} ${s.tools}`)
          if (parts.length) rows.push(h(Row, { key: 'cap', label: s.capabilities }, parts.join(' · ')))
        }
        const prerequisites = data.prerequisites || {}
        rows.push(h(Row, { key: 'agent', label: s.codingAgent },
          prerequisites.codingAgent
            ? h('span', { className: 'dsh-ca-mono' }, prerequisites.codingAgent)
            : h('span', { className: 'dsh-ca-warn' }, s.agentMissing)))
        const ghidraText = prerequisites.ghidraDetected
          ? s.ghidraDetected
          : prerequisites.ghidra
            ? `${prerequisites.ghidra} (${s.ghidraSet})`
            : s.ghidraNone
        rows.push(h(Row, { key: 'ghidra', label: s.ghidra },
          h('span', { className: prerequisites.ghidraDetected ? 'dsh-ca-mono' : 'dsh-ca-muted' }, ghidraText)))
        if (Array.isArray(data.noteCodes) && data.noteCodes.length > 0) {
          const noteText = {
            'no-coding-agent': s.agentMissing,
            'bridge-version-mismatch': { en: 'The MCP bridge is running an older CLI than the host tools; it restarts into the newest one on the next mode switch.', zh: 'MCP 桥运行的 CLI 比主机工具旧；下次切换模式时会重启到最新版。' },
          }
          rows.push(h('ul', { key: 'notes', className: 'dsh-ca-list', style: { marginTop: '6px' } },
            data.noteCodes.map((code, index) => {
              const text = noteText[code]
              return h('li', { key: index }, text ? (typeof text === 'string' ? text : (text[lang0(props.lang)] || text.en)) : code)
            })))
        }
      }
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' },
          h('h2', null, s.localInstall),
          h('button', { className: 'dsh-ca-btn', type: 'button', onClick: () => fetchStatus(true), disabled: busy }, busy ? s.checking : s.refresh)),
        state.phase === 'error'
          ? h('div', { className: 'dsh-ca-rows' },
            h('div', { className: 'dsh-ca-bad' }, `${s.couldNotRead} ${state.error}`),
            h('p', { className: 'dsh-ca-note' }, s.hostInactive),
            data ? h('div', { className: 'dsh-ca-rows', style: { marginTop: '10px' } }, rows) : null)
          : state.phase === 'loading'
            ? h('div', { className: 'dsh-ca-muted' }, s.checkingInstall)
            : h('div', { className: 'dsh-ca-rows' }, rows))
    }

    function lang0(lang) { return lang === 'zh' ? 'zh' : 'en' }

    // --- analysis mode (clean room / deep) ---------------------------------------------------
    // The Host route persists the mode and the MCP launcher restarts the server so the
    // mcp__craft__ tool list re-syncs in the new mode.

    function useMode() {
      const [mode, setMode] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const refresh = React.useCallback(() => {
        apiFetch(MODE_ROUTE)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((body) => setMode(body && body.mode === 'deep' ? 'deep' : 'clean'))
          .catch(() => { /* the Host half may be inactive; keep the last known value */ })
      }, [])
      React.useEffect(() => {
        refresh()
        const interval = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh()
        }, MODE_REFRESH_MS)
        return () => clearInterval(interval)
      }, [refresh])
      const choose = React.useCallback((next) => {
        setPending(true)
        setMode(next)
        apiFetch(MODE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((body) => {
            if (body && (body.mode === 'deep' || body.mode === 'clean')) setMode(body.mode)
          })
          .catch(() => refresh())
          .finally(() => setPending(false))
      }, [refresh])
      return { mode, pending, choose }
    }

    function modeItems(lang) {
      return lang === 'zh'
        ? [
          { id: 'clean', label: '净室模式', hint: '不读取目标内部：只从外面看（默认，安全）', glyph: '◍' },
          { id: 'deep', label: '深度模式', hint: '读取目标代码、文件与页面源码（仅限私有分析）', glyph: '◈' },
        ]
        : [
          { id: 'clean', label: 'Clean room', hint: 'Reads nothing inside the target: outside view only (default, safe)', glyph: '◍' },
          { id: 'deep', label: 'Deep mode', hint: 'Reads source, files and page source (private analysis only)', glyph: '◈' },
        ]
    }

    /**
     * One dropdown control, modelled on the mode control already sitting in the composer row:
     * a compact button (dot + label + caret) that opens a small menu above itself. It never
     * depends on a fetched value to become clickable, so a late Host route cannot lock it.
     */
    function ModeSwitch(props) {
      const mode = props.mode
      const pending = Boolean(props.pending)
      const lang = props.lang || 'en'
      const items = modeItems(lang)
      const current = mode === 'deep' ? 'deep' : 'clean'
      const currentLabel = current === 'deep' ? items[1].label : items[0].label
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const buttonRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          const button = buttonRef.current
          if (button && event.target && button.contains(event.target)) return
          if (event.target && event.target.closest && event.target.closest('.dsh-ca-menu')) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointer, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onPointer, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const toggleMenu = (event) => {
        if (event) { event.preventDefault(); event.stopPropagation() }
        const button = buttonRef.current
        if (button) {
          const rect = button.getBoundingClientRect()
          const width = 230
          const left = Math.max(8, Math.min(rect.left, (window.innerWidth || 1366) - width - 8))
          setAnchor({ left, bottom: Math.max(8, (window.innerHeight || 768) - rect.top + 8) })
        }
        setOpen((value) => !value)
      }

      const pick = (id) => {
        setOpen(false)
        if (id === current) return
        props.onChoose(id)
      }

      const menu = open && anchor
        ? h('div', {
          className: 'dsh-ca-menu',
          role: 'menu',
          style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, position: 'fixed', zIndex: 2147483000, minWidth: '230px', padding: '4px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 8px 28px rgba(0,0,0,.28)' },
          'data-dsh-craft-anything': 'mode-menu',
        }, items.map((item) => h('button', {
          key: item.id,
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': item.id === current,
          'data-selected': String(item.id === current),
          className: 'dsh-ca-menu-item',
          onClick: (event) => { event.preventDefault(); pick(item.id) },
        },
        h('span', { className: 'dsh-ca-menu-glyph', 'aria-hidden': true }, item.glyph),
        h('span', { className: 'dsh-ca-menu-text' },
          item.label,
          h('span', { className: 'dsh-ca-menu-sub' }, item.hint)),
        h('span', { className: 'dsh-ca-menu-check', 'aria-hidden': true }, item.id === current ? '✓' : ''))))
        : null

      const portalHost = typeof document !== 'undefined' ? document.body : null
      let portal = null
      if (menu && portalHost) {
        try {
          const ReactDOM = require('react-dom')
          portal = ReactDOM.createPortal(menu, portalHost)
        } catch {
          portal = menu
        }
      }

      return h('span', { className: 'dsh-ca-switch', 'data-dsh-craft-anything': 'mode-switch' },
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: 'dsh-ca-switch-btn',
          'data-mode': current,
          'data-deep': String(current === 'deep'),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: lang === 'zh'
            ? `Craft Anything 分析模式：${currentLabel}（对整个 DSH 生效；切换会重启 MCP 服务）`
            : `Craft Anything analysis mode: ${currentLabel} (applies to this Harness; switching restarts the MCP service)`,
          onClick: toggleMenu,
        },
        h('span', { className: 'dsh-ca-switch-dot', 'aria-hidden': true }),
        h('span', null, pending ? (lang === 'zh' ? '切换中…' : 'Switching…') : currentLabel),
        h('span', { className: 'dsh-ca-switch-caret', 'aria-hidden': true }, '▴')),
        portal)
    }

    /** Composer control: the requested place is the left of the composer tool row. */
    function ModeChip() {
      const { mode, pending, choose } = useMode()
      const [lang] = useLang()
      // The composer slot is outside the page component, so the switch carries its own <style>
      // (the menu is portaled to document.body and needs the classes too).
      return h(React.Fragment, null,
        h('style', null, css),
        h(ModeSwitch, { mode, pending, onChoose: choose, lang }))
    }

    // --- environment & dependencies ---------------------------------------------------------
    // The Host lists platform-specific checks (CLI, coding agent, Ghidra, Java, GDB, browser)
    // and runs the one-click installs; the page polls this route while a job is running.

    function useEnv() {
      const [state, setState] = React.useState({ phase: 'loading', data: null })
      const load = React.useCallback((force) => {
        apiFetch(force === true ? ENV_ROUTE + '?full=1' : ENV_ROUTE)
          .then((response) => {
            if (!response.ok) throw new Error(`env route answered HTTP ${response.status}`)
            return response.json()
          })
          .then((body) => setState({ phase: 'ready', data: body }))
          .catch((error) => setState((previous) => ({ phase: 'error', data: previous.data, error: String((error && error.message) || error) })))
      }, [])
      React.useEffect(() => {
        load()
        const interval = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
        }, STATUS_REFRESH_MS)
        return () => clearInterval(interval)
      }, [load])
      // Poll quickly while a job is running so the card shows progress.
      const running = Boolean(state.data && Array.isArray(state.data.jobs) && state.data.jobs.some((job) => job.status === 'running'))
      React.useEffect(() => {
        if (!running) return undefined
        const interval = setInterval(load, 2500)
        return () => clearInterval(interval)
      }, [running, load])
      const action = React.useCallback((body) => apiFetch(ENV_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => response.json()).finally(load), [load])
      return { state, load, action }
    }

    function depStateText(dep, s) {
      if (dep.state === 'ok') return s.envReady
      if (dep.state === 'optional') return s.envOptional
      return s.envMissing
    }

    function EnvCard(props) {
      const { state, load, action } = props.env
      const s = props.s
      const lang = props.lang
      const data = state.data
      const jobs = (data && Array.isArray(data.jobs) ? data.jobs : []).reduce((map, job) => { map[job.id] = job; return map }, {})
      const [copied, setCopied] = React.useState(null)
      const [busyId, setBusyId] = React.useState(null)

      const copy = (dep) => {
        const command = dep.command || ''
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(command)
          else {
            const area = document.createElement('textarea')
            area.value = command
            document.body.appendChild(area)
            area.select()
            document.execCommand('copy')
            document.body.removeChild(area)
          }
        } catch { /* clipboard may be blocked; the command is visible anyway */ }
        setCopied(dep.id)
        setTimeout(() => setCopied((value) => (value === dep.id ? null : value)), 1800)
      }

      const install = (dep) => {
        setBusyId(dep.id)
        action({ action: 'install', id: dep.id }).finally(() => setBusyId(null))
      }
      const fixAll = () => { setBusyId('*'); action({ action: 'fix-all' }).finally(() => setBusyId(null)) }

      const deps = data && Array.isArray(data.checks) ? data.checks : []
      const runningNow = Object.keys(jobs).length > 0 && Object.values(jobs).some((job) => job.status === 'running')
      const wasRunning = React.useRef(false)
      React.useEffect(() => {
        if (wasRunning.current && !runningNow) props.onSettled()
        wasRunning.current = runningNow
      }, [runningNow, props])

      const fixable = deps.filter((dep) => dep.auto && dep.state !== 'ok')
      const groups = []
      for (const dep of deps) {
        const group = dep.group === 'deep' ? s.envGroupDeep : s.envGroupCore
        let bucket = groups.find((item) => item.title === group)
        if (!bucket) { bucket = { title: group, items: [] }; groups.push(bucket) }
        bucket.items.push(dep)
      }

      const renderDep = (dep) => {
        const job = jobs[dep.id]
        const running = job && job.status === 'running'
        const failed = job && job.status === 'error'
        const okNow = dep.state === 'ok'
        const label = dep.label ? (dep.label[lang] || dep.label.en) : dep.id
        const hint = dep.hint ? (dep.hint[lang] || dep.hint.en) : ''
        return h('div', { className: 'dsh-ca-dep', key: dep.id },
          h('span', { className: 'dsh-ca-dep-dot', 'data-state': running ? 'running' : (okNow ? 'ok' : 'missing') }),
          h('div', { className: 'dsh-ca-dep-main' },
            h('div', { className: 'dsh-ca-dep-name' }, label),
            hint ? h('div', { className: 'dsh-ca-dep-hint' }, hint) : null,
            dep.detail ? h('div', { className: 'dsh-ca-dep-detail' }, dep.detail) : null,
            running && job.log ? h('pre', { className: 'dsh-ca-dep-log' }, job.log.slice(-1200)) : null,
            failed ? h('pre', { className: 'dsh-ca-dep-log' }, `${s.envFailed} ${job.error || 'unknown error'}`) : null),
          h('div', { className: 'dsh-ca-dep-side' },
            h('span', { className: 'dsh-ca-dep-status', 'data-state': running ? 'missing' : (okNow ? 'ok' : 'missing') },
              running ? s.envInstalling : depStateText(dep, s)),
            okNow
              ? null
              : dep.auto
                ? h('button', {
                  className: 'dsh-ca-btn dsh-ca-btn-primary',
                  type: 'button',
                  disabled: running || busyId !== null,
                  onClick: () => install(dep),
                }, running ? s.envInstalling : (dep.state === 'ok' ? s.envUpdate : s.envInstall))
                : h('button', { className: 'dsh-ca-btn', type: 'button', onClick: () => copy(dep), disabled: !dep.command },
                  copied === dep.id ? s.envCopied : s.envCopy)))
      }

      return h('section', { className: 'dsh-ca-card', 'data-dsh-craft-anything': 'env-card' },
        h('div', { className: 'dsh-ca-card-head' },
          h('h2', null, s.envTitle),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            fixable.length > 0
              ? h('button', { className: 'dsh-ca-btn dsh-ca-btn-primary', type: 'button', disabled: busyId !== null, onClick: fixAll }, busyId === '*' ? s.envInstalling : s.envFixAll)
              : null,
            h('button', { className: 'dsh-ca-btn', type: 'button', onClick: () => load(true) }, s.refresh))),
        h('p', { className: 'dsh-ca-note', style: { marginTop: 0 } }, `${s.envHint}${data && data.platform ? ` (${data.platform})` : ''}`),
        state.phase === 'error'
          ? h('div', { className: 'dsh-ca-bad', style: { fontSize: '12px' } }, `${s.couldNotRead} ${state.error}`)
          : state.phase === 'loading' && !data
            ? h('div', { className: 'dsh-ca-muted', style: { fontSize: '12px' } }, s.envChecking)
            : deps.length === 0
              ? h('div', { className: 'dsh-ca-ok', style: { fontSize: '12px' } }, s.envAllOk)
              : groups.map((group) => h('div', { key: group.title },
                h('div', { className: 'dsh-ca-group' }, group.title),
                group.items.map(renderDep))),
        h('p', { className: 'dsh-ca-note' }, s.envRestartNote))
    }

    // --- MCP bridge on/off + allowlist -----------------------------------------------------
    // The host writes <root>/bridge.json and the MCP proxy answers tools/list from it, emitting
    // notifications/tools/list_changed. Nothing here restarts the bridge: it just re-lists.

    function useBridge() {
      const [state, setState] = React.useState({ phase: 'loading', data: null })
      const load = React.useCallback(() => {
        apiFetch(BRIDGE_ROUTE)
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`bridge route answered HTTP ${response.status}`))))
          .then((body) => setState({ phase: 'ready', data: body }))
          .catch((error) => setState((previous) => ({ phase: 'error', data: previous.data, error: String((error && error.message) || error) })))
      }, [])
      React.useEffect(() => {
        load()
        const interval = setInterval(() => {
          if (typeof document === 'undefined' || document.visibilityState === 'visible') load()
        }, 60_000)
        return () => clearInterval(interval)
      }, [load])
      const save = React.useCallback((patch) => apiFetch(BRIDGE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`bridge route answered HTTP ${response.status}`))))
        .then((body) => { setState({ phase: 'ready', data: body }); return body })
        .catch((error) => { load(); throw error }), [load])
      return { state, load, save }
    }

    function BridgeControls(props) {
      const { bridgeState, s } = props
      const data = bridgeState.state.data
      const bridge = data && data.bridge ? data.bridge : { enabled: true, allow: [] }
      const tools = data && data.tools ? data.tools : null
      const [draft, setDraft] = React.useState('')
      const [dirty, setDirty] = React.useState(false)
      const [saved, setSaved] = React.useState(false)
      React.useEffect(() => {
        if (!dirty) setDraft((bridge.allow || []).join(', '))
      }, [bridge.allow, dirty])
      const flashSaved = () => { setDirty(false); setSaved(true); setTimeout(() => setSaved(false), 2000) }
      const apply = (patch) => { bridgeState.save(patch).then(() => { flashSaved(); setTimeout(() => bridgeState.load(), 1600) }).catch(() => {}) }
      const saveAllow = () => apply({ allow: draft.split(/[,\s]+/).map((entry) => entry.trim()).filter(Boolean) })
      const presets = [
        { label: s.bridgePresetAll, allow: [] },
        { label: s.bridgePresetCore, allow: ['core_*'] },
        { label: s.bridgePresetInvestigation, allow: ['core_target_*', 'core_investigation_*', 'core_evidence_*', 'core_unknown_*', 'core_finding_*', 'core_hypothesis_*', 'core_report_*', 'core_brief_*', 'core_handoff_*'] },
      ]
      return h('div', null,
        h('div', { className: 'dsh-ca-rows', style: { marginTop: '10px' } },
          h(Row, { label: s.bridgeLabel },
            h('span', null,
              h('button', {
                className: 'dsh-ca-btn dsh-ca-btn-primary',
                type: 'button',
                'aria-pressed': bridge.enabled,
                onClick: () => apply({ enabled: !bridge.enabled }),
              }, bridge.enabled ? s.bridgeOn : s.bridgeOff),
              h('span', { className: 'dsh-ca-muted', style: { marginLeft: '8px', fontSize: '12px' } },
                tools ? `${s.bridgeTools}: ${tools.visible} / ${tools.total}` : ''))),
          h(Row, { label: s.bridgeAllow },
            h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                type: 'text',
                value: draft,
                placeholder: 'core_*, session_*',
                onChange: (event) => { setDirty(true); setDraft(event.target.value) },
                onKeyDown: (event) => { if (event.key === 'Enter') saveAllow() },
                style: { flex: '1 1 220px', minWidth: '160px', padding: '4px 8px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: '12px' },
              }),
              h('button', { className: 'dsh-ca-btn', type: 'button', onClick: saveAllow, disabled: !dirty }, s.bridgeSave)))),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
          presets.map((preset) => h('button', {
            key: preset.label,
            className: 'dsh-ca-btn',
            type: 'button',
            onClick: () => apply({ allow: preset.allow }),
          }, preset.label))),
        h('p', { className: 'dsh-ca-note' }, saved ? s.bridgeSaved : s.bridgeAllowHint))
    }

    function BridgeChip() {
      const bridgeState = useBridge()
      const [lang] = useLang()
      const s = STRINGS[lang] || STRINGS.en
      const data = bridgeState.state.data
      const bridge = data && data.bridge ? data.bridge : { enabled: true, allow: [] }
      return h(React.Fragment, null,
        h('style', null, css),
        h('button', {
          type: 'button',
          className: 'dsh-ca-switch-btn',
          'data-dsh-craft-anything': 'bridge-chip',
          'data-deep': String(!bridge.enabled),
          'aria-pressed': bridge.enabled,
          title: lang === 'zh' ? 'MCP 桥开关：关掉后 mcp__craft__* 工具从上下文移除（不重启 DSH）' : 'MCP bridge switch: off removes the mcp__craft__* tools from the context (no Harness restart)',
          onClick: () => { bridgeState.save({ enabled: !bridge.enabled }).then(() => setTimeout(() => bridgeState.load(), 1600)).catch(() => {}) },
        },
        h('span', { className: 'dsh-ca-switch-dot', 'aria-hidden': true }),
        h('span', null, `${s.bridgeChip} ${bridge.enabled ? s.bridgeOn : s.bridgeOff}`)))
    }

    // --- cards -----------------------------------------------------------------------------

    function McpCard(props) {
      const { mode, pending, choose } = props.modeState
      const s = props.s
      const lang = props.lang
      const bridgeState = props.bridgeState
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' }, h('h2', null, s.mcpBridge)),
        h('div', { className: 'dsh-ca-rows' },
          h(Row, { label: s.server }, h('span', { className: 'dsh-ca-mono' }, 'craft')),
          h(Row, { label: s.toolPrefix }, h('span', { className: 'dsh-ca-mono' }, 'mcp__craft__')),
          h(Row, { label: s.mode },
            h(ModeSwitch, { mode, pending, onChoose: choose, lang }),
            pending ? h('span', { className: 'dsh-ca-muted', style: { marginLeft: '8px', fontSize: '12px' } }, s.switching) : null)),
        h(BridgeControls, { bridgeState, s }),
        h('p', { className: 'dsh-ca-note' }, s.mcpNote),
        h('ul', { className: 'dsh-ca-list', style: { marginTop: '8px' } },
          h('li', null, 'core_target_open / core_target_triage — point it at a file, URL or app'),
          h('li', null, 'core_investigation_show, core_evidence_show — the evidence behind each answer'),
          h('li', null, 'core_report_write — save a readable report into the project folder')))
    }

    function UsageCard(props) {
      const s = props.s
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' }, h('h2', null, s.workflow)),
        h('div', { className: 'dsh-ca-rows' },
          h('div', { className: 'dsh-ca-muted', style: { fontSize: '12px' } }, s.workflowHint)),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["rebuild", "https://example.com", "Recreate this website", "--rounds", "1"] }'),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["rebuild", "-", "A snake game in Rust", "--rounds", "1"] }'),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["doctor"] }'),
        h('p', { className: 'dsh-ca-note' }, s.cleanHint),
        h('p', { className: 'dsh-ca-note' }, s.projectsHint,
          h('a', { className: 'dsh-ca-link', href: 'https://github.com/storytold/craft-anything', target: '_blank', rel: 'noreferrer' }, s.projectDocs)))
    }

    function LangSwitch(props) {
      const [lang, setLang] = props.langState
      const s = STRINGS[lang] || STRINGS.en
      const button = (id, label) => h('button', {
        key: id,
        type: 'button',
        className: 'dsh-ca-lang-btn',
        'data-active': String(lang === id),
        'aria-pressed': lang === id,
        title: s.langLabel,
        onClick: () => setLang(id),
      }, label)
      return h('div', { className: 'dsh-ca-lang', 'data-dsh-craft-anything': 'lang-switch' },
        button('zh', '中文'),
        button('en', 'English'))
    }

    function CraftPage() {
      const { state, fetchStatus } = useStatus()
      const modeState = useMode()
      const env = useEnv()
      const bridgeState = useBridge()
      const langState = useLang()
      const lang = langState[0]
      const [, s] = useStrings()
      return h('div', { className: 'dsh-ca-page', 'data-dsh-craft-anything': 'page' },
        h('style', null, css),
        h('div', { className: 'dsh-ca-inner' },
          h('header', { className: 'dsh-ca-head' },
            h('div', { className: 'dsh-ca-mark' }, h(CraftIcon, { size: 26, active: true })),
            h('div', { className: 'dsh-ca-head-main' },
              h('h1', { className: 'dsh-ca-title' }, 'Craft Anything'),
              h('p', { className: 'dsh-ca-sub' }, s.pageDesc)),
            h('div', { className: 'dsh-ca-head-side' }, h(LangSwitch, { langState }))),
          h(EnvCard, { env, s, lang, onSettled: () => fetchStatus(true) }),
          h(StatusCard, { state, fetchStatus, s, lang }),
          h(McpCard, { modeState, bridgeState, s, lang }),
          h(UsageCard, { s })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 55,
          label: () => 'Craft Anything',
        }, CraftIcon))
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, CraftPage))
        // Requested placement: the left of the composer tool row, beside the other mode chip.
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: `${PANEL_ID}/bridge`,
          order: 84,
          label: () => 'Craft Anything',
        }, BridgeChip))
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: `${PANEL_ID}/mode`,
          order: 85,
          label: () => 'Craft Anything',
        }, ModeChip))
      },
    }
  },
})
