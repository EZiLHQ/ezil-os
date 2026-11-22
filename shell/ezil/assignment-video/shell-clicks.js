// A visible click cue on trusted shell chrome only. Browser cursor composition covers embedded content.
export function showShellClicks(win) {
    let cue, timer;
    function remove() { win.clearTimeout(timer); cue?.remove(); cue = null; }
    function show(ev) {
        if (!ev.isTrusted || ev.view !== win || ![0, 2].includes(ev.button)
            || !ev.target?.closest?.('#ezil-os-root, .window, .taskbar')
            || ev.target.closest('input, textarea, [contenteditable="true"]')) return;
        remove();
        cue = win.document.createElement('span');
        cue.className = 'ezil-assignment-click';
        cue.classList.toggle('ezil-assignment-click-right', ev.button === 2);
        cue.setAttribute('aria-hidden','true');
        cue.style.left = ev.clientX+'px';
        cue.style.top = ev.clientY+'px';
        cue.textContent = ev.button === 2 ? 'R' : 'L';
        win.document.body.append(cue);
        timer = win.setTimeout(remove,1150);
    }
    win.document.addEventListener('pointerdown',show,{capture:true,passive:true});
    return () => { remove(); win.document.removeEventListener('pointerdown',show,true); };
}
