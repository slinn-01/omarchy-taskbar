import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "TaskbarModel.js" as Model

// One screen's taskbar. The surface stays mapped while hidden, parked below
// the screen edge with no input and no reserved space, so showing it again
// does not wait on a fresh layer surface.
PanelWindow {
  id: window

  property var taskbar: null

  readonly property var settings: taskbar ? taskbar.settings : Model.normalizeSettings({})
  readonly property var monitor: Hyprland.monitorFor(screen)
  readonly property string monitorName: monitor ? monitor.name : ""
  readonly property var activeWorkspace: monitor ? monitor.activeWorkspace : null
  readonly property int activeWorkspaceId: activeWorkspace ? activeWorkspace.id : -1
  // Where a minimized window comes back to: the workspace this screen shows.
  readonly property var restoreWorkspace: ({
    id: window.activeWorkspaceId,
    name: window.activeWorkspace ? window.activeWorkspace.name : ""
  })

  // ---------------------------------------------------------------- sizing

  readonly property int iconSize: settings.iconSize
  readonly property int padding: 5
  readonly property int rowHeight: iconSize + padding * 2
  readonly property int slotWidth: iconSize + 12
  readonly property int groupGap: 9

  // ---------------------------------------------------------------- hiding

  // The special workspace shown over this monitor's own, if any (Hyprland
  // only reports it in the monitor's IPC data).
  readonly property string specialWorkspaceName: {
    var ipc = monitor ? monitor.lastIpcObject : null
    var special = ipc ? ipc.specialWorkspace : null
    return special && special.name ? String(special.name) : ""
  }

  // A real fullscreen window on this screen (bit 2; 1 is maximized), on its
  // workspace or a special workspace shown over it, hides the bar, edge
  // trigger and all.
  readonly property bool fullscreen: {
    var toplevels = Hyprland.toplevels.values
    for (var i = 0; i < toplevels.length; i++) {
      var toplevel = toplevels[i]
      var workspace = toplevel ? toplevel.workspace : null
      if (!workspace) continue
      // Compared as objects: named and special workspaces can share an id.
      var shown = workspace === window.activeWorkspace
        || (window.specialWorkspaceName !== "" && workspace.name === window.specialWorkspaceName)
      if (!shown) continue
      var ipc = toplevel.lastIpcObject
      if (ipc && (Number(ipc.fullscreen) & 2) !== 0) return true
    }
    return false
  }

  property bool revealed: false
  readonly property bool manuallyHidden: taskbar ? taskbar.manuallyHidden : false
  readonly property var hideState: ({
    manuallyHidden: window.manuallyHidden,
    fullscreen: window.fullscreen,
    autohide: window.settings.autohide,
    revealed: window.revealed
  })
  readonly property string visibilityState: Model.visibility(hideState)
  readonly property bool parked: visibilityState === "hidden"

  onVisibilityStateChanged: if (visibilityState === "hidden") revealed = false

  color: "transparent"
  WlrLayershell.namespace: "omarchy-taskbar"
  WlrLayershell.layer: WlrLayer.Top
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

  // Reserves its strip while pinned in view, only the edge trigger while
  // auto-hidden. Normal exclusion keeps it clear of anything already
  // reserved at the bottom, such as the bar.
  exclusionMode: window.parked ? ExclusionMode.Ignore : ExclusionMode.Normal
  exclusiveZone: Model.exclusiveZone(hideState, rowHeight, edgeTrigger.height)

  anchors {
    bottom: true
    left: true
    right: true
  }

  implicitHeight: rowHeight
  margins.bottom: window.parked ? -rowHeight : 0

  mask: Region {
    item: window.visibilityState === "shown" ? body : null

    Region { item: window.visibilityState === "tucked" ? edgeTrigger : null }
  }

  // ---------------------------------------------------------------- rows

  readonly property var rows: Model.buildRows(taskbar ? taskbar.windows : [], {
    monitorName: window.monitorName,
    blocks: taskbar ? taskbar.blocks : ({}),
    allMonitors: window.settings.allMonitors,
    activeWorkspaceNames: taskbar ? taskbar.activeWorkspaceNames : []
  })

  // Delegates follow this model, keyed by window address, so a title or
  // focus change updates a button in place instead of rebuilding it under
  // the pointer.
  ListModel { id: rowModel }

  function sameRow(a, b) {
    for (var key in b) if (a[key] !== b[key]) return false
    return true
  }

  function syncRows() {
    var rows = window.rows
    for (var i = 0; i < rows.length; i++) {
      var key = rows[i].key
      if (i < rowModel.count && rowModel.get(i).key === key) {
        if (!window.sameRow(rowModel.get(i), rows[i])) rowModel.set(i, rows[i])
        continue
      }
      var found = -1
      for (var j = i + 1; j < rowModel.count; j++) {
        if (rowModel.get(j).key === key) { found = j; break }
      }
      if (found >= 0) {
        rowModel.move(found, i, 1)
        if (!window.sameRow(rowModel.get(i), rows[i])) rowModel.set(i, rows[i])
      } else {
        rowModel.insert(i, rows[i])
      }
    }
    if (rowModel.count > rows.length) rowModel.remove(rows.length, rowModel.count - rows.length)
    // Bring the focused window into view when focus moves, not on every
    // update, so a manual scroll is not undone by a title change.
    var focused = Model.focusedIndex(rows)
    var focusedKey = focused >= 0 ? rows[focused].key : ""
    if (focusedKey !== window.lastFocusedKey) {
      window.lastFocusedKey = focusedKey
      if (focused >= 0) Qt.callLater(function() { list.positionViewAtIndex(focused, ListView.Contain) })
    }
  }

  property string lastFocusedKey: ""

  onRowsChanged: syncRows()
  Component.onCompleted: syncRows()

  function workspaceText(row) {
    var strings = taskbar ? taskbar.strings : null
    if (!strings) return ""
    if (row.minimized) return strings.t("minimized", "Minimized")
    if (row.special) return strings.t("special", "Special workspace %1").arg(String(row.workspaceName).replace(/^special:/, ""))
    return strings.t("workspace", "Workspace %1").arg(row.groupLabel)
  }

  function tooltipFor(row) {
    var strings = taskbar ? taskbar.strings : null
    var title = row.title || (strings ? strings.t("untitled", "Untitled") : "")
    var app = taskbar ? taskbar.appName(row.appId) : row.appId
    var where = window.workspaceText(row)
    return title + "\n" + (app ? app + " · " : "") + where
  }

  // ---------------------------------------------------------------- autohide

  Timer {
    id: hideTimer
    interval: 400
    onTriggered: if (!bodyHover.hovered && !edgeHover.hovered) window.revealed = false
  }

  // The strip along the bottom edge that brings an auto-hidden bar back.
  Item {
    id: edgeTrigger
    anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
    height: 2

    HoverHandler {
      id: edgeHover
      onHoveredChanged: {
        if (hovered) window.revealed = true
        else hideTimer.restart()
      }
    }
  }

  // ---------------------------------------------------------------- body

  Rectangle {
    id: body

    width: window.width
    height: window.rowHeight
    color: Commons.Color.bar.background

    // How far the bar is tucked below its edge while auto-hidden.
    property real tuck: window.visibilityState === "tucked" ? window.rowHeight : 0
    Behavior on tuck {
      id: tuckMotion
      NumberAnimation {
        duration: Style.duration(tuckMotion.targetValue > 0 ? 120 : 180)
        easing.type: Easing.Bezier
        easing.bezierCurve: Style.easeOut
      }
    }
    y: tuck
    opacity: window.parked ? 0 : 1

    HoverHandler {
      id: bodyHover
      onHoveredChanged: if (!hovered && window.settings.autohide) hideTimer.restart()
    }

    // A hairline along the top edge, separating the bar from the windows.
    Rectangle {
      anchors { left: parent.left; right: parent.right; top: parent.top }
      height: 1
      color: Util.alpha(Commons.Color.bar.text, 0.12)
    }

    Text {
      visible: rowModel.count === 0
      anchors.verticalCenter: parent.verticalCenter
      x: Style.spacing.md * 2
      textFormat: Text.PlainText
      text: window.taskbar ? window.taskbar.strings.t("empty", "No open windows") : ""
      color: Util.alpha(Commons.Color.bar.text, 0.5)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
    }

    ListView {
      id: list

      anchors.fill: parent
      anchors.leftMargin: Style.spacing.sm
      anchors.rightMargin: Style.spacing.sm
      orientation: ListView.Horizontal
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      model: rowModel
      // Window churn reorders the strip at once; nothing to watch.
      displaced: null

      WheelHandler {
        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
        onWheel: function(event) {
          var delta = event.angleDelta.y !== 0 ? event.angleDelta.y : event.angleDelta.x
          var max = Math.max(0, list.contentWidth - list.width)
          list.contentX = Math.max(0, Math.min(max, list.contentX - delta))
        }
      }

      delegate: Item {
        id: slot

        required property int index
        required property string address
        required property string title
        required property string appId
        required property string groupKey
        required property string groupLabel
        required property bool groupStart
        required property int workspaceId
        required property string workspaceName
        required property string monitorName
        required property bool special
        required property bool minimized
        required property bool activeGroup
        required property bool focused
        required property bool urgent

        readonly property var row: ({
          address: slot.address, title: slot.title, appId: slot.appId,
          groupLabel: slot.groupLabel, workspaceId: slot.workspaceId,
          workspaceName: slot.workspaceName, monitorName: slot.monitorName,
          special: slot.special, minimized: slot.minimized
        })

        readonly property int leadGap: slot.groupStart && slot.index > 0 ? window.groupGap : 0
        width: leadGap + (slot.groupStart ? label.width : 0) + window.slotWidth
        height: list.height

        // The divider between workspace groups.
        Rectangle {
          visible: slot.leadGap > 0
          x: Math.floor(slot.leadGap / 2)
          anchors.verticalCenter: parent.verticalCenter
          width: 1
          height: Math.round(window.iconSize * 0.75)
          color: Util.alpha(Commons.Color.bar.text, 0.2)
        }

        // The active workspace's group is tinted, label and icons together.
        Rectangle {
          x: slot.leadGap
          width: slot.width - slot.leadGap
          height: parent.height - 4
          anchors.verticalCenter: parent.verticalCenter
          color: slot.activeGroup ? Style.selectedFill : "transparent"
        }

        Item {
          id: label

          visible: slot.groupStart
          x: slot.leadGap
          width: slot.groupStart ? labelText.implicitWidth + Style.spacing.md * 2 : 0
          height: parent.height

          Text {
            id: labelText
            anchors.centerIn: parent
            textFormat: Text.PlainText
            text: slot.groupLabel
            color: slot.activeGroup ? Commons.Color.bar.text : Util.alpha(Commons.Color.bar.text, 0.6)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: slot.activeGroup
          }

          MouseArea {
            id: labelMouse
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: if (window.taskbar) window.taskbar.focusWorkspace(slot.row, window.restoreWorkspace)
            onContainsMouseChanged: {
              if (containsMouse) window.showTooltip(labelMouse, window.workspaceText(slot.row))
              else window.hideTooltip(labelMouse)
            }
          }
        }

        Item {
          id: button

          x: slot.width - window.slotWidth
          width: window.slotWidth
          height: parent.height

          Rectangle {
            anchors.fill: parent
            anchors.topMargin: 2
            anchors.bottomMargin: 2
            color: iconMouse.pressed ? Style.pressedFillFor(Commons.Color.foreground, Commons.Color.accent, Commons.Color.urgent) : iconMouse.containsMouse ? Style.hoverFill : "transparent"
          }

          Image {
            id: icon
            anchors.centerIn: parent
            width: window.iconSize
            height: window.iconSize
            sourceSize: Qt.size(window.iconSize * 2, window.iconSize * 2)
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            smooth: true
            mipmap: true
            // A source that fails to load falls back to the generic icon,
            // without breaking the binding, so a later icon change still shows.
            readonly property string wanted: window.taskbar ? window.taskbar.iconSource(slot.appId) : ""
            property string failed: ""
            source: wanted !== "" && wanted === failed && window.taskbar ? window.taskbar.fallbackIcon : wanted
            opacity: slot.minimized ? 0.55 : 1
            onStatusChanged: if (status === Image.Error && String(source) === wanted) failed = wanted
          }

          // Focused window: underline. Urgent: the same mark in the urgent color.
          Rectangle {
            visible: slot.focused || slot.urgent
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 1
            width: window.iconSize
            height: 2
            radius: 1
            color: slot.urgent && !slot.focused ? Commons.Color.urgent : Commons.Color.accent
          }

          MouseArea {
            id: iconMouse
            anchors.fill: parent
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton | Qt.MiddleButton
            cursorShape: Qt.PointingHandCursor
            onClicked: function(mouse) {
              if (!window.taskbar) return
              if (mouse.button === Qt.MiddleButton) window.taskbar.closeWindow(slot.row)
              else window.taskbar.focusWindow(slot.row, window.restoreWorkspace)
            }
            onContainsMouseChanged: {
              if (containsMouse) window.showTooltip(iconMouse, window.tooltipFor(slot.row))
              else window.hideTooltip(iconMouse)
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- tooltip

  // A popup of its own: the strip is too short to hold one. The first tooltip
  // waits a moment; sliding along the bar after that shows each at once.
  property Item tooltipTarget: null
  property string tooltipText: ""
  property bool tooltipShown: false

  function showTooltip(target, text) {
    window.tooltipTarget = target
    window.tooltipText = text
    if (window.tooltipShown || tooltipWarm.running) window.tooltipShown = true
    else tooltipDelay.restart()
  }

  function hideTooltip(target) {
    if (window.tooltipTarget !== target) return
    if (window.tooltipShown) tooltipWarm.restart()
    tooltipDelay.stop()
    window.tooltipShown = false
    window.tooltipTarget = null
  }

  Timer {
    id: tooltipDelay
    interval: 400
    onTriggered: if (window.tooltipTarget) window.tooltipShown = true
  }

  Timer { id: tooltipWarm; interval: 300 }

  PopupWindow {
    id: tooltipWindow

    visible: window.tooltipShown && window.tooltipTarget !== null && window.tooltipText !== "" && window.visibilityState === "shown"
    color: "transparent"
    implicitWidth: Math.ceil(tooltipBubble.implicitWidth)
    implicitHeight: Math.ceil(tooltipBubble.implicitHeight)

    anchor {
      id: tooltipAnchor
      window: window
      adjustment: PopupAdjustment.Slide
      edges: Edges.Top | Edges.Left
      gravity: Edges.Bottom | Edges.Right
      rect.width: 1
      rect.height: 1

      onAnchoring: {
        var target = window.tooltipTarget
        if (!target) return
        var localX = target.width / 2 - tooltipWindow.implicitWidth / 2
        var localY = -tooltipWindow.implicitHeight - 6
        var point = window.contentItem.mapFromItem(target, localX, localY)
        tooltipAnchor.rect.x = Math.round(point.x)
        tooltipAnchor.rect.y = Math.round(point.y)
      }
    }

    BorderSurface {
      id: tooltipBubble
      implicitWidth: tooltipLabel.width + 20
      implicitHeight: tooltipLabel.implicitHeight + 14
      color: Commons.Color.tooltip.background
      borderSpec: Border.surfaceSpec("tooltip", "border", Commons.Color.tooltip.border, 1)
      radius: Style.cornerRadius

      Text {
        id: tooltipLabel
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: window.tooltipText
        color: Commons.Color.tooltip.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        // Long titles wrap rather than run off the screen.
        width: Math.min(implicitWidth, 480)
        wrapMode: Text.Wrap
        maximumLineCount: 4
        elide: Text.ElideRight
      }
    }
  }
}
