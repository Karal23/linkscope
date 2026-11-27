'use strict';

(() => {
  const root = document.documentElement;
  const usePointer = () => { root.dataset.focusMode = 'pointer'; };
  usePointer();
  document.addEventListener('pointerdown', usePointer, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') root.dataset.focusMode = 'keyboard';
  }, true);

  const key = 'linkscope-theme';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let choice;
  try {
    choice = localStorage.getItem(key);
  } catch {
    // Embedded previews can disable local storage.
  }

  function applyTheme() {
    const theme = choice === 'dark' || choice === 'light' ? choice : system.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0b1015' : '#f2f5f7';
    document.querySelectorAll('[data-set-theme]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.setTheme === theme));
    });
  }

  applyTheme();
  document.addEventListener('DOMContentLoaded', applyTheme);
  system.addEventListener('change', applyTheme);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-set-theme]');
    if (!button) return;
    choice = button.dataset.setTheme;
    applyTheme();
    try {
      localStorage.setItem(key, choice);
    } catch {
      // The selection still applies to the open page.
    }
  });
})();
