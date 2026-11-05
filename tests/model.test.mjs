import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const M = require("../TaskbarModel.js")

// A window as Service.qml hands it to the model.
function win(address, workspaceId, extra = {}) {
  return {
    address,
    title: "t-" + address,
    appId: "app",
    workspaceId,
    workspaceName: String(workspaceId),
    monitorName: "eDP-1",
    monitorActiveWorkspaceId: 1,
    activated: false,
    urgent: false,
    hasParent: false,
    ...extra
  }
}

const ctx = (extra = {}) => ({ monitorName: "eDP-1", blocks: { "eDP-1": 0 }, allMonitors: false, activeWorkspaceNames: ["1"], ...extra })

// ---------------------------------------------------------------- settings

test("settings default when missing or malformed", () => {
  assert.deepEqual(M.normalizeSettings(undefined), { autohide: false, allMonitors: false, iconSize: 16 })
  assert.deepEqual(M.normalizeSettings([]), { autohide: false, allMonitors: false, iconSize: 16 })
  assert.deepEqual(M.normalizeSettings({ autohide: "yes", iconSize: "big" }), { autohide: false, allMonitors: false, iconSize: 16 })
  assert.equal(M.normalizeSettings({ iconSize: null }).iconSize, 16)
  assert.equal(M.normalizeSettings({ iconSize: "" }).iconSize, 16)
})

test("settings clamp icon size and accept booleans", () => {
  assert.deepEqual(M.normalizeSettings({ autohide: true, allMonitors: true, iconSize: 100 }), { autohide: true, allMonitors: true, iconSize: 24 })
  assert.equal(M.normalizeSettings({ iconSize: 2 }).iconSize, 12)
  assert.equal(M.normalizeSettings({ iconSize: 18.6 }).iconSize, 19)
})

test("settings read from this plugin's shell.json entry", () => {
  const text = JSON.stringify({ plugins: [{ id: "other", autohide: true }, { id: M.PLUGIN_ID, autohide: true, iconSize: 20 }] })
  assert.deepEqual(M.settingsFromConfig(text, M.PLUGIN_ID), { autohide: true, allMonitors: false, iconSize: 20 })
})

test("settings default when the plugin has no entry", () => {
  assert.deepEqual(M.settingsFromConfig("{}", M.PLUGIN_ID, { autohide: true, allMonitors: true, iconSize: 20 }), M.normalizeSettings({}))
})

test("a half-written shell.json keeps the previous settings", () => {
  const previous = { autohide: true, allMonitors: false, iconSize: 20 }
  assert.equal(M.settingsFromConfig('{"plugins": [', M.PLUGIN_ID, previous), previous)
  assert.equal(M.settingsFromConfig("", M.PLUGIN_ID, previous), previous)
})

// ---------------------------------------------------------------- addresses

test("addresses are normalized and validated", () => {
  assert.equal(M.normalizeAddress("0x555CA39C3810"), "0x555ca39c3810")
  assert.equal(M.normalizeAddress("555ca39c3810"), "0x555ca39c3810")
  assert.equal(M.normalizeAddress(""), "")
  assert.equal(M.normalizeAddress(null), "")
  assert.equal(M.normalizeAddress("0x12\"; rm -rf ~"), "")
  assert.equal(M.normalizeAddress("address:0x12"), "")
})

// ---------------------------------------------------------------- workspaces

test("slots number each monitor's block 1-10", () => {
  assert.equal(M.slotOf(1), 1)
  assert.equal(M.slotOf(10), 10)
  assert.equal(M.slotOf(11), 1)
  assert.equal(M.slotOf(23), 3)
  assert.equal(M.blockOf(10), 0)
  assert.equal(M.blockOf(11), 1)
})

test("monitor block state file is parsed", () => {
  assert.deepEqual(M.parseBlocks("0\teDP-1\tBOE x\n1\tHDMI-A-1\tDell y\n\ngarbage\n"), { "eDP-1": 0, "HDMI-A-1": 1 })
  assert.deepEqual(M.parseBlocks(""), {})
})

test("block falls back to the active workspace without a state file", () => {
  assert.equal(M.blockForMonitor({}, "HDMI-A-1", 14), 1)
  assert.equal(M.blockForMonitor({}, "HDMI-A-1", -1), 0)
  assert.equal(M.blockForMonitor({ "HDMI-A-1": 2 }, "HDMI-A-1", 14), 2)
})

// ---------------------------------------------------------------- rows

test("windows are grouped by workspace in workspace order, keeping Hyprland's order inside a group", () => {
  const rows = M.buildRows([win("a", 3), win("b", 1), win("c", 3), win("d", 5)], ctx())
  assert.deepEqual(rows.map(r => r.address), ["0xb", "0xa", "0xc", "0xd"])
  assert.deepEqual(rows.map(r => r.groupLabel), ["1", "3", "3", "5"])
  assert.deepEqual(rows.map(r => r.groupStart), [true, true, false, true])
})

test("the active workspace's group and the focused window are flagged", () => {
  const rows = M.buildRows([win("a", 1, { activated: true }), win("b", 2, { urgent: true })], ctx())
  assert.equal(rows[0].activeGroup, true)
  assert.equal(rows[0].focused, true)
  assert.equal(rows[1].activeGroup, false)
  assert.equal(rows[1].urgent, true)
  assert.equal(M.focusedIndex(rows), 0)
  assert.equal(M.focusedIndex([]), -1)
})

test("dialogs with a parent and invalid addresses are left out", () => {
  const rows = M.buildRows([win("a", 1), win("b", 1, { hasParent: true }), win("zz!", 1)], ctx())
  assert.deepEqual(rows.map(r => r.address), ["0xa"])
})

test("windows without an app id are kept", () => {
  const rows = M.buildRows([win("a", 1, { appId: "" })], ctx())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].appId, "")
})

test("special workspaces trail as their own groups, minimized last", () => {
  const rows = M.buildRows([
    win("f0", -99, { workspaceName: "special:minimized" }),
    win("f1", -98, { workspaceName: "special:scratchpad" }),
    win("a", 2)
  ], ctx())
  assert.deepEqual(rows.map(r => r.groupLabel), ["2", "S:scratch…", "–"])
  assert.deepEqual(rows.map(r => r.special), [false, true, true])
  assert.deepEqual(rows.map(r => r.minimized), [false, false, true])
  assert.equal(rows[1].activeGroup, false)
})

test("short special workspace names are not truncated", () => {
  const rows = M.buildRows([win("f2", -97, { workspaceName: "special:qconsole" })], ctx())
  assert.equal(rows[0].groupLabel, "S:qconsole")
})

test("each bar shows its own monitor's windows, plus every minimized window", () => {
  const windows = [
    win("a", 1),
    win("b", 11, { monitorName: "HDMI-A-1", monitorActiveWorkspaceId: 11 }),
    win("f0", -99, { workspaceName: "special:minimized", monitorName: "HDMI-A-1" })
  ]
  const blocks = { "eDP-1": 0, "HDMI-A-1": 1 }
  const laptop = M.buildRows(windows, ctx({ blocks }))
  assert.deepEqual(laptop.map(r => r.address), ["0xa", "0xf0"])
  const external = M.buildRows(windows, ctx({ monitorName: "HDMI-A-1", blocks, activeWorkspaceNames: ["11"] }))
  assert.deepEqual(external.map(r => r.address), ["0xb", "0xf0"])
  assert.equal(external[0].groupLabel, "1")
  assert.equal(external[0].activeGroup, true)
})

test("allMonitors labels other monitors' workspaces unambiguously", () => {
  const windows = [
    win("a", 1),
    win("b", 11, { monitorName: "HDMI-A-1", monitorActiveWorkspaceId: 11 })
  ]
  const rows = M.buildRows(windows, ctx({ allMonitors: true, blocks: { "eDP-1": 0, "HDMI-A-1": 1 } }))
  assert.deepEqual(rows.map(r => r.groupLabel), ["1", "1·HDMI-A-1"])
  assert.notEqual(rows[0].groupKey, rows[1].groupKey)
})

test("a guest workspace outside the monitor's block keeps its real number, after the monitor's own", () => {
  const rows = M.buildRows([win("e0", 13), win("a", 2)], ctx())
  assert.deepEqual(rows.map(r => r.groupLabel), ["2", "13"])
})

test("named workspaces keep their name", () => {
  const rows = M.buildRows([win("e1", 42, { workspaceName: "mail" })], ctx())
  assert.equal(rows[0].groupLabel, "mail")
})

test("markup-shaped titles pass through untouched (rendered as plain text)", () => {
  const title = '<img src="https://example.invalid/x"><b>hi</b> &amp;'
  const rows = M.buildRows([win("a", 1, { title })], ctx())
  assert.equal(rows[0].title, title)
})

test("rows are keyed by normalized address", () => {
  const rows = M.buildRows([win("ABC", 1)], ctx())
  assert.equal(rows[0].key, "0xabc")
})

// ---------------------------------------------------------------- dispatch

test("clicking a window focuses it by address", () => {
  const cmd = M.focusCommands({ address: "abc", minimized: false })
  assert.deepEqual(cmd.steps, [
    'hl.dsp.focus({ window = "address:0xabc" })',
    'hl.dsp.window.alter_zorder({ mode = "top", window = "address:0xabc" })'
  ])
  assert.deepEqual(cmd.after, [])
})

test("clicking a minimized window restores it to the given workspace first", () => {
  const cmd = M.focusCommands({ address: "0xabc", minimized: true }, { id: 3, name: "3" })
  assert.match(cmd.steps[1], /hl\.dsp\.window\.move\(\{ workspace = "3", window = "address:0xabc" \}\)/)
  assert.match(cmd.steps[2], /hl\.dsp\.focus/)
  assert.equal(cmd.after.length, 1)
  assert.equal(M.focusCommands({ address: "0xabc", minimized: true }, { id: -1, name: "" }), null)
  assert.equal(M.focusCommands({ address: "0xabc", minimized: true }, { id: -98, name: "special:scratchpad" }), null)
  assert.equal(M.focusCommands({ address: "0xabc", minimized: true }, 3).steps.length, 4)
})

test("invalid addresses dispatch nothing", () => {
  assert.equal(M.focusCommands({ address: "nope" }), null)
  assert.equal(M.focusCommands(null), null)
  assert.equal(M.closeCommand({ address: "0x1\"" }), null)
  assert.equal(M.closeCommand({ address: "0x1f" }), 'hl.dsp.window.close({ window = "address:0x1f" })')
})

test("workspace labels focus through Omarchy's per-monitor command when in the monitor's block", () => {
  const blocks = { "eDP-1": 0, "HDMI-A-1": 1 }
  assert.equal(M.workspaceCommand({ workspaceId: 3, monitorName: "eDP-1" }, blocks), 'o.workspaces.focus(3, "eDP-1")')
  assert.equal(M.workspaceCommand({ workspaceId: 12, monitorName: "HDMI-A-1" }, blocks), 'o.workspaces.focus(2, "HDMI-A-1")')
  assert.equal(M.workspaceCommand({ workspaceId: 13, monitorName: "eDP-1" }, blocks), 'hl.dsp.focus({ workspace = "13" })')
  assert.equal(M.workspaceCommand({ workspaceId: 3, monitorName: 'bad"name' }, blocks), 'hl.dsp.focus({ workspace = "3" })')
  assert.equal(M.workspaceCommand({ workspaceId: 3, monitorName: "eDP-1" }, {}), 'hl.dsp.focus({ workspace = "3" })')
  assert.equal(M.workspaceCommand({ special: true, workspaceId: -98 }, blocks), null)
  assert.equal(M.workspaceCommand({ workspaceId: 1.5 }, blocks), null)
})

// ---------------------------------------------------------------- icons

test("terminal apps are claimed by the entry that launched them", () => {
  const entries = [
    { id: "btop.desktop", execString: "xdg-terminal-exec --app-id=org.omarchy.btop btop", command: ["btop"], runInTerminal: false },
    { id: "nvim.desktop", execString: "nvim %F", command: ["/usr/bin/nvim"], runInTerminal: true }
  ]
  assert.equal(M.claimingEntryId("org.omarchy.btop", entries), "btop.desktop")
  assert.equal(M.claimingEntryId("org.omarchy.nvim", entries), "nvim.desktop")
  assert.equal(M.claimingEntryId("firefox", entries), "")
  assert.equal(M.claimingEntryId("", entries), "")
})

test("icon names are classified for lookup", () => {
  assert.equal(M.iconKind(""), "fallback")
  assert.equal(M.iconKind("firefox"), "theme")
  assert.equal(M.iconKind("/usr/share/icons/x.png"), "file")
  assert.equal(M.iconKind("file:///x.png"), "url")
  assert.equal(M.iconKind("image://icon/x"), "url")
})

// ---------------------------------------------------------------- hiding

test("hide states combine: hidden beats tucked beats shown", () => {
  assert.equal(M.visibility({}), "shown")
  assert.equal(M.visibility({ autohide: true }), "tucked")
  assert.equal(M.visibility({ autohide: true, revealed: true }), "shown")
  assert.equal(M.visibility({ autohide: true, revealed: true, fullscreen: true }), "hidden")
  assert.equal(M.visibility({ manuallyHidden: true, revealed: true }), "hidden")
})

test("full height is reserved while pinned, the edge strip while auto-hidden, nothing while hidden", () => {
  assert.equal(M.exclusiveZone({}, 26, 2), 26)
  assert.equal(M.exclusiveZone({ autohide: true }, 26, 2), 2)
  assert.equal(M.exclusiveZone({ autohide: true, revealed: true }, 26, 2), 2)
  // Never 0 while exclusion applies: Quickshell treats 0 as automatic sizing.
  assert.equal(M.exclusiveZone({ autohide: true }, 26, 0), 1)
  assert.equal(M.exclusiveZone({ manuallyHidden: true }, 26, 2), 0)
  assert.equal(M.exclusiveZone({ fullscreen: true, autohide: true }, 26, 2), 0)
})

test("web app windows fall back to their browser", () => {
  assert.deepEqual(M.webAppBrowserIds("brave-outlook.office.com__mail_-Default"), ["brave-browser", "brave"])
  assert.deepEqual(M.webAppBrowserIds("chrome-app.hey.com__-Profile_1"), ["chromium", "google-chrome"])
  assert.deepEqual(M.webAppBrowserIds("brave-browser"), [])
  assert.deepEqual(M.webAppBrowserIds("firefox"), [])
  assert.deepEqual(M.webAppBrowserIds(""), [])
})

// Hyprland 0.57 gives named workspaces no numeric id: they all share -1.
test("named workspaces sharing id -1 are told apart by name", () => {
  const rows = M.buildRows([
    win("a1", -1, { workspaceName: "mail" }),
    win("a2", -1, { workspaceName: "chat" }),
    win("a3", 2)
  ], ctx({ activeWorkspaceNames: ["mail"] }))
  assert.deepEqual(rows.map(r => r.groupLabel), ["2", "chat", "mail"])
  assert.deepEqual(rows.map(r => r.special), [false, false, false])
  assert.deepEqual(rows.map(r => r.groupStart), [true, true, true])
  assert.deepEqual(rows.map(r => r.activeGroup), [false, false, true])
})

test("minimized windows restore onto a named workspace by name", () => {
  const cmd = M.focusCommands({ address: "0xabc", minimized: true }, { id: -1, name: "mail" })
  assert.match(cmd.steps[1], /workspace = "name:mail"/)
  assert.equal(M.focusCommands({ address: "0xabc", minimized: true }, { id: -1, name: 'x"); os.exit(' }), null)
})

test("workspace labels of named workspaces focus by name", () => {
  assert.equal(M.workspaceCommand({ workspaceId: -1, workspaceName: "mail", monitorName: "eDP-1" }, {}), 'hl.dsp.focus({ workspace = "name:mail" })')
  assert.equal(M.workspaceCommand({ workspaceId: -1, workspaceName: 'a"b', monitorName: "eDP-1" }, {}), null)
})

test("workspace names are only accepted when safe inside a Lua string", () => {
  assert.equal(M.safeWorkspaceName("my work (2)"), "my work (2)")
  assert.equal(M.safeWorkspaceName('a"b'), "")
  assert.equal(M.safeWorkspaceName("a\\b"), "")
  assert.equal(M.safeWorkspaceName("line\nbreak"), "")
  assert.equal(M.safeWorkspaceName(""), "")
  assert.equal(M.workspaceSelector({ id: 4, name: "4" }), "4")
  assert.equal(M.workspaceSelector({ id: -98, name: "special:x" }), "")
})
