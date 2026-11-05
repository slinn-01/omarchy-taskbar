// The taskbar's state that does not need Quickshell: which windows it shows,
// in what order, under which workspace label, and what a click dispatches.
// Kept free of QML so it can be tested with node (tests/model.test.mjs).

var PLUGIN_ID = "io.github.slinn-01.taskbar"

// Each monitor owns a block of ten workspaces: 1-10, 11-20, ... (see
// $OMARCHY_PATH/default/hypr/monitor-workspaces.lua).
var SLOTS = 10

var MINIMIZED_WORKSPACE = "special:minimized"
var SPECIAL_PREFIX = "special:"

var DEFAULT_SETTINGS = { autohide: false, allMonitors: false, iconSize: 16 }
var ICON_SIZE_MIN = 12
var ICON_SIZE_MAX = 24

// ------------------------------------------------------------------ settings

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

// The plugin's entry in shell.json's plugins[] carries its settings as extra
// keys. Anything missing or malformed falls back to the default.
function normalizeSettings(raw) {
  var source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  var size = Number(source.iconSize)
  return {
    autohide: source.autohide === true,
    allMonitors: source.allMonitors === true,
    iconSize: isFinite(size) && source.iconSize !== null && source.iconSize !== "" ? Math.round(clamp(size, ICON_SIZE_MIN, ICON_SIZE_MAX)) : DEFAULT_SETTINGS.iconSize
  }
}

// Reads this plugin's settings out of shell.json text. A file caught half
// written does not parse, and keeps the settings already in effect.
function settingsFromConfig(text, pluginId, previous) {
  var fallback = previous || normalizeSettings({})
  var config
  try {
    config = JSON.parse(String(text || ""))
  } catch (e) {
    return fallback
  }
  if (!config || typeof config !== "object") return fallback
  var plugins = Array.isArray(config.plugins) ? config.plugins : []
  for (var i = 0; i < plugins.length; i++) {
    var entry = plugins[i]
    if (entry && typeof entry === "object" && entry.id === (pluginId || PLUGIN_ID)) return normalizeSettings(entry)
  }
  return normalizeSettings({})
}

// ------------------------------------------------------------------ addresses

// Hyprland addresses are hex; Quickshell may hand them over with or without
// the 0x. Anything else is refused, since it ends up inside a dispatch.
function normalizeAddress(address) {
  var value = String(address === undefined || address === null ? "" : address).trim()
  if (value.length === 0) return ""
  if (!/^0x/i.test(value)) value = "0x" + value
  return /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : ""
}

// ------------------------------------------------------------------ workspaces

function blockOf(id) {
  return Math.floor((id - 1) / SLOTS)
}

function slotOf(id) {
  return ((id - 1) % SLOTS) + 1
}

function isSpecialName(name) {
  return String(name || "").indexOf(SPECIAL_PREFIX) === 0
}

function isMinimizedName(name) {
  return String(name || "") === MINIMIZED_WORKSPACE
}

// $XDG_STATE_HOME/omarchy/monitors/workspaces: block \t connector \t identity,
// one monitor per line. Returns connector -> block.
function parseBlocks(text) {
  var blocks = {}
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var fields = lines[i].split("\t")
    if (fields.length >= 3 && fields[1] !== "") {
      var block = parseInt(fields[0], 10)
      if (isFinite(block)) blocks[fields[1]] = block
    }
  }
  return blocks
}

// The block a monitor owns: from the state file, else the block of the
// workspace it shows (the same fallback the stock Workspaces widget uses).
function blockForMonitor(blocks, monitorName, activeWorkspaceId) {
  if (blocks && blocks[monitorName] !== undefined) return blocks[monitorName]
  return activeWorkspaceId > 0 ? blockOf(activeWorkspaceId) : 0
}

// Where a workspace sorts and how it is labeled, from the point of view of
// the bar on `ctx.monitorName`. Ranks: 0 this monitor's own block, 1 a guest
// on this monitor, 2 another monitor's workspace, 3 a special workspace,
// 4 minimized.
function classifyWorkspace(ws, ctx) {
  var name = String(ws.name || "")
  var id = Number(ws.id)
  if (isMinimizedName(name)) {
    return { rank: 4, label: "–", key: "special:minimized" }
  }
  if (isSpecialName(name) || id < 0) {
    var short = name.slice(SPECIAL_PREFIX.length) || String(id)
    if (short.length > 8) short = short.slice(0, 7) + "…"
    return { rank: 3, label: "S:" + short, key: "special:" + name }
  }
  var numeric = String(id) === name || name === ""
  var onThisMonitor = ws.monitorName === ctx.monitorName
  var ownBlock = blockForMonitor(ctx.blocks, ws.monitorName, ws.monitorActiveWorkspaceId)
  var inOwnBlock = numeric && id > 0 && blockOf(id) === ownBlock
  var base = inOwnBlock ? String(slotOf(id)) : name || String(id)
  if (onThisMonitor) {
    return { rank: inOwnBlock ? 0 : 1, label: base, key: "ws:" + id }
  }
  return { rank: 2, label: base + "·" + String(ws.monitorName || "?"), key: "ws:" + id }
}

// ------------------------------------------------------------------ windows

// windows: plain objects pulled out of Hyprland.toplevels, in Hyprland's order:
//   { address, title, appId, workspaceId, workspaceName, monitorName,
//     monitorActiveWorkspaceId, activated, urgent, hasParent }
// ctx: { monitorName, blocks, allMonitors, activeWorkspaceIds: [ids] }
//
// Returns the flat list of rows the bar draws, grouped by workspace. Each row
// is keyed by window address, so the bar can update it in place.
function buildRows(windows, ctx) {
  var context = ctx || {}
  var active = context.activeWorkspaceIds || []
  var picked = []
  var list = windows || []
  for (var i = 0; i < list.length; i++) {
    var win = list[i]
    if (!win || win.hasParent) continue
    var address = normalizeAddress(win.address)
    if (!address) continue
    var wsName = String(win.workspaceName || "")
    var wsId = Number(win.workspaceId)
    if (!isFinite(wsId) || (wsId === 0 && wsName === "")) continue
    var minimized = isMinimizedName(wsName)
    // Minimized windows are listed on every bar: the taskbar is the way back
    // to them, whichever monitor they were minimized from.
    if (!context.allMonitors && !minimized && win.monitorName !== context.monitorName) continue
    var group = classifyWorkspace({
      id: wsId,
      name: wsName,
      monitorName: win.monitorName,
      monitorActiveWorkspaceId: win.monitorActiveWorkspaceId
    }, context)
    picked.push({ win: win, address: address, group: group, wsId: wsId, wsName: wsName, minimized: minimized, order: i })
  }

  picked.sort(function(a, b) {
    if (a.group.rank !== b.group.rank) return a.group.rank - b.group.rank
    if (a.group.rank === 2 && a.win.monitorName !== b.win.monitorName) return String(a.win.monitorName) < String(b.win.monitorName) ? -1 : 1
    if (a.group.rank === 3 && a.wsName !== b.wsName) return a.wsName < b.wsName ? -1 : 1
    if (a.wsId !== b.wsId) return a.wsId - b.wsId
    return a.order - b.order
  })

  var rows = []
  var lastGroup = null
  for (var j = 0; j < picked.length; j++) {
    var p = picked[j]
    var start = p.group.key !== lastGroup
    lastGroup = p.group.key
    var title = String(p.win.title || "")
    rows.push({
      key: p.address,
      address: p.address,
      title: title,
      appId: String(p.win.appId || ""),
      groupKey: p.group.key,
      groupLabel: p.group.label,
      groupStart: start,
      workspaceId: p.wsId,
      workspaceName: p.wsName,
      monitorName: String(p.win.monitorName || ""),
      special: p.group.rank >= 3,
      minimized: p.minimized,
      activeGroup: !p.minimized && p.group.rank < 3 && active.indexOf(p.wsId) >= 0,
      focused: p.win.activated === true,
      urgent: p.win.urgent === true
    })
  }
  return rows
}

// The index of the focused window's row, or -1.
function focusedIndex(rows) {
  for (var i = 0; i < (rows || []).length; i++) if (rows[i].focused) return i
  return -1
}

// ------------------------------------------------------------------ dispatch

function windowTarget(address) {
  return "window = \"address:" + address + "\""
}

// What Hyprland is asked to do when a window's icon is clicked: bring it
// forward and focus it, which switches to its workspace. A minimized window
// first moves back onto `restoreWorkspaceId`, the workspace the clicked
// bar's monitor shows. Returns { steps, after } of Lua dispatch expressions,
// or null when there is nothing safe to do.
function focusCommands(row, restoreWorkspaceId) {
  var address = normalizeAddress(row && row.address)
  if (!address) return null
  var target = windowTarget(address)
  var steps = []
  var after = []
  if (row.minimized) {
    var workspace = Number(restoreWorkspaceId)
    if (!(workspace >= 1)) return null
    steps.push("hl.dsp.window.set_prop({ prop = \"no_anim\", value = \"1\", " + target + " })")
    steps.push("hl.dsp.window.move({ workspace = \"" + Math.floor(workspace) + "\", " + target + " })")
    after.push("hl.dsp.window.set_prop({ prop = \"no_anim\", value = \"unset\", " + target + " })")
  }
  steps.push("hl.dsp.focus({ " + target + " })")
  steps.push("hl.dsp.window.alter_zorder({ mode = \"top\", " + target + " })")
  return { steps: steps, after: after }
}

function closeCommand(row) {
  var address = normalizeAddress(row && row.address)
  return address ? "hl.dsp.window.close({ " + windowTarget(address) + " })" : null
}

// Monitor connector names come from Hyprland; keep them to the characters a
// connector can have before they go into a Lua string.
function safeMonitorName(name) {
  var value = String(name || "")
  return /^[A-Za-z0-9._:-]+$/.test(value) ? value : ""
}

// What clicking a workspace label dispatches. A workspace in its monitor's
// own block goes through Omarchy's per-monitor focus, as the stock
// Workspaces widget does; any other plain workspace is focused by id.
// Special workspaces return null: the bar focuses their first window instead.
function workspaceCommand(row, blocks) {
  if (!row || row.special) return null
  var id = Number(row.workspaceId)
  if (!(id >= 1) || Math.floor(id) !== id) return null
  var monitor = safeMonitorName(row.monitorName)
  var block = blocks && blocks[row.monitorName]
  if (monitor && block !== undefined && blockOf(id) === block) {
    return "o.workspaces.focus(" + slotOf(id) + ", \"" + monitor + "\")"
  }
  return "hl.dsp.focus({ workspace = \"" + id + "\" })"
}

// ------------------------------------------------------------------ icons

// A terminal app's window carries the app id its launcher gave the terminal,
// which no desktop entry names as its class. The entry that passes that app
// id claims it, and so does a terminal entry for the command Omarchy's TUI
// launcher named it after (org.omarchy.nvim for nvim). Ported from Omarchy's
// dock (shell/plugins/dock/DockModel.js). Entries are
// { id, execString, command, runInTerminal }.
function claimingEntryId(appId, entries) {
  var id = String(appId || "")
  if (!id) return ""
  var list = entries || []
  var flag = "--app-id=" + id
  for (var i = 0; i < list.length; i++) {
    var words = String(list[i].execString || "").split(/\s+/)
    if (words.indexOf(flag) >= 0) return list[i].id
  }
  if (id.indexOf("org.omarchy.") !== 0) return ""
  var command = id.slice("org.omarchy.".length)
  for (var j = 0; j < list.length; j++) {
    var program = String((list[j].command || [])[0] || "")
    if (list[j].runInTerminal && program.slice(program.lastIndexOf("/") + 1) === command) return list[j].id
  }
  return ""
}

// A Chromium-family browser names an --app window's class after the browser
// and the page, e.g. brave-outlook.office.com__mail_-Default. When no desktop
// entry claims such a window, the browser's own icon is a better guess than
// the generic one. Returns app ids to try, best first.
var WEB_APP_BROWSERS = {
  "brave": ["brave-browser", "brave"],
  "chrome": ["chromium", "google-chrome"],
  "msedge": ["microsoft-edge"],
  "vivaldi": ["vivaldi-stable", "vivaldi"]
}

function webAppBrowserIds(appId) {
  var match = /^([a-z]+)-.+__.*-(Default|Profile_\d+)$/.exec(String(appId || ""))
  return match && WEB_APP_BROWSERS[match[1]] ? WEB_APP_BROWSERS[match[1]].slice() : []
}

// How an icon name from a desktop entry is turned into an image source:
// "url" passes through, "file" is an absolute path, "theme" is a themed name,
// and "fallback" means use the generic application icon.
function iconKind(icon) {
  var value = String(icon || "")
  if (value.length === 0) return "fallback"
  if (value.indexOf("file://") === 0 || value.indexOf("image://") === 0) return "url"
  if (value.charAt(0) === "/") return "file"
  return "theme"
}

// ------------------------------------------------------------------ hiding

// The bar on one screen is one of: "hidden" (toggled off, or a fullscreen
// window: no surface, no input), "tucked" (auto-hide, waiting at the edge),
// or "shown".
function visibility(state) {
  var s = state || {}
  if (s.manuallyHidden || s.fullscreen) return "hidden"
  if (s.autohide && !s.revealed) return "tucked"
  return "shown"
}

// Space reserved for the bar: only while it is pinned in view. Auto-hide
// overlays windows instead of pushing them around.
function exclusiveZone(state, height) {
  var s = state || {}
  return !s.manuallyHidden && !s.fullscreen && !s.autohide ? height : 0
}

if (typeof module !== "undefined") {
  module.exports = {
    PLUGIN_ID: PLUGIN_ID,
    SLOTS: SLOTS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    normalizeSettings: normalizeSettings,
    settingsFromConfig: settingsFromConfig,
    normalizeAddress: normalizeAddress,
    blockOf: blockOf,
    slotOf: slotOf,
    isSpecialName: isSpecialName,
    isMinimizedName: isMinimizedName,
    parseBlocks: parseBlocks,
    blockForMonitor: blockForMonitor,
    classifyWorkspace: classifyWorkspace,
    buildRows: buildRows,
    focusedIndex: focusedIndex,
    focusCommands: focusCommands,
    closeCommand: closeCommand,
    safeMonitorName: safeMonitorName,
    workspaceCommand: workspaceCommand,
    claimingEntryId: claimingEntryId,
    webAppBrowserIds: webAppBrowserIds,
    iconKind: iconKind,
    visibility: visibility,
    exclusiveZone: exclusiveZone
  }
}
