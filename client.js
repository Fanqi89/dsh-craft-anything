// dsh-craft-anything — Client half.
//
// A "Craft Anything" panel in the sidebar rail (`sidebar.panellist`) and its page in
// the central column (`main`, keyed by the same id). The page reads live install state
// from the Host half's route `/craft-anything/api/status`; it never touches the DOM
// outside its own React tree and styles itself with the Harness theme tokens.

window.__ModuleLoader__.load({
  id: 'dsh-craft-anything',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'craft-anything'
    const STATUS_ROUTE = '/craft-anything/api/status'
    const MODE_ROUTE = '/craft-anything/api/mode'
    // The status route assembles a whole install report; the mode route only reads one file.
    // Poll the cheap one, keep the expensive one on mount + manual refresh + a slow timer.
    const MODE_REFRESH_MS = 60_000
    const STATUS_REFRESH_MS = 300_000

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
      '.dsh-ca-mark{flex:none;width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-brand-primary);}',
      '.dsh-ca-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;}',
      '.dsh-ca-sub{margin:4px 0 0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsh-ca-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;margin-bottom:14px;}',
      '.dsh-ca-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;}',
      '.dsh-ca-card h2{margin:0;font-size:14px;font-weight:600;letter-spacing:.01em;}',
      '.dsh-ca-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer;}',
      '.dsh-ca-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.dsh-ca-btn:disabled{opacity:.5;cursor:default;}',
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

    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading' })
      const fetchStatus = React.useCallback((force) => {
        setState((previous) => ({ phase: previous.data ? 'refreshing' : 'loading', data: previous.data }))
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller ? setTimeout(() => controller.abort(), 20_000) : null
        fetch(force === true ? `${STATUS_ROUTE}?full=1` : STATUS_ROUTE, { headers: { accept: 'application/json' }, signal: controller ? controller.signal : undefined })
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

    function Row(props) {
      return h('div', { className: 'dsh-ca-row' },
        h('span', { className: 'dsh-ca-key' }, props.label),
        h('span', { className: 'dsh-ca-val' + (props.className ? ' ' + props.className : '') }, props.children))
    }

    function StatusCard(props) {
      const { state, fetchStatus } = props
      const data = state.data || null
      const busy = state.phase === 'loading' || state.phase === 'refreshing'
      const rows = []
      if (data) {
        rows.push(h(Row, { key: 'cli', label: 'CLI' },
          data.installed
            ? h('span', null, h('span', { className: 'dsh-ca-ok' }, data.version || 'installed'), h('span', { className: 'dsh-ca-muted' }, data.portable ? '  portable' : ''))
            : h('span', { className: 'dsh-ca-bad' }, 'not installed')))
        if (data.cliPath) rows.push(h(Row, { key: 'path', label: 'Binary' }, h('span', { className: 'dsh-ca-mono' }, data.cliPath)))
        if (data.root) rows.push(h(Row, { key: 'root', label: 'Install root' }, h('span', { className: 'dsh-ca-mono' }, data.root)))
        if (data.capabilities) {
          const parts = []
          if (data.capabilities.toolsets !== undefined) parts.push(`${data.capabilities.toolsets} toolsets`)
          if (data.capabilities.tools !== undefined) parts.push(`${data.capabilities.tools} tools`)
          if (parts.length) rows.push(h(Row, { key: 'cap', label: 'Capabilities' }, parts.join(' · ')))
        }
        const prerequisites = data.prerequisites || {}
        rows.push(h(Row, { key: 'agent', label: 'Coding agent' },
          prerequisites.codingAgent
            ? h('span', { className: 'dsh-ca-mono' }, prerequisites.codingAgent)
            : h('span', { className: 'dsh-ca-warn' }, 'not found on PATH — study tools work, rebuild does not')))
        const ghidraText = prerequisites.ghidraDetected
          ? 'detected by the CLI'
          : prerequisites.ghidra
            ? `${prerequisites.ghidra} (set, not detected by the CLI)`
            : 'not configured (optional, Deep mode)'
        rows.push(h(Row, { key: 'ghidra', label: 'Ghidra' },
          h('span', { className: prerequisites.ghidraDetected ? 'dsh-ca-mono' : 'dsh-ca-muted' }, ghidraText)))
        if (Array.isArray(data.notes) && data.notes.length > 0) {
          rows.push(h('ul', { key: 'notes', className: 'dsh-ca-list', style: { marginTop: '6px' } },
            data.notes.map((note, index) => h('li', { key: index }, note))))
        }
      }
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' },
          h('h2', null, 'Local install'),
          h('button', { className: 'dsh-ca-btn', type: 'button', onClick: () => fetchStatus(true), disabled: busy }, busy ? 'Checking…' : 'Refresh')),
        state.phase === 'error'
          ? h('div', { className: 'dsh-ca-rows' },
            h('div', { className: 'dsh-ca-bad' }, `Could not read the status route: ${state.error}`),
            h('p', { className: 'dsh-ca-note' }, 'The Host half of the plugin may not be active. Check the plugin in Settings → Plugins, or run the craft_status tool.'),
            data ? h('div', { className: 'dsh-ca-rows', style: { marginTop: '10px' } }, rows) : null)
          : state.phase === 'loading'
            ? h('div', { className: 'dsh-ca-muted' }, 'Checking the local install…')
            : h('div', { className: 'dsh-ca-rows' }, rows))
    }

    // --- analysis mode (clean room / deep). The Host route persists the mode and the MCP
    // launcher restarts the server so the mcp__craft__ tool list re-syncs in the new mode.

    function useMode() {
      const [mode, setMode] = React.useState(null)
      const [pending, setPending] = React.useState(false)
      const refresh = React.useCallback(() => {
        fetch(MODE_ROUTE, { headers: { accept: 'application/json' } })
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
        fetch(MODE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
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

    const MODE_ITEMS = [
      {
        id: 'clean',
        label: '净室模式',
        hint: '不读取目标内部：只从外面看（默认，安全）',
        glyph: '◍',
      },
      {
        id: 'deep',
        label: '深度模式',
        hint: '读取目标代码、文件与页面源码（仅限私有分析）',
        glyph: '◈',
      },
    ]

    /**
     * One dropdown control, modelled on the mode control already sitting in the composer row:
     * a compact button (dot + label + caret) that opens a small menu above itself. It never
     * depends on a fetched value to become clickable, so a late Host route cannot lock it.
     */
    function ModeSwitch(props) {
      const mode = props.mode
      const pending = Boolean(props.pending)
      const current = mode === 'deep' ? 'deep' : 'clean'
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
          const width = 210
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
          style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px`, position: 'fixed', zIndex: 2147483000, minWidth: '210px', padding: '4px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-overlay)', boxShadow: '0 8px 28px rgba(0,0,0,.28)' },
          'data-dsh-craft-anything': 'mode-menu',
        }, MODE_ITEMS.map((item) => h('button', {
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
          title: `Craft Anything 分析模式：${current === 'deep' ? '深度模式' : '净室模式'}（对整个 DSH 生效；切换会重启 MCP 服务）`,
          onClick: toggleMenu,
        },
        h('span', { className: 'dsh-ca-switch-dot', 'aria-hidden': true }),
        h('span', null, pending ? '切换中…' : (current === 'deep' ? '深度模式' : '净室模式')),
        h('span', { className: 'dsh-ca-switch-caret', 'aria-hidden': true }, '▴')),
        portal)
    }

    /** Composer control: the requested place is the left of the composer tool row. */
    function ModeChip() {
      const { mode, pending, choose } = useMode()
      // The composer slot is outside the page component, so the switch carries its own <style>
      // (the menu is portaled to document.body and needs the classes too).
      return h(React.Fragment, null,
        h('style', null, css),
        h(ModeSwitch, { mode, pending, onChoose: choose }))
    }

    function McpCard(props) {
      const { mode, pending, choose } = props.modeState
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' }, h('h2', null, 'MCP bridge')),
        h('div', { className: 'dsh-ca-rows' },
          h(Row, { label: 'Server' }, h('span', { className: 'dsh-ca-mono' }, 'craft')),
          h(Row, { label: 'Tool prefix' }, h('span', { className: 'dsh-ca-mono' }, 'mcp__craft__')),
          h(Row, { label: 'Mode' },
            h(ModeSwitch, { mode, pending, onChoose: choose }),
            pending ? h('span', { className: 'dsh-ca-muted', style: { marginLeft: '8px', fontSize: '12px' } }, '切换中，服务重启后工具列表会刷新…') : null)),
        h('p', { className: 'dsh-ca-note' },
          'The bridge lists the Essentials toolset (about 30 tools; deep mode adds 8 inspection tools). Enable more groups for this Harness process with mcp__craft__list_toolsets and mcp__craft__enable_toolset — native, web, Android, .NET, Apple, Electron and more.'),
        h('ul', { className: 'dsh-ca-list', style: { marginTop: '8px' } },
          h('li', null, 'core_target_open / core_target_triage — point it at a file, URL or app'),
          h('li', null, 'core_investigation_show, core_evidence_show — the evidence behind each answer'),
          h('li', null, 'core_report_write — save a readable report into the project folder')))
    }

    function UsageCard() {
      return h('section', { className: 'dsh-ca-card' },
        h('div', { className: 'dsh-ca-card-head' }, h('h2', null, 'Workflow commands')),
        h('div', { className: 'dsh-ca-rows' },
          h('div', { className: 'dsh-ca-muted', style: { fontSize: '12px' } }, 'Run these through the craft_cli tool (or the CLI itself).')),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["rebuild", "https://example.com", "Recreate this website", "--rounds", "1"] }'),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["rebuild", "-", "A snake game in Rust", "--rounds", "1"] }'),
        h('code', { className: 'dsh-ca-code' }, 'craft_cli { "args": ["doctor"] }'),
        h('p', { className: 'dsh-ca-note' },
          'Clean room is the default: nothing inside the target is read. Deep mode reads code, files and page source — switch it from the mode menu here, in the composer row, or with the craft_mode tool; a single CLI run can also take --deep.'),
        h('p', { className: 'dsh-ca-note' },
          'Projects are written to Documents\\Craft Anything unless a command names --project-folder. ',
          h('a', { className: 'dsh-ca-link', href: 'https://github.com/storytold/craft-anything', target: '_blank', rel: 'noreferrer' }, 'Project documentation')))
    }

    function CraftPage() {
      const { state, fetchStatus } = useStatus()
      const modeState = useMode()
      return h('div', { className: 'dsh-ca-page', 'data-dsh-craft-anything': 'page' },
        h('style', null, css),
        h('div', { className: 'dsh-ca-inner' },
          h('header', { className: 'dsh-ca-head' },
            h('div', { className: 'dsh-ca-mark' }, h(CraftIcon, { size: 26, active: true })),
            h('div', null,
              h('h1', { className: 'dsh-ca-title' }, 'Craft Anything'),
              h('p', { className: 'dsh-ca-sub' }, 'See how any website, app or game works — with evidence — then have a coding agent build your own version.'))),
          h(StatusCard, { state, fetchStatus }),
          h(McpCard, { modeState }),
          h(UsageCard)))
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
          id: `${PANEL_ID}/mode`,
          order: 85,
          label: () => 'Craft Anything',
        }, ModeChip))
      },
    }
  },
})
