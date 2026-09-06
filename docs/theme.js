// Three-state theme control, shared by every page.
//
// "system" removes the attribute entirely so prefers-color-scheme decides;
// the other two stamp the root element, which the stylesheet honours in both
// directions. localStorage is wrapped because a file:// page in a private
// window throws on the accessor itself, not merely on a missing value.
(function () {
    var KEY = 'tabby-fork-docs-theme'
    var root = document.documentElement

    function apply (choice) {
        if (choice === 'system') {
            root.removeAttribute('data-theme')
        } else {
            root.setAttribute('data-theme', choice)
        }
        var buttons = document.querySelectorAll('[data-theme-choice]')
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-choice') === choice))
        }
    }

    var saved = 'system'
    try { saved = window.localStorage.getItem(KEY) || 'system' } catch (e) { /* private mode */ }
    apply(saved)

    // Delegated, so it works for a toggle inserted after this script runs.
    document.addEventListener('click', function (e) {
        var button = e.target.closest ? e.target.closest('[data-theme-choice]') : null
        if (!button) { return }
        var choice = button.getAttribute('data-theme-choice')
        apply(choice)
        try { window.localStorage.setItem(KEY, choice) } catch (e2) { /* private mode */ }
    })

    // The buttons exist by DOMContentLoaded even when this ran in <head>.
    document.addEventListener('DOMContentLoaded', function () {
        var current = root.getAttribute('data-theme') || 'system'
        apply(current)
    })
})()
