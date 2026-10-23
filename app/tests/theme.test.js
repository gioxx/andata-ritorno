// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { getTheme, setTheme } from '../src/theme.js';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  it('setTheme("dark") stores the choice and sets the attribute', () => {
    setTheme('dark');
    expect(localStorage.getItem('ar-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(getTheme()).toBe('dark');
  });

  it('setTheme("auto") removes the key and the attribute', () => {
    setTheme('light');
    setTheme('auto');
    expect(localStorage.getItem('ar-theme')).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('getTheme() is "auto" when no key is stored', () => {
    expect(getTheme()).toBe('auto');
  });
});
