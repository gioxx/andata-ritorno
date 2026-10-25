// Lucide icon nodes -> inline SVG strings (no DOM needed, so templates stay plain strings).
import { Menu, Trash2, Check, Pencil, Maximize2, X, Camera, ClipboardPaste, Image } from 'lucide'

const svg = (node, size = 20) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')
  }</svg>`

export const menuIcon = svg(Menu)
export const trashIcon = svg(Trash2)
export const checkIcon = svg(Check, 12)
export const pencilIcon = svg(Pencil)
export const expandIcon = svg(Maximize2, 14)
export const closeIcon = svg(X, 22)
export const cameraIcon = svg(Camera, 18)
export const pasteIcon = svg(ClipboardPaste, 18)
export const imageIcon = svg(Image, 18)
