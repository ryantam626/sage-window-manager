import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import St from 'gi://St';

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';


const MAX_WORKSPACES = 5;
const MAX_SCREENS = 4;
const SCREEN_ORDER_KEY = 'screen-order';
const WINDOW_SKIP_TYPES = [
    Meta.WindowType.DESKTOP,
    Meta.WindowType.DOCK,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.DROPDOWN_MENU,
    Meta.WindowType.POPUP_MENU,
    Meta.WindowType.TOOLTIP,
    Meta.WindowType.NOTIFICATION,
    Meta.WindowType.COMBO,
    Meta.WindowType.DND,
    Meta.WindowType.OVERRIDE_OTHER,
];
const FOCUS_BORDER_HOLD_MS = 450;
const FOCUS_BORDER_FADE_MS = 180;


/**
 * @param {import('@girs/meta-12').Meta.Window} window
 * @param allowHidden
 * @returns {boolean}
 */
function _shouldManageWindow(window, {allowHidden = false} = {}) {
    if (!window) return false;

    const windowType = window.get_window_type();

    return (
        !WINDOW_SKIP_TYPES.includes(windowType) &&
        !window.is_skip_taskbar() &&
        window.get_title() !== '' &&
        (allowHidden || !window.is_hidden())
    );
}


/**
 * Get window that's eligible to be managed.
 * @param workspace - Mutter workspace
 * @param monitor - Mutter monitor (nullable)
 * @returns {*} Windows
 */
function _getEligibleWindows(workspace, monitor) {
    return _listManageableWindows(workspace, monitor, {
        allowHidden: false,
        allowMinimized: false,
        requireVisibleOnWorkspace: true,
    });
}


function _sortByMostRecent(windows) {
    return windows.sort((a, b) => b.get_stable_sequence() - a.get_stable_sequence());
}


/**
 * @param workspace - Mutter workspace
 * @param monitor - Mutter monitor (nullable)
 * @param {{allowHidden?: boolean, allowMinimized?: boolean, requireVisibleOnWorkspace?: boolean}} options
 * @returns {*} Windows
 */
function _listManageableWindows(
    workspace,
    monitor,
    {
        allowHidden = false,
        allowMinimized = true,
        requireVisibleOnWorkspace = false,
    } = {}
) {
    return _sortByMostRecent(workspace.list_windows().filter(window => {
        if (monitor != null && window.get_monitor() !== monitor) {
            return false;
        }

        if (!_shouldManageWindow(window, {allowHidden})) {
            return false;
        }

        if (!allowMinimized && window.minimized) {
            return false;
        }

        if (requireVisibleOnWorkspace && !window.showing_on_its_workspace()) {
            return false;
        }

        return true;
    }));
}


class SimpleWindowCycler {
    constructor() {
        this._focusBorderActor = null;
        this._focusBorderTimeoutId = null;
    }

    enable() {
        console.log('Simple Window Cycler: enabled');
    }

    disable() {
        this._clearFocusBorder();
        console.log('Simple Window Cycler: disabled');
    }

    cycleForward() {
        this._cycleWindows('forward');
    }

    cycleBackward() {
        this._cycleWindows('backward');
    }

    _cycleWindows(direction) {
        const focusedWindow = global.display.get_focus_window();
        const currentMonitor = focusedWindow ? focusedWindow.get_monitor() : global.display.get_current_monitor();
        const currentWorkspace = global.workspace_manager.get_active_workspace();

        // Get all windows on current workspace and monitor
        const windows = _getEligibleWindows(currentWorkspace, currentMonitor);

        if (windows.length === 0) {
            console.log('Not enough windows to cycle');
            return;
        }

        // Find currently focused window
        let currentIndex = windows.findIndex(w => w === focusedWindow);

        // Calculate next window index
        let nextIndex;
        if (currentIndex === -1) {
            nextIndex = direction === 'forward' ? 0 : windows.length - 1;
        } else if (direction === 'forward') {
            nextIndex = (currentIndex + 1) % windows.length;
        } else {
            nextIndex = (currentIndex - 1 + windows.length) % windows.length;
        }

        // Focus the next window
        const nextWindow = windows[nextIndex];
        this._focusWindow(nextWindow);

        console.log(`Cycled ${direction}: ${nextWindow.get_title()}`);
    }

    _focusWindow(window) {
        const timestamp = global.get_current_time();

        // Ensure window is on current workspace
        const currentWorkspace = global.workspace_manager.get_active_workspace();
        if (window.get_workspace() !== currentWorkspace) {
            window.change_workspace(currentWorkspace);
        }

        // Unminimize if needed
        if (window.minimized) {
            window.unminimize();
        }

        // Activate is more reliable than plain focus/raise when a window is
        // transiently hidden during workspace transition animations.
        window.activate(timestamp);
        this._showFocusBorder(window);
    }

    focusWindow(window) {
        this._focusWindow(window);
    }

    flashFocusBorder(window) {
        if (!_shouldManageWindow(window, {allowHidden: true})) {
            return false;
        }

        this._showFocusBorder(window);
        return true;
    }

    _showFocusBorder(window) {
        const rect = window.get_frame_rect();

        if (!this._focusBorderActor) {
            this._focusBorderActor = new St.Widget({
                style_class: 'sage-focus-border',
                reactive: false,
                can_focus: false,
            });
            Main.uiGroup.add_child(this._focusBorderActor);
        }

        this._focusBorderActor.remove_all_transitions();
        this._focusBorderActor.set_position(rect.x, rect.y);
        this._focusBorderActor.set_size(rect.width, rect.height);
        this._focusBorderActor.opacity = 255;
        this._focusBorderActor.show();

        if (this._focusBorderTimeoutId) {
            GLib.source_remove(this._focusBorderTimeoutId);
            this._focusBorderTimeoutId = null;
        }

        this._focusBorderTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FOCUS_BORDER_HOLD_MS, () => {
            this._focusBorderTimeoutId = null;

            if (!this._focusBorderActor) {
                return GLib.SOURCE_REMOVE;
            }

            this._focusBorderActor.ease({
                opacity: 0,
                duration: FOCUS_BORDER_FADE_MS,
                onComplete: () => {
                    if (this._focusBorderActor) {
                        this._focusBorderActor.hide();
                    }
                },
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _clearFocusBorder() {
        if (this._focusBorderTimeoutId) {
            GLib.source_remove(this._focusBorderTimeoutId);
            this._focusBorderTimeoutId = null;
        }

        if (this._focusBorderActor) {
            this._focusBorderActor.remove_all_transitions();
            this._focusBorderActor.destroy();
            this._focusBorderActor = null;
        }
    }
}


class WindowWorkspaceMover {
    constructor() {
        console.log('WindowWorkspaceMover: initialized');
    }

    enable() {
        console.log('WindowWorkspaceMover: enabled');
    }

    disable() {
        console.log('WindowWorkspaceMover: disabled');
    }

    /**
     * Move the focused window to a specific workspace without switching to it
     * @param {number} workspaceIndex - Zero-based workspace index
     * @returns {boolean} - True if successful, false otherwise
     */
    moveToWorkspace(workspaceIndex) {
        const focusedWindow = global.display.get_focus_window();

        if (!focusedWindow) {
            console.log('No focused window to move');
            return false;
        }

        if (!_shouldManageWindow(focusedWindow)) {
            console.log('Window is not manageable');
            return false;
        }

        const workspaceManager = global.workspace_manager;
        const targetWorkspace = workspaceManager.get_workspace_by_index(workspaceIndex);

        if (!targetWorkspace) {
            console.log(`Invalid workspace index: ${workspaceIndex}`);
            return false;
        }

        // Check if window is already on target workspace
        if (focusedWindow.get_workspace() === targetWorkspace) {
            console.log('Window is already on target workspace');
            return false;
        }

        // Move window without switching workspace
        focusedWindow.change_workspace(targetWorkspace);

        // Critical: Do NOT call targetWorkspace.activate() or activate_with_focus()
        // This keeps the user on the current workspace

        console.log(`Moved "${focusedWindow.get_title()}" to workspace ${workspaceIndex + 1}`);
        return true;
    }
}


class WindowScreenManager {
    constructor(windowCycler, settings) {
        this._windowCycler = windowCycler;
        this._settings = settings;
    }

    /**
     * Get manageable windows on a monitor without minimized/showing restrictions.
     * @param workspace - Mutter workspace
     * @param monitor - Mutter monitor
     * @param {{allowHidden?: boolean}} options
     * @returns {*} Windows
     */
    _getMonitorWindows(workspace, monitor, {allowHidden = false} = {}) {
        return _listManageableWindows(workspace, monitor, {
            allowHidden,
            allowMinimized: true,
            requireVisibleOnWorkspace: false,
        });
    }

    /**
     * Resolve the most recently active manageable window on a monitor.
     * @param workspace - Mutter workspace
     * @param monitor - Mutter monitor
     * @param {{allowHidden?: boolean, allowMinimized?: boolean, requireVisibleOnWorkspace?: boolean}} options
     * @returns {import('@girs/meta-12').Meta.Window | null}
     */
    _getLastActiveWindow(workspace, monitor, {
        allowHidden = false,
        allowMinimized = true,
        requireVisibleOnWorkspace = false,
    } = {}) {
        const tabList = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);

        return tabList.find(window => {
            if (window.get_monitor() !== monitor) {
                return false;
            }

            if (!_shouldManageWindow(window, {allowHidden})) {
                return false;
            }

            if (!allowMinimized && window.minimized) {
                return false;
            }

            if (requireVisibleOnWorkspace && !window.showing_on_its_workspace()) {
                return false;
            }

            return true;
        }) ?? null;
    }

    /**
     * Resolve a logical screen index (keybinding order) into a physical monitor index.
     * @param {number} screenIndex - Zero-based logical screen index.
     * @returns {number}
     */
    _getPhysicalMonitorIndex(screenIndex) {
        const monitorCount = global.display.get_n_monitors();

        if (screenIndex < 0 || screenIndex >= monitorCount) {
            return -1;
        }

        const configuredOrder = this._settings.get_value(SCREEN_ORDER_KEY).deep_unpack();
        const configuredMonitor = configuredOrder[screenIndex];

        if (!Number.isInteger(configuredMonitor)) {
            return screenIndex;
        }

        if (configuredMonitor < 0 || configuredMonitor >= monitorCount) {
            console.log(`Configured monitor index out of range for logical screen ${screenIndex + 1}: ${configuredMonitor}`);
            return screenIndex;
        }

        return configuredMonitor;
    }

    /**
     * Move the focused window to a specific monitor.
     * @param {number} monitorIndex - Zero-based monitor index.
     * @returns {boolean}
     */
    sendWindowToScreen(monitorIndex) {
        const focusedWindow = global.display.get_focus_window();

        if (!focusedWindow) {
            console.log('No focused window to move to screen');
            return false;
        }

        if (!_shouldManageWindow(focusedWindow)) {
            console.log('Focused window is not manageable');
            return false;
        }

        const targetMonitor = this._getPhysicalMonitorIndex(monitorIndex);
        if (targetMonitor === -1) {
            console.log(`Invalid logical screen index: ${monitorIndex}`);
            return false;
        }

        if (focusedWindow.get_monitor() === targetMonitor) {
            console.log('Window is already on target screen');
            return false;
        }

        focusedWindow.move_to_monitor(targetMonitor);
        console.log(`Moved "${focusedWindow.get_title()}" to screen ${monitorIndex + 1} (monitor ${targetMonitor + 1})`);
        return true;
    }

    /**
     * Move focus to a specific monitor by focusing the most recent window there.
     * @param {number} monitorIndex - Zero-based monitor index.
     * @returns {boolean}
     */
    focusScreen(monitorIndex) {
        const targetMonitor = this._getPhysicalMonitorIndex(monitorIndex);
        if (targetMonitor === -1) {
            console.log(`Invalid logical screen index: ${monitorIndex}`);
            return false;
        }

        const currentWorkspace = global.workspace_manager.get_active_workspace();
        let windows = _getEligibleWindows(currentWorkspace, targetMonitor);
        let windowQueryOptions = {
            allowHidden: false,
            allowMinimized: false,
            requireVisibleOnWorkspace: true,
        };

        if (windows.length === 0) {
            windows = this._getMonitorWindows(currentWorkspace, targetMonitor);
            windowQueryOptions = {
                allowHidden: false,
                allowMinimized: true,
                requireVisibleOnWorkspace: false,
            };
        }

        // During very fast workspace transitions GNOME may report monitor windows as
        // temporarily hidden; include them as a fallback so focus can still recover.
        if (windows.length === 0) {
            windows = this._getMonitorWindows(currentWorkspace, targetMonitor, {allowHidden: true});
            windowQueryOptions = {
                allowHidden: true,
                allowMinimized: true,
                requireVisibleOnWorkspace: false,
            };
        }

        if (windows.length === 0) {
            console.log(`No manageable windows on screen ${monitorIndex + 1} (monitor ${targetMonitor + 1})`);
            return false;
        }

        const lastActiveWindow = this._getLastActiveWindow(currentWorkspace, targetMonitor, windowQueryOptions) ?? windows[0];

        this._windowCycler.focusWindow(lastActiveWindow);
        console.log(`Focused screen ${monitorIndex + 1} (monitor ${targetMonitor + 1})`);
        return true;
    }
}


export default class SageWindowManagerExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
        this._windowCycler = null;
        this._windowMover = null;
        this._screenManager = null;
        this._originalDisplay = null;
        this._keybindingNames = [];
        this._workspaceChangedSignalId = null;
        this._workspaceFocusIdleId = null;
        this._workspaceFocusRequestSerial = 0;
    }

    enable() {
        console.log('Sage Window Manager Extension: enabled');
        this._settings = this.getSettings();
        this._windowCycler = new SimpleWindowCycler();
        this._windowMover = new WindowWorkspaceMover();
        this._screenManager = new WindowScreenManager(this._windowCycler, this._settings);
        this._windowCycler.enable();
        this._windowMover.enable();
        this._addKeybindings();
        this._disableWorkspaceSwitcherPopup();
        this._workspaceChangedSignalId = global.workspace_manager.connect(
            'active-workspace-changed',
            this._onActiveWorkspaceChanged.bind(this)
        );
    }

    disable() {
        console.log('Sage Window Manager Extension: disabled');
        if (this._windowCycler) {
            this._windowCycler.disable();
            this._windowCycler = null;
        }
        if (this._windowMover) {
            this._windowMover.disable();
            this._windowMover = null;
        }
        this._screenManager = null;
        this._settings = null;
        if (this._workspaceChangedSignalId) {
            global.workspace_manager.disconnect(this._workspaceChangedSignalId);
            this._workspaceChangedSignalId = null;
        }
        if (this._workspaceFocusIdleId) {
            GLib.source_remove(this._workspaceFocusIdleId);
            this._workspaceFocusIdleId = null;
        }
        this._workspaceFocusRequestSerial++;
        this._removeKeybindings();
        this._restoreWorkspaceSwitcherPopup();
    }

    _onActiveWorkspaceChanged() {
        this._workspaceFocusRequestSerial++;
        const requestSerial = this._workspaceFocusRequestSerial;
        const workspaceIndex = global.workspace_manager.get_active_workspace_index();

        if (this._workspaceFocusIdleId) {
            GLib.source_remove(this._workspaceFocusIdleId);
            this._workspaceFocusIdleId = null;
        }

        let sourceId = 0;
        sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._workspaceFocusIdleId === sourceId) {
                this._workspaceFocusIdleId = null;
            }

            if (requestSerial !== this._workspaceFocusRequestSerial) {
                return GLib.SOURCE_REMOVE;
            }

            if (workspaceIndex !== global.workspace_manager.get_active_workspace_index()) {
                return GLib.SOURCE_REMOVE;
            }

            const focusedTargetScreen = this.focusScreen(0);
            if (!focusedTargetScreen) {
                const focusedWindow = global.display.get_focus_window();
                if (this._windowCycler) {
                    this._windowCycler.flashFocusBorder(focusedWindow);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
        this._workspaceFocusIdleId = sourceId;
    }

    // Exposed methods for external binding
    cycleWindowsForward() {
        if (this._windowCycler) {
            this._windowCycler.cycleForward();
        }
    }

    cycleWindowsBackward() {
        if (this._windowCycler) {
            this._windowCycler.cycleBackward();
        }
    }

    moveToWorkspace(index) {
        if (this._windowMover) {
            return this._windowMover.moveToWorkspace(index);
        }

        return false;
    }

    sendWindowToScreen(index) {
        if (this._screenManager) {
            return this._screenManager.sendWindowToScreen(index);
        }

        return false;
    }

    focusScreen(index) {
        if (this._screenManager) {
            return this._screenManager.focusScreen(index);
        }

        return false;
    }

    _addKeybindings() {
        this._addKeybinding(
            'sage-cycle-windows-forward',
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.cycleWindowsForward.bind(this),
        );

        this._addKeybinding(
            'sage-cycle-windows-backward',
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.cycleWindowsBackward.bind(this),
        );

        for (let i = 0; i < MAX_WORKSPACES; i++) {
            const keybindingName = `sage-move-to-workspace-${i + 1}`;
            this._addKeybinding(
                keybindingName,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this.moveToWorkspace(i)
            );
        }

        for (let i = 0; i < MAX_SCREENS; i++) {
            const moveKeybindingName = `sage-send-window-to-screen-${i + 1}`;
            this._addKeybinding(
                moveKeybindingName,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this.sendWindowToScreen(i)
            );

            const focusKeybindingName = `sage-focus-screen-${i + 1}`;
            this._addKeybinding(
                focusKeybindingName,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this.focusScreen(i)
            );
        }
        console.log('Keybindings added');
    }

    _removeKeybindings() {
        for (const keybindingName of this._keybindingNames) {
            Main.wm.removeKeybinding(keybindingName);
        }
        this._keybindingNames = [];
        console.log('Keybindings removed');
    }

    _addKeybinding(name, flags, actionMode, handler) {
        Main.wm.addKeybinding(
            name,
            this._settings,
            flags,
            actionMode,
            handler,
        );
        this._keybindingNames.push(name);
    }

    _disableWorkspaceSwitcherPopup() {
        if (this._originalDisplay) {
            return;
        }

        this._originalDisplay = WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype.display;
        WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype.display = function() {};
        console.log('Workspace switcher popup disabled');
    }

    _restoreWorkspaceSwitcherPopup() {
        if (this._originalDisplay) {
            WorkspaceSwitcherPopup.WorkspaceSwitcherPopup.prototype.display = this._originalDisplay;
            this._originalDisplay = null;
            console.log('Workspace switcher popup restored');
        }
    }
}
