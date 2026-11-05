import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "TaskbarModel.js" as Model

// A slim bar along the bottom of each screen listing every open window,
// grouped by workspace, so nothing gets lost on a workspace you are not
// looking at. Click an icon to jump to the window.
//
//   omarchy-shell io.github.slinn-01.taskbar toggle|show|hide|status
Item {
  id: root

  // Injected by the shell.
  property var shell: null
  property var manifest: null

  readonly property string pluginId: manifest && manifest.id ? manifest.id : Model.PLUGIN_ID

  Commons.Translations { id: catalog; directory: Qt.resolvedUrl("i18n") }
  readonly property var strings: catalog

  // ---------------------------------------------------------------- settings

  // Settings are extra keys on this plugin's entry in shell.json's plugins[].
  // Third-party services get no config object from the shell, so the file is
  // read directly; a half-written file keeps the settings already in effect.
  readonly property string configHome: Quickshell.env("XDG_CONFIG_HOME") || (Quickshell.env("HOME") + "/.config")
  property var settings: Model.normalizeSettings({})

  function readSettings(text) {
    var next = Model.settingsFromConfig(text, root.pluginId, root.settings)
    if (JSON.stringify(next) !== JSON.stringify(root.settings)) root.settings = next
  }

  FileView {
    id: settingsFile
    path: root.configHome + "/omarchy/shell.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.readSettings(text())
  }

  // The shell hands services a fresh API object when shell.json changes; take
  // that as a cue too, in case the file watch missed an atomic replace.
  onShellChanged: settingsFile.reload()

  // ---------------------------------------------------------------- monitors

  // Connector -> workspace block, as Hyprland's per-monitor workspaces keep
  // them (see default/hypr/monitor-workspaces.lua).
  property var blocks: ({})

  FileView {
    path: (Quickshell.env("XDG_STATE_HOME") || Quickshell.env("HOME") + "/.local/state") + "/omarchy/monitors/workspaces"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.blocks = Model.parseBlocks(text())
    onLoadFailed: root.blocks = ({})
  }

  // The workspace each monitor shows.
  readonly property var activeWorkspaceIds: {
    var ids = []
    var monitors = Hyprland.monitors.values
    for (var i = 0; i < monitors.length; i++) {
      if (monitors[i].activeWorkspace) ids.push(monitors[i].activeWorkspace.id)
    }
    return ids
  }

  // ---------------------------------------------------------------- windows

  // Every Hyprland window as plain data for the model.
  readonly property var windows: {
    var out = []
    var values = Hyprland.toplevels.values
    for (var i = 0; i < values.length; i++) {
      var toplevel = values[i]
      var workspace = toplevel.workspace
      var monitor = workspace && workspace.monitor ? workspace.monitor : toplevel.monitor
      var wayland = toplevel.wayland
      var ipc = toplevel.lastIpcObject
      var appId = wayland && wayland.appId ? wayland.appId : (ipc && ipc["class"] ? String(ipc["class"]) : "")
      out.push({
        address: toplevel.address,
        title: toplevel.title || (wayland ? wayland.title : ""),
        appId: appId,
        workspaceId: workspace ? workspace.id : 0,
        workspaceName: workspace ? workspace.name : "",
        monitorName: monitor ? monitor.name : "",
        monitorActiveWorkspaceId: monitor && monitor.activeWorkspace ? monitor.activeWorkspace.id : -1,
        activated: toplevel.activated,
        urgent: toplevel.urgent,
        hasParent: !!(wayland && wayland.parent)
      })
    }
    return out
  }

  // ---------------------------------------------------------------- icons

  // Entries that can claim a terminal app's window (see Model.claimingEntryId).
  readonly property var terminalEntries: {
    var values = DesktopEntries.applications.values
    var out = []
    for (var i = 0; i < values.length; i++) {
      var entry = values[i]
      if (entry.runInTerminal || String(entry.execString || "").indexOf("--app-id=") >= 0)
        out.push({ id: entry.id, execString: entry.execString, command: entry.command, runInTerminal: entry.runInTerminal })
    }
    return out
  }

  function entryForAppId(appId) {
    if (!appId) return null
    var entry = DesktopEntries.heuristicLookup(appId)
    if (entry) return entry
    var id = Model.claimingEntryId(appId, root.terminalEntries)
    return id ? DesktopEntries.byId(id) : null
  }

  readonly property string fallbackIcon: Quickshell.iconPath("application-x-executable", true)

  function iconSource(appId) {
    var entry = root.entryForAppId(appId)
    var icon = entry && entry.icon ? entry.icon : String(appId || "")
    switch (Model.iconKind(icon)) {
    case "url": return icon
    case "file": return Util.fileUrl(icon)
    case "theme":
      var themed = Quickshell.iconPath(icon, true)
      if (themed.length === 0 && icon !== icon.toLowerCase()) themed = Quickshell.iconPath(icon.toLowerCase(), true)
      return themed.length > 0 ? themed : root.fallbackIcon
    default: return root.fallbackIcon
    }
  }

  function appName(appId) {
    var entry = root.entryForAppId(appId)
    return entry && entry.name ? entry.name : String(appId || "")
  }

  // ---------------------------------------------------------------- actions

  function run(expressions, after) {
    var dispatch = function(expression) { return "hyprctl dispatch " + Util.shellQuote(expression) }
    var command = expressions.map(dispatch).join(" && ")
    if (after && after.length > 0) command += "; sleep 0.4; " + after.map(dispatch).join("; ")
    Util.execDetached(command)
  }

  // Brings a window forward and focuses it, switching to its workspace. A
  // minimized one comes back to the workspace the clicked bar's monitor shows.
  function focusWindow(row, restoreWorkspaceId) {
    var commands = Model.focusCommands(row, restoreWorkspaceId)
    if (commands) root.run(commands.steps, commands.after)
  }

  function closeWindow(row) {
    var command = Model.closeCommand(row)
    if (command) root.run([command])
  }

  function focusWorkspace(row, restoreWorkspaceId) {
    var command = Model.workspaceCommand(row, root.blocks)
    if (command) root.run([command])
    else root.focusWindow(row, restoreWorkspaceId)
  }

  // ---------------------------------------------------------------- hiding

  // Toggled over IPC, for this session only.
  property bool manuallyHidden: false

  ShellIpc {
    target: "io.github.slinn-01.taskbar"

    function toggle(): void { root.manuallyHidden = !root.manuallyHidden }
    function show(): void { root.manuallyHidden = false }
    function hide(): void { root.manuallyHidden = true }
    function status(): string { return root.manuallyHidden ? "hidden" : "shown" }
    // What each screen's bar lists, as JSON: for scripts and debugging.
    function windows(): string { return root.describe() }
  }

  function describe() {
    var bars = taskbars.instances
    var out = []
    for (var i = 0; i < bars.length; i++) {
      out.push({
        monitor: bars[i].monitorName,
        state: bars[i].visibilityState,
        rows: bars[i].rows.map(function(row) {
          return { group: row.groupLabel, title: row.title, appId: row.appId, focused: row.focused, activeGroup: row.activeGroup }
        })
      })
    }
    return JSON.stringify(out)
  }

  // ---------------------------------------------------------------- hyprland

  Connections {
    target: Hyprland
    function onRawEvent(event) {
      var name = event ? String(event.name) : ""
      // Hyprland's window list does not follow fullscreen on its own, and
      // lastIpcObject is only filled in when asked.
      if (name === "fullscreen" || name === "openwindow") {
        Hyprland.refreshToplevels()
        Hyprland.refreshWorkspaces()
      }
      // A switch is credited to the focused monitor; moving or renumbering
      // workspaces is only learned by asking.
      // The special workspace a monitor shows is only in its IPC data.
      if (name === "workspacev2" || name === "moveworkspacev2" || name === "changeworkspaceid"
        || name === "activespecial" || name === "activespecialv2") {
        Hyprland.refreshMonitors()
        Hyprland.refreshWorkspaces()
      }
    }
  }

  Component.onCompleted: {
    Hyprland.refreshToplevels()
    Hyprland.refreshWorkspaces()
    Hyprland.refreshMonitors()
  }

  Variants {
    id: taskbars
    model: Quickshell.screens

    delegate: Component {
      TaskbarWindow {
        required property var modelData

        screen: modelData
        taskbar: root
      }
    }
  }
}
