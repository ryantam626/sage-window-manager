import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import Meta from 'gi://Meta';


const MAX_WORKSPACES = 5;


/**
 * @param {import('@girs/meta-12').Meta.Window} window
 * @returns {boolean}
 */
function _shouldManageWindow(window) {
    if (!window) return false;

    // Skip special window types
    const windowType = window.get_window_type();
    const skipTypes = [
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
        Meta.WindowType.OVERRIDE_OTHER
    ];

    return (
        !skipTypes.includes(windowType) &&
        !window.is_skip_taskbar() &&
        window.get_title() !== '' &&
        !window.is_hidden()
    );
}


/**
 * Get window that's eligible to be managed.
 * @param workspace - Mutter workspace
 * @param monitor - Mutter monitor (nullable)
 * @returns {*} Windows
 */
function _getEligibleWindows(workspace, monitor) {
    const windows = workspace.list_windows();

    return windows.filter(window => {
        return (
            ((monitor != null) && (window.get_monitor() === monitor)) &&
            _shouldManageWindow(window) &&
            window.showing_on_its_workspace() &&
            !window.minimized
        );
    }).sort((a, b) => {
        // Sort by stacking order (most recently used first)
        return b.get_stable_sequence() - a.get_stable_sequence();
    });
}


class SimpleWindowCycler {

    constructor() {
        this._focusSignalId = null;
        this._workspaceSignalId = null;
        this._windowStateSignalId = null;
        this._windowCreatedSignalId = null;
    }

    enable() {
        console.log('Simple Window Cycler: enabled');
    }

    disable() {
        console.log('Simple Window Cycler: disabled');

        if (this._focusSignalId) {
            global.display.disconnect(this._focusSignalId);
            this._focusSignalId = null;
        }
        if (this._workspaceSignalId) {
            global.workspace_manager.disconnect(this._workspaceSignalId);
            this._workspaceSignalId = null;
        }

        if (this._windowStateSignalId) {
            global.display.disconnect(this._windowStateSignalId);
            this._windowStateSignalId = null;
        }
        if (this._windowCreatedSignalId) {
            global.display.disconnect(this._windowCreatedSignalId);
            this._windowCreatedSignalId = null;
        }
    }

    cycleForward() {
        this._cycleWindows('forward');
    }

    cycleBackward() {
        this._cycleWindows('backward');
    }

    _cycleWindows(direction) {
        const currentMonitor = global.display.get_current_monitor();
        const currentWorkspace = global.workspace_manager.get_active_workspace();

        // Get all windows on current workspace and monitor
        const windows = _getEligibleWindows(currentWorkspace, currentMonitor);

        if (windows.length === 0) {
            console.log('Not enough windows to cycle');
            return;
        }

        // Find currently focused window
        const focusedWindow = global.display.get_focus_window();
        let currentIndex = windows.findIndex(w => w === focusedWindow);

        // If no focused window found, start from first
        if (currentIndex === -1) {
            currentIndex = 0;
        }

        // Calculate next window index
        let nextIndex;
        if (direction === 'forward') {
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

        // Raise and focus
        window.raise();
        window.focus(timestamp);
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


export default class SageWindowManagerExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._windowCycler = null;
        this._windowMover = null;
    }

    enable() {
        console.log('Sage Window Manager Extension: enabled');
        this._windowCycler = new SimpleWindowCycler();
        this._windowMover = new WindowWorkspaceMover();
        this._windowCycler.enable();
        this._windowMover.enable();
        this._addKeybindings();
        this._disableWorkspaceSwitcherPopup();
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
        this._removeKeybindings();
        this._restoreWorkspaceSwitcherPopup();
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
        console.log("hello");
        if (this._windowMover) {
            this._windowMover.moveToWorkspace(index);
        }
    }

    _addKeybindings() {
        // Add keybinding for cycling windows forward
        Main.wm.addKeybinding(
            'sage-cycle-windows-forward',
            this.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.cycleWindowsForward.bind(this),
        );

        // Add keybinding for cycling windows backward
        Main.wm.addKeybinding(
            'sage-cycle-windows-backward',
            this.getSettings(),
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            this.cycleWindowsBackward.bind(this),
        );

        for (let i = 0; i < MAX_WORKSPACES; i++) {
            const keybindingName = `sage-move-to-workspace-${i + 1}`;
            Main.wm.addKeybinding(
                keybindingName,
                this.getSettings(),
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                () => this.moveToWorkspace(i)
            );
        }
        console.log('Keybindings added');
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('sage-cycle-windows-forward');
        Main.wm.removeKeybinding('sage-cycle-windows-backward');
        for (let i = 0; i < MAX_WORKSPACES; i++) {
            const keybindingName = `sage-move-to-workspace-${i + 1}`;
            Main.wm.removeKeybinding(keybindingName);
        }
        console.log('Keybindings removed');
    }

    _disableWorkspaceSwitcherPopup() {
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
