// imports.gi
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import type Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

// gnome-shell modules
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { layoutManager, overview } from 'resource:///org/gnome/shell/ui/main.js';
import { WindowPreview } from 'resource:///org/gnome/shell/ui/windowPreview.js';
import { WorkspaceAnimationController } from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// local modules
import { Services } from './dbus/services.js';
import { LinearFilterEffect } from './effect/linear_filter_effect.js';
import { RoundedCornersEffect } from './effect/rounded_corners_effect.js';
import { WindowActorTracker } from './manager/effect_manager.js';
import { connections } from './utils/connections.js';
import { constants } from './utils/constants.js';
import { _log, stackMsg } from './utils/log.js';
import { init_settings, uninit_settings, settings } from './utils/settings.js';
import * as UI from './utils/ui.js';

// types, which will be removed in output
import type { RoundedCornersCfg } from './utils/types.js';
import type { ExtensionsWindowActor } from './utils/types.js';

// --------------------------------------------------------------- [end imports]

export default class RoundedWindowCornersReborn extends Extension {
    // The methods of gnome-shell to monkey patch
    private _orig_add_window!: (_: Meta.Window) => void;
    private _orig_prep_workspace_swt!: (workspaceIndices: number[]) => void;
    private _orig_finish_workspace_swt!: typeof WorkspaceAnimationController.prototype._finishWorkspaceSwitch;

    private _services: Services | null = null;
    private _window_actor_tracker: WindowActorTracker | null = null;

    enable() {
        init_settings(this.getSettings());

        // Restore original methods, those methods will be restore when
        // extensions is disabled
        this._orig_add_window = WindowPreview.prototype._addWindow;
        this._orig_prep_workspace_swt =
            WorkspaceAnimationController.prototype._prepareWorkspaceSwitch;
        this._orig_finish_workspace_swt =
            WorkspaceAnimationController.prototype._finishWorkspaceSwitch;

        this._services = new Services();
        this._window_actor_tracker = new WindowActorTracker();

        this._services.export();

        // Enable rounded corners effects when gnome-shell is ready
        //
        // https://github.com/aunetx/blur-my-shell/blob/
        //  21d4bbde15acf7c3bf348f7375a12f7b14c3ab6f/src/extension.js#L87

        if (layoutManager._startingUp) {
            const c = connections.get();
            c.connect(layoutManager, 'startup-complete', () => {
                this._window_actor_tracker?.enable();
                if (settings().enable_preferences_entry) {
                    UI.SetupBackgroundMenu();
                }
                c.disconnect_all(layoutManager);
            });
        } else {
            this._window_actor_tracker?.enable();
            if (settings().enable_preferences_entry) {
                UI.SetupBackgroundMenu();
            }
        }

        const self = this;

        // WindowPreview is a widgets that show content of window in overview.
        // this widget also contain a St.Label (show title of window), icon and
        // close button for window.
        //
        // When there is new window added into overview, this function will be
        // called. We need add our shadow actor and blur actor of rounded
        // corners window into overview.
        //
        WindowPreview.prototype._addWindow = function (window) {
            // Copy original method here, since we would need clone variable later
            const layoutManager: Shell.WindowPreviewLayout = this
                .window_container.layout_manager as Shell.WindowPreviewLayout;
            const clone = layoutManager.add_window(window);
            if (!clone) {
                return;
            }

            _log(`Adding ${window.title} to the windowPreview`);

            // Shell.util_set_hidden_from_pick(clone, true);

            // Make sure patched method only be called in _init() of WindowPreview
            // https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/ui/windowPreview.js#L42

            const stack = stackMsg();
            if (
                stack === undefined
                //stack.indexOf('_updateAttachedDialogs') !== -1 ||
                //stack.indexOf('addDialog') !== -1
            ) {
                return;
            }

            // If the window don't have rounded corners and shadows just return
            let cfg: RoundedCornersCfg | null = null;
            let has_rounded_corners = false;
            const windowActor =
                window.get_compositor_private() as Meta.WindowActor;
            const shadow = (windowActor as ExtensionsWindowActor)
                .__rwc_rounded_window_info?.shadow;
            if (shadow) {
                cfg = UI.ChoiceRoundedCornersCfg(
                    settings().global_rounded_corner_settings,
                    settings().custom_rounded_corner_settings,
                    window,
                );
                has_rounded_corners = UI.ShouldHasRoundedCorners(window, cfg);
            }
            if (!(has_rounded_corners && shadow)) {
                return;
            }

            _log(`Add shadow for ${window.title} in overview`);

            // Create a shadow copy and add it below window actor in window_container
            const shadow_actor = new OverviewShadowActor(
                shadow,
                clone
            );
            this.window_container.insert_child_below(shadow_actor, clone);

            clone.add_effect(new LinearFilterEffect());

            // Disable rounding on window itself to avoid blurry preview
            const window_rounding_effect =
                UI.get_rounded_corners_effect(windowActor);
            window_rounding_effect?.set_enabled(false);

            const effect_name = `${constants.ROUNDED_CORNERS_EFFECT} (Overview)`;
            clone.add_effect_with_name(effect_name, new RoundedCornersEffect());

            const c = connections.get();
            // Update uniform values whenever window's clone changes it's size
            c.connect(clone, 'notify::width', () => {
                const effect = clone.get_effect(effect_name) as InstanceType<
                    typeof RoundedCornersEffect
                >;

                const frame_rect = window.get_frame_rect();
                const buf_rect = window.get_buffer_rect();
                const horizontal_scale = clone.width / frame_rect.width;
                const vertical_scale = clone.height / frame_rect.height;
                const x1 = (buf_rect.width - frame_rect.width) / 2 * horizontal_scale;
                const y1 = (buf_rect.height - frame_rect.height) / 2 * vertical_scale;
                const x2 = clone.width * horizontal_scale - x1;
                const y2 = clone.height * vertical_scale - y1;

                _log(`frame_rect: ${frame_rect.width}, ${frame_rect.height}`);
                _log(`buf_rect: ${buf_rect.width}, ${buf_rect.height}`);
                _log(`scales: ${horizontal_scale}, ${vertical_scale}`);
                _log(`x1: ${x1}, y1: ${y1}`);
                _log(`x2: ${x2}, y2: ${y2}`);

                if (!effect) {
                    return;
                }

                const scale_factor = UI.WindowScaleFactor(window) * horizontal_scale;
                let pixel_step: [number, number] | undefined = undefined;
                if (
                    window.get_client_type() === Meta.WindowClientType.WAYLAND
                ) {
                    const surface = (
                        window.get_compositor_private() as Meta.WindowActor
                    ).firstChild;
                    pixel_step = [
                        1.0 / (scale_factor * surface.get_width()),
                        1.0 / (scale_factor * surface.get_height()),
                    ];
                }

                effect.update_uniforms(
                    scale_factor,
                    settings().global_rounded_corner_settings,
                    { x1, y1, x2, y2 },
                    { width: 0, color: [0, 0, 0, 0] },
                    pixel_step,
                );
            });
            // Cleanup after windowPreview is being destroyed
            c.connect(clone, 'destroy', () => {
                //shadow_actor.destroy();
                clone.clear_effects();
                if (
                    overview._overview.controls._workspacesDisplay
                        ._leavingOverview
                ) {
                    window_rounding_effect?.set_enabled(true);
                }
                c.disconnect_all(clone);
            });
        };

        // Just Like the monkey patch when enter overview, need to add cloned shadow
        // actor when switching workspaces on Desktop
        WorkspaceAnimationController.prototype._prepareWorkspaceSwitch =
            function (workspaceIndices) {
                self._orig_prep_workspace_swt.apply(this, [workspaceIndices]);
                for (const monitor of this._switchData.monitors) {
                    for (const workspace of monitor._workspaceGroups) {
                        // Let shadow actor always behind the window clone actor when we
                        // switch workspace by Ctrl+Alt+Left/Right
                        //
                        // Fix #55
                        const restacked_id = global.display.connect(
                            'restacked',
                            () => {
                                for (const {
                                    clone,
                                } of workspace._windowRecords) {
                                    const shadow = (clone as WsAnimationActor)
                                        ._shadow_clone;
                                    if (shadow) {
                                        workspace.set_child_below_sibling(
                                            shadow,
                                            clone,
                                        );
                                    }
                                }
                            },
                        );
                        const destroy_id = workspace.connect('destroy', () => {
                            global.display.disconnect(restacked_id);
                            workspace.disconnect(destroy_id);
                        });

                        for (const {
                            windowActor: actor,
                            clone,
                        } of workspace._windowRecords) {
                            const win = actor.metaWindow;
                            const frame_rect = win.get_frame_rect();
                            const shadow = (actor as ExtensionsWindowActor)
                                .__rwc_rounded_window_info?.shadow;
                            const enabled =
                                UI.get_rounded_corners_effect(actor)?.enabled;
                            if (shadow && enabled) {
                                // Only create shadow actor when window should have rounded
                                // corners when switching workspace

                                // Copy shadow actor to workspace group, so that to see
                                // shadow when switching workspace
                                const shadow_clone = new Clutter.Clone({
                                    source: shadow,
                                });
                                const paddings =
                                    constants.SHADOW_PADDING *
                                    UI.WindowScaleFactor(win);

                                shadow_clone.width =
                                    frame_rect.width + paddings * 2;
                                shadow_clone.height =
                                    frame_rect.height + paddings * 2;
                                shadow_clone.x =
                                    clone.x + frame_rect.x - actor.x - paddings;
                                shadow_clone.y =
                                    clone.y + frame_rect.y - actor.y - paddings;

                                // Should works well work Desktop Cube extensions
                                const notify_id = clone.connect(
                                    'notify::translation-z',
                                    () => {
                                        shadow_clone.translationZ =
                                            clone.translationZ - 0.05;
                                    },
                                );
                                const destroy_id = clone.connect(
                                    'destroy',
                                    () => {
                                        clone.disconnect(notify_id);
                                        clone.disconnect(destroy_id);
                                    },
                                );

                                // Add reference shadow clone for clone actor, so that we
                                // can restack position of shadow when we need
                                (clone as WsAnimationActor)._shadow_clone =
                                    shadow_clone;
                                clone.bind_property(
                                    'visible',
                                    shadow_clone,
                                    'visible',
                                    0,
                                );
                                workspace.insert_child_below(
                                    shadow_clone,
                                    clone,
                                );
                            }
                        }
                    }
                }
            };

        WorkspaceAnimationController.prototype._finishWorkspaceSwitch =
            function (switchData) {
                for (const monitor of this._switchData.monitors) {
                    for (const workspace of monitor._workspaceGroups) {
                        for (const { clone } of workspace._windowRecords) {
                            (
                                clone as WsAnimationActor
                            )._shadow_clone?.destroy();
                            delete (clone as WsAnimationActor)._shadow_clone;
                        }
                    }
                }
                self._orig_finish_workspace_swt.apply(this, [switchData]);
            };

        const c = connections.get();

        // Gnome-shell will not disable extensions when _logout/shutdown/restart
        // system, it means that the signal handlers will not be cleaned when
        // gnome-shell is closing.
        //
        // Now clear all resources manually before gnome-shell closes
        c.connect(global.display, 'closing', () => {
            _log('Clear all resources because gnome-shell is shutdown');
            this.disable();
        });

        // Watch changes of GSettings
        c.connect(
            settings().g_settings,
            'changed',
            (_: Gio.Settings, k: string) => {
                if (k === 'enable-preferences-entry') {
                    settings().enable_preferences_entry
                        ? UI.SetupBackgroundMenu()
                        : UI.RestoreBackgroundMenu();
                }
            },
        );

        _log('Enabled');
    }

    disable() {
        // Restore patched methods
        WindowPreview.prototype._addWindow = this._orig_add_window;
        WorkspaceAnimationController.prototype._prepareWorkspaceSwitch =
            this._orig_prep_workspace_swt;
        WorkspaceAnimationController.prototype._finishWorkspaceSwitch =
            this._orig_finish_workspace_swt;

        // Remove the item to open preferences page in background menu
        UI.RestoreBackgroundMenu();

        this._services?.unexport();
        this._window_actor_tracker?.disable();

        // Disconnect all signals in global connections.get()
        connections.get().disconnect_all();
        connections.del();

        // Set all props to null
        this._window_actor_tracker = null;
        this._services = null;

        _log('Disabled');

        uninit_settings();
    }
}

/**
 * Copy shadow of rounded corners window and show it in overview.
 * This actor will be created when window preview has created for overview
 */
const OverviewShadowActor = GObject.registerClass(
    {},
    class extends Clutter.Clone {
        _target!: Clutter.Actor;
        _actor!: Meta.WindowActor;

        /**
         * Create shadow actor for WindowPreview in overview
         * @param source the shadow actor create for rounded corners shadow
         * @param window_preview the window preview has shown in overview
         */
        constructor(
            source: Clutter.Actor,
            target: Clutter.Actor,
        ) {
            super({
                source, // the source shadow actor shown in desktop
                name: constants.OVERVIEW_SHADOW_ACTOR,
                pivotPoint: new Graphene.Point().init(0.5, 0.5),
            });

            this._target = target;
        }

        vfunc_allocate(box: Clutter.ActorBox): void {
            const window_actor = (this._target as Clutter.Clone).get_source() as Meta.WindowActor;
            const meta_win = window_actor.get_meta_window();
            const window_container = this._target.get_parent();
            if (!(meta_win && window_container)) {
                return;
            }
            // I don't really know how to properly handle attached dialog
            // since I don't know how to get their's true position and size
            // so let's just skip them all together
            if (meta_win.is_attached_dialog()) {
                return;
            }


            const frame_rect = meta_win.get_frame_rect();
            const buf_rect = meta_win.get_buffer_rect();
            // If this is a root window (i.e. not a modal dialog), one of it's dimensions
            // should lineup with dimensions of window_container
            // If it isn't this might mean, that we have relly big modal dialog
            const scale = Math.min(
                window_container.width / frame_rect.width,
                window_container.height / frame_rect.height
            );
            const paddings =
                constants.SHADOW_PADDING *
                scale *
                UI.WindowScaleFactor(meta_win);

            const x = this._target.x + (buf_rect.width - frame_rect.width) / 2 * scale
            const y = this._target.y + (buf_rect.height - frame_rect.height) / 2 * scale
            const width = frame_rect.width * scale - x;
            const height = frame_rect.height * scale - y;
            box.set_origin(
                x - paddings,
                y - paddings
            );
            box.set_size(
                width + 2 * paddings,
                height + 2 * paddings
            );

            super.vfunc_allocate(box);
        }
    },
);

type WsAnimationActor = Clutter.Actor & { _shadow_clone?: Clutter.Actor };
