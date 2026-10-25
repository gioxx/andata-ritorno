// Lucide icon nodes -> inline SVG strings (no DOM needed, so templates stay plain strings).
import { Menu, Trash2, Check, Pencil, X, Camera, ClipboardPaste, Image, Download, Upload, Layers, ListChecks, Monitor, Sun, Moon, ZoomIn, ExternalLink, Tags, RotateCw, ChevronLeft, ChevronRight, Smartphone, LogOut, Trash } from 'lucide'

const svg = (node, size = 20) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('')
  }</svg>`

export const menuIcon = svg(Menu)
export const trashIcon = svg(Trash2)
export const checkIcon = svg(Check, 12)
export const pencilIcon = svg(Pencil)
export const zoomInIcon = svg(ZoomIn, 22)
export const closeIcon = svg(X, 22)
export const cameraIcon = svg(Camera, 18)
export const pasteIcon = svg(ClipboardPaste, 18)
export const imageIcon = svg(Image, 18)
export const downloadIcon = svg(Download, 18)
export const uploadIcon = svg(Upload, 18)
export const layersIcon = svg(Layers, 18)
export const todoIcon = svg(ListChecks, 18)
export const monitorIcon = svg(Monitor, 16)
export const sunIcon = svg(Sun, 16)
export const moonIcon = svg(Moon, 16)
export const linkIcon = svg(ExternalLink, 13) // lucide ships no brand icons (no github)
export const tagsIcon = svg(Tags, 18)
export const rotateIcon = svg(RotateCw, 18)
export const chevronLeftIcon = svg(ChevronLeft, 24)
export const chevronRightIcon = svg(ChevronRight, 24)
export const smartphoneIcon = svg(Smartphone, 18)
export const logOutIcon = svg(LogOut, 18)
export const eraseIcon = svg(Trash, 18)
