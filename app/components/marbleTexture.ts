import * as THREE from "three";
import type { RacerItem } from "../data/categories";

// Build the texture wrapped onto a marble sphere for any racer item:
//  - img   -> load the PNG directly (flags), same as before
//  - emoji -> paint the glyph big and centred on a hue-tinted square
//  - color -> a solid tile (the clearcoat material makes it read glossy)
// No Suspense: an image texture fills in when it loads, so callers can render
// immediately. Returns a texture the caller should dispose on unmount.
export function itemTexture(item: RacerItem): THREE.Texture {
  if (item.img) {
    const t = new THREE.TextureLoader().load(item.img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;

  if (item.emoji) {
    g.fillStyle = `hsl(${item.hue}, 62%, 58%)`;
    g.fillRect(0, 0, size, size);
    g.font = `${size * 0.72}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(item.emoji, size / 2, size * 0.54);
  } else {
    g.fillStyle = item.color ?? `hsl(${item.hue}, 80%, 55%)`;
    g.fillRect(0, 0, size, size);
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
