/**
 * Copyright (C) 2024-present Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */// MODIFIED BY EZIL 2026-07-31: removed everything the taskbar used to fetch
// from Puter's cloud, and left the geometry, sorting and resize logic intact.
//
// Cut (see shell/PUTER-PROVENANCE.md):
//   - the `GET /get-launch-apps` XHR and the entire Start-button launcher
//     popover it fed (~180 lines: recent/recommended app grids, app search,
//     drag-to-pin, and the per-app context menu whose "Add to Desktop" wrote
//     a `.app` shortcut through `puter.fs.upload`). `puter.apps` is not ported.
//   - the Explorer taskbar item and the `window.user.taskbar_items` loop, both
//     of which called the 805-line `launch_app` helper.
//   - the Trash item, its `puter.fs.stat` probe and the `socket.io`
//     `trash.is_empty` emit. There is no filesystem and no realtime channel.
//   - the two separators, which existed only to bracket Trash.
//
// Changed:
//   - `puter.kv.get/set('taskbar_position')` -> `ezil/session.js`
//     (localStorage). Same key, same semantics, no network.
//   - `window.update_taskbar()` was defined in the un-ported UIDesktop.js and
//     persisted pinned items to the backend; it is defined here now and
//     persists to localStorage.
//   - the Start button survives without its popover and instead dispatches an
//     `ezil:start-click` CustomEvent, so the EZiL desktop root can own what
//     opens without this file knowing anything about it.
//
// Kept but now unreachable: the `receive`/`update` branches of
// `make_taskbar_sortable` that handled a `.start-app` tile dragged out of the
// popover. Their only drag source is gone. They are left in place rather than
// cut because sortable's option object is one of the interleaved regions this
// wave is not touching; the `launch_app` they call is the rejecting stub, so
// if the branch ever does run it says so instead of doing nothing.

import UITaskbarItem from './UITaskbarItem.js';
import { launch_app } from '../ezil-stubs.js';
import session from '../../ezil/session.js';

/**
 * Replaces upstream's `window.update_taskbar`, which lived in UIDesktop.js and
 * PUT the pinned-item list to Puter's backend. Local-only here.
 */
window.update_taskbar = function () {
    const pinned = [];
    $('.taskbar-item[data-keep-in-taskbar="true"]').each(function () {
        const app = $(this).attr('data-app');
        if ( app && app !== 'undefined' ) pinned.push(app);
    });
    session.set('taskbar_items', pinned);
};

async function UITaskbar (options) {
    window.global_element_id++;

    options = options ?? {};
    options.content = options.content ?? '';

    // Upstream read this from `puter.kv`; EZiL keeps it in localStorage. The
    // 'first visit ever' branch is preserved, including its 'left' default.
    let taskbar_position;

    if ( window.first_visit_ever ) {
        session.set('taskbar_position', 'left');
        taskbar_position = 'left';
    } else {
        taskbar_position = session.get('taskbar_position');
        if ( ! taskbar_position ) {
            taskbar_position = 'bottom'; // default position
            session.set('taskbar_position', taskbar_position);
        }
    }

    // Force bottom position on mobile devices
    if ( isMobile.phone || isMobile.tablet ) {
        taskbar_position = 'bottom';
    }

    // Set global taskbar position
    window.taskbar_position = taskbar_position;

    let h = '';
    h += `<div id="ui-taskbar_${window.global_element_id}" class="taskbar taskbar-position-${taskbar_position}" style="height:${window.taskbar_height}px;">`;
    h += '<div class="taskbar-sortable" style="display: flex; justify-content: center; z-index: 99999;"></div>';
    h += '</div>';

    if ( taskbar_position === 'left' || taskbar_position === 'right' ) {
        $('.desktop').addClass(`desktop-taskbar-position-${taskbar_position}`);
    }

    $('.desktop').append(h);

    //---------------------------------------------
    // add `Start` to taskbar
    //---------------------------------------------
    // Upstream opened a 500x500 popover here listing recent + recommended apps
    // from `puter.apps`. EZiL has no app registry to list, so the button only
    // announces the click and the desktop root decides what it means.
    UITaskbarItem({
        icon: window.icons['start.svg'],
        name: i18n('start'),
        sortable: false,
        keep_in_taskbar: true,
        disable_context_menu: true,
        onClick: function (item) {
            window.dispatchEvent(new CustomEvent('ezil:start-click', {
                detail: { element: item },
            }));
        },
    });

    window.make_taskbar_sortable();
}

//-------------------------------------------
// Taskbar is sortable
//-------------------------------------------
window.make_taskbar_sortable = function () {
    const position = window.taskbar_position || 'bottom';
    const axis = position === 'bottom' ? 'x' : 'y';

    $('.taskbar-sortable').sortable({
        axis: axis,
        items: '.taskbar-item-sortable:not(.has-open-contextmenu):not([data-app="separator"])',
        cancel: '.has-open-contextmenu',
        placeholder: 'taskbar-item-sortable-placeholder',
        helper: 'clone',
        distance: 5,
        revert: 10,
        receive: function (event, ui) {
            if ( ! $(ui.item).hasClass('taskbar-item') ) {
                // if app is already in taskbar, cancel
                if ( $(`.taskbar-item[data-app="${$(ui.item).attr('data-app-name')}"]`).length !== 0 ) {
                    $(this).sortable('cancel');
                    $('.taskbar .start-app').remove();
                    return;
                }
            }
        },
        update: function (event, ui) {
            if ( ! $(ui.item).hasClass('taskbar-item') ) {
                // if app is already in taskbar, cancel
                if ( $(`.taskbar-item[data-app="${$(ui.item).attr('data-app-name')}"]`).length !== 0 ) {
                    $(this).sortable('cancel');
                    $('.taskbar .start-app').remove();
                    return;
                }

                let item = UITaskbarItem({
                    icon: $(ui.item).attr('data-app-icon'),
                    app: $(ui.item).attr('data-app-name'),
                    name: $(ui.item).attr('data-app-title'),
                    append_to_taskbar: false,
                    keep_in_taskbar: true,
                    onClick: function () {
                        let open_window_count = parseInt($(`.taskbar-item[data-app="${$(ui.item).attr('data-app-name')}"]`).attr('data-open-windows'));
                        if ( open_window_count === 0 ) {
                            launch_app({
                                name: $(ui.item).attr('data-app-name'),
                            });
                        } else {
                            return false;
                        }
                    },
                });
                let el = ($(item).detach());
                $(el).insertAfter(ui.item);
                $(el).show();
                $(ui.item).removeItems();
                window.update_taskbar();
            }
            // only proceed to update DB if the item sorted was a pinned item otherwise no point in updating the taskbar in DB
            else if ( $(ui.item).attr('data-keep-in-taskbar') === 'true' ) {
                window.update_taskbar();
            }
        },
    });
};

// Function to update taskbar position
window.update_taskbar_position = async function (new_position) {
    // Prevent position changes on mobile devices - always keep bottom
    if ( isMobile.phone || isMobile.tablet ) {
        return;
    }

    // Valid positions
    const valid_positions = ['left', 'bottom', 'right'];

    if ( ! valid_positions.includes(new_position) ) {
        return;
    }

    // Store the new position
    // MODIFIED BY EZIL 2026-07-31: was `puter.kv.set` — now localStorage.
    session.set('taskbar_position', new_position);
    window.taskbar_position = new_position;

    // Remove old position classes and add new one
    $('.taskbar').removeClass('taskbar-position-left taskbar-position-bottom taskbar-position-right');
    $('.taskbar').addClass(`taskbar-position-${new_position}`);

    // update desktop class, if left or right, add `desktop-taskbar-position-left` or `desktop-taskbar-position-right`
    $('.desktop').removeClass('desktop-taskbar-position-left');
    $('.desktop').removeClass('desktop-taskbar-position-right');
    $('.desktop').addClass(`desktop-taskbar-position-${new_position}`);

    // Update desktop height/width calculations based on new position
    window.update_desktop_dimensions_for_taskbar();

    // Update window positions if needed (for maximized windows)
    $('.window[data-is_maximized="1"]').each(function () {
        const el_window = this;
        window.update_maximized_window_for_taskbar(el_window);
    });

    // Re-initialize sortable with correct axis
    $('.taskbar-sortable').sortable('destroy');
    window.make_taskbar_sortable();

    // Adjust taskbar item sizes for the new position
    setTimeout(() => {
        window.adjust_taskbar_item_sizes();
    }, 10);

    // adjust position if sidepanel is open
    if ( window.taskbar_position === 'bottom' ) {
        if ( $('.window[data-is_panel="1"][data-is_visible="1"]').length > 0 ) {
            $('.taskbar.taskbar-position-bottom').css('left', `calc(50% - ${window.PANEL_WIDTH / 2}px)`);
        } else if ( $('.window[data-is_panel="1"][data-is_visible="0"]').length > 0 ) {
            $('.taskbar.taskbar-position-bottom').css('left', 'calc(50%)');
        }
    } else {

    }

    // Reinitialize all taskbar item tooltips with new position
    $('.taskbar-item').each(function () {
        const $item = $(this);
        // Destroy existing tooltip
        if ( $item.data('ui-tooltip') ) {
            $item.tooltip('destroy');
        }

        // Helper function to get tooltip position based on taskbar position
        function getTooltipPosition () {
            const taskbarPosition = window.taskbar_position || 'bottom';

            if ( taskbarPosition === 'bottom' ) {
                return {
                    my: 'center bottom-20',
                    at: 'center top',
                };
            } else if ( taskbarPosition === 'top' ) {
                return {
                    my: 'center top+20',
                    at: 'center bottom',
                };
            } else if ( taskbarPosition === 'left' ) {
                return {
                    my: 'left+20 center',
                    at: 'right center',
                };
            } else if ( taskbarPosition === 'right' ) {
                return {
                    my: 'right-20 center',
                    at: 'left center',
                };
            }
            return {
                my: 'center bottom-20',
                at: 'center top',
            }; // fallback
        }

        const tooltipPosition = getTooltipPosition();

        // Reinitialize tooltip with new position
        $item.tooltip({
            items: ".taskbar:not(.children-have-open-contextmenu) .taskbar-item:not([data-app='separator'])",
            position: {
                my: tooltipPosition.my,
                at: tooltipPosition.at,
                using: function ( position, feedback ) {
                    $(this).css( position);
                    $('<div>')
                        .addClass( 'arrow')
                        .addClass( feedback.vertical)
                        .addClass( feedback.horizontal)
                        .appendTo( this);
                },
            },
        });
    });
};

// Function to update desktop dimensions based on taskbar position
window.update_desktop_dimensions_for_taskbar = function () {
    const position = window.taskbar_position || 'bottom';

    if ( position === 'bottom' ) {
        $('.desktop').css({
            'height': `calc(100vh - ${window.taskbar_height + window.toolbar_height}px)`,
            'width': '100%',
            'left': '0',
            'top': `${window.toolbar_height}px`,
        });
    } else if ( position === 'left' ) {
        $('.desktop').css({
            'height': `calc(100vh - ${window.toolbar_height}px)`,
            'width': `calc(100% - ${window.taskbar_height}px)`,
            'left': `${window.taskbar_height}px`,
            'top': `${window.toolbar_height}px`,
        });
    } else if ( position === 'right' ) {
        $('.desktop').css({
            'height': `calc(100vh - ${window.toolbar_height}px)`,
            'width': `calc(100% - ${window.taskbar_height}px)`,
            'left': '0',
            'top': `${window.toolbar_height}px`,
        });
    }
};

//-------------------------------------------
// Dynamic taskbar item resizing for left/right positions
//-------------------------------------------
window.adjust_taskbar_item_sizes = function () {
    const position = window.taskbar_position || 'bottom';

    // Only apply to left and right positions
    if ( position !== 'left' && position !== 'right' ) {
        // Reset to default sizes for bottom position
        $('.taskbar .taskbar-item').css({
            'width': '40px',
            'height': '40px',
            'min-width': '40px',
            'min-height': '40px',
        });
        $('.taskbar-icon').css('height', '40px');
        return;
    }

    const taskbar = $('.taskbar')[0];
    const taskbarItems = $('.taskbar .taskbar-item:visible');

    if ( !taskbar || taskbarItems.length === 0 ) return;

    // Get available height (minus padding)
    const totalItemsNeeded = taskbarItems.length;
    const taskbarHeight = taskbar.clientHeight;
    const paddingTop = 20; // from CSS
    const paddingBottom = 20; // from CSS
    const availableHeight = taskbarHeight - paddingTop - paddingBottom - 180;

    // Calculate space needed with default sizes
    const defaultItemSize = 40;
    const defaultMargin = 5;
    const spaceNeededDefault = (totalItemsNeeded * defaultItemSize) + ((totalItemsNeeded - 1) * defaultMargin);

    if ( spaceNeededDefault <= availableHeight ) {
        // No overflow, use default sizes
        taskbarItems.css({
            'width': '40px',
            'height': '40px',
            'min-width': '40px',
            'min-height': '40px',
            'padding': '6px 5px 10px 5px', // default padding
        });
        $('.taskbar-icon').css('height', `${defaultItemSize }px`);
        $('.taskbar-icon').css('width', '40px');
        $('.taskbar-icon > img').css('width', 'auto');
        $('.taskbar-icon > img').css('margin', 'auto');
        $('.taskbar-icon > img').css('display', 'block');

        // Reset margins to default
        taskbarItems.css('margin-bottom', '5px');
        taskbarItems.last().css('margin-bottom', '0px');
    } else {
        // Overflow detected, calculate smaller sizes
        // Reserve some margin space (minimum 2px between items)
        const minMargin = 2;
        const marginSpace = (totalItemsNeeded - 1) * minMargin;
        const availableForItems = availableHeight - marginSpace;
        const newItemSize = Math.floor(availableForItems / totalItemsNeeded);

        // Ensure minimum size of 20px
        const finalItemSize = Math.max(20, newItemSize);

        // Calculate proportional padding based on size ratio
        const sizeRatio = finalItemSize / defaultItemSize;
        const paddingTop = Math.max(1, Math.floor(6 * sizeRatio));
        const paddingRight = Math.max(1, Math.floor(5 * sizeRatio));
        const paddingBottom = Math.max(1, Math.floor(10 * sizeRatio));
        const paddingLeft = Math.max(1, Math.floor(5 * sizeRatio));

        // Apply new sizes and padding
        taskbarItems.css({
            'width': '40px',
            'height': `${finalItemSize }px`,
            'min-width': '40px',
            'min-height': `${finalItemSize }px`,
            'padding': `${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px`,
        });
        $('.taskbar-icon').css('height', `${finalItemSize }px`);
        $('.taskbar-icon').css('width', '40px');
        $('.taskbar-icon > img').css('width', 'auto');
        $('.taskbar-icon > img').css('margin', 'auto');
        $('.taskbar-icon > img').css('display', 'block');
        // Adjust margins
        taskbarItems.css('margin-bottom', `${minMargin }px`);
        taskbarItems.last().css('margin-bottom', '0px');
    }
};

// Hook into existing taskbar functionality
$(document).ready(function () {
    // Watch for taskbar item changes
    const observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            if ( mutation.type === 'childList' || mutation.type === 'attributes' ) {
                // Delay to ensure DOM updates are complete
                setTimeout(() => {
                    window.adjust_taskbar_item_sizes();
                }, 10);
            }
        });
    });

    // Start observing when taskbar is available
    const checkTaskbar = setInterval(() => {
        const taskbar = document.querySelector('.taskbar-sortable');
        if ( taskbar ) {
            observer.observe(taskbar, {
                childList: true,
                attributes: true,
                subtree: true,
            });
            clearInterval(checkTaskbar);

            // Initial call
            setTimeout(() => {
                window.adjust_taskbar_item_sizes();
            }, 100);
        }
    }, 100);

    // Also watch for window resize events
    window.addEventListener('resize', () => {
        setTimeout(() => {
            window.adjust_taskbar_item_sizes();
        }, 10);
    });
});

export default UITaskbar;
