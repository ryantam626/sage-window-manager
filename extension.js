import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';

import Meta from 'gi://Meta';


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
        this._highlightedWindow = null;
        this._borderWidget = null;
        this._windowSignals = [];
        this._focusSignalId = null;
        this._workspaceSignalId = null;
        this._windowStateSignalId = null;
        this._windowCreatedSignalId = null;
        this._restackSignalId = null;
        this._unmaximizeTimeout = null;
    }

    enable() {
        console.log('Simple Window Cycler: enabled');

        this._focusSignalId = global.display.connect('notify::focus-window', this._onFocusChanged.bind(this));
        this._workspaceSignalId = global.workspace_manager.connect('active-workspace-changed', this._onFocusChanged.bind(this));

        // Listen for any window maximize state changes globally
        this._windowStateSignalId = global.display.connect('window-demands-attention', this._onWindowStateChanged.bind(this));
        this._windowCreatedSignalId = global.display.connect('window-created', (display, window) => {
            // Connect to each new window's maximize signals
            window.connect('notify::maximized-horizontally', () => this._onWindowStateChanged());
            window.connect('notify::maximized-vertically', () => this._onWindowStateChanged());
        });

        // Connect to existing windows
        global.get_window_actors().forEach(actor => {
            const window = actor.get_meta_window();
            if (window) {
                window.connect('notify::maximized-horizontally', () => this._onWindowStateChanged());
                window.connect('notify::maximized-vertically', () => this._onWindowStateChanged());
            }
        });
    }

    _onWindowStateChanged() {
        const currentFocus = global.display.get_focus_window();

        if (currentFocus) {
            if (currentFocus.get_maximized()) {
                this._clearHighlights();
            } else if (currentFocus === this._highlightedWindow) {
                // Window was unmaximized and is still our highlighted window, do nothing
            } else {
                // Window was unmaximized and now focused, highlight it with delay
                this._highlightWindow(currentFocus, true); // Pass flag indicating unmaximize
            }
        }
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
        this._clearHighlights();
    }
    _onFocusChanged() {
        const currentFocus = global.display.get_focus_window();

        if (currentFocus !== this._highlightedWindow) {
            this._clearHighlights();
        }

        if (currentFocus) {
            this._highlightWindow(currentFocus, false);
        }
    }

    _highlightWindow(window, isUnmaximize = false) {
        if (!window || window.get_maximized()) {
            this._clearHighlights();
            return;
        }

        this._clearHighlights();

        if (isUnmaximize) {
            // Delay only for unmaximize events to let animation finish
            this._unmaximizeTimeout = setTimeout(() => {
                this._createBorder(window);
            }, 250); // Adjust timing as needed
        } else {
            // Normal focus change, create border immediately
            this._createBorder(window);
        }
    }

    _createBorder(window) {
        // Check again in case window state changed during animation
        if (!window || window.get_maximized()) {
            return;
        }

        this._borderWidget = new St.Bin({
            style: `
        border: 3px solid #88c0d0;
        border-radius: 6px;
        background: transparent;
        pointer-events: none;
    `
        });

        this._updateBorderLayout(window);

        global.window_group.add_child(this._borderWidget);
        global.window_group.set_child_above_sibling(this._borderWidget, window.get_compositor_private());

        // Listen for restacking to maintain proper z-order
        this._restackSignalId = global.display.connect('restacked', () => {
            if (this._borderWidget && this._highlightedWindow) {
                const actor = this._highlightedWindow.get_compositor_private();
                global.window_group.set_child_above_sibling(this._borderWidget, actor);
            }
        });

        this._highlightedWindow = window;
        this._windowSignals = [
            window.connect('size-changed', () => this._updateBorderLayout(window)),
            window.connect('position-changed', () => this._updateBorderLayout(window))
        ];
    }

    _updateBorderLayout(window) {
        if (!this._borderWidget) return;

        const rect = window.get_frame_rect();
        this._borderWidget.set_position(rect.x - 3, rect.y - 3);
        this._borderWidget.set_size(rect.width + 6, rect.height + 6);
    }

    _clearHighlights() {
        if (this._unmaximizeTimeout) {
            clearTimeout(this._unmaximizeTimeout);
            this._unmaximizeTimeout = null;
        }

        // Disconnect restack signal
        if (this._restackSignalId) {
            global.display.disconnect(this._restackSignalId);
            this._restackSignalId = null;
        }

        if (this._windowSignals.length > 0 && this._highlightedWindow) {
            this._windowSignals.forEach(id => {
                this._highlightedWindow.disconnect(id);
            });
            this._windowSignals = [];
        }

        if (this._borderWidget) {
            global.window_group.remove_child(this._borderWidget);
            this._borderWidget.destroy();
            this._borderWidget = null;
        }

        this._highlightedWindow = null;
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

export default class SageWindowManagerExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._windowCycler = null;
        this._originalWorkspaceSwitcherDisplay = null;  // ADD THIS LINE
    }

    enable() {
        console.log('Sage Window Manager Extension: enabled');
        this._windowCycler = new SimpleWindowCycler();
        this._windowCycler.enable();
        this._addKeybindings();
        this._disableWorkspaceSwitcherPopup();
    }

    disable() {
        console.log('Sage Window Manager Extension: disabled');
        if (this._windowCycler) {
            this._windowCycler.disable();
            this._windowCycler = null;
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

        console.log('Keybindings added');
    }

    _removeKeybindings() {
        Main.wm.removeKeybinding('sage-cycle-windows-forward');
        Main.wm.removeKeybinding('sage-cycle-windows-backward');
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
