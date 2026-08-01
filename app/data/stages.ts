// The 8 themed stages: each paints the whole map as its scene, plus the shared
// mowing-stripe helper and the stage picker icons.
import type { Ctx, Geo, Stage } from "@/lib/geometry";

// --- Stage decorators -------------------------------------------------------
// Each paints the ENTIRE canvas as the field (edge to edge). Surface treatments
// (grass stripes, water, markings) span the whole map; small props sit in the
// open centre so they are not hidden under the track ring drawn on top.

// Horizontal mowing stripes across the whole map.
function mowStripes(ctx: Ctx, g: Geo, a: string, b: string, n: number) {
  const sh = g.H / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? a : b;
    ctx.fillRect(0, i * sh, g.W, sh + 1);
  }
}

function stageHorse(ctx: Ctx, g: Geo) {
  // darker grass tufts scattered across the whole field
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.10)";
  for (let i = 0; i < 200; i++) {
    const x = (((i * 97) % 100) / 100) * g.W;
    const y = (((i * 53) % 100) / 100) * g.H;
    ctx.fillRect(x, y, g.dpr * 3, g.dpr * 6);
  }
  ctx.restore();
}

function stageSoccer(ctx: Ctx, g: Geo) {
  mowStripes(ctx, g, "rgba(255,255,255,0.05)", "rgba(0,0,0,0.05)", 10);
  const cx = g.W / 2, cy = g.H / 2;
  const m = Math.min(g.W, g.H) * 0.04;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 3 * g.dpr;
  ctx.strokeRect(m, m, g.W - m * 2, g.H - m * 2); // pitch boundary
  ctx.beginPath(); // halfway line
  ctx.moveTo(m, cy);
  ctx.lineTo(g.W - m, cy);
  ctx.stroke();
  ctx.beginPath(); // centre circle
  ctx.arc(cx, cy, Math.min(g.W, g.H) * 0.13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.85)"; // centre spot
  ctx.beginPath();
  ctx.arc(cx, cy, 4 * g.dpr, 0, Math.PI * 2);
  ctx.fill();
  const gw = g.W * 0.22, gh = Math.min(g.W, g.H) * 0.07; // goal (penalty) boxes
  ctx.strokeRect(cx - gw / 2, m, gw, gh);
  ctx.strokeRect(cx - gw / 2, g.H - m - gh, gw, gh);
  // Goal + net at each end: a mesh grid framed by posts, on the goal line.
  const nw = g.W * 0.11, nh = Math.min(g.W, g.H) * 0.05;
  const net = (ny: number) => {
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; // mesh
    ctx.lineWidth = 1 * g.dpr;
    ctx.beginPath();
    for (let k = 0; k <= 9; k++) {
      const x = cx - nw / 2 + (k / 9) * nw;
      ctx.moveTo(x, ny);
      ctx.lineTo(x, ny + nh);
    }
    for (let k = 0; k <= 4; k++) {
      const y = ny + (k / 4) * nh;
      ctx.moveTo(cx - nw / 2, y);
      ctx.lineTo(cx + nw / 2, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.95)"; // posts + crossbar
    ctx.lineWidth = 3 * g.dpr;
    ctx.strokeRect(cx - nw / 2, ny, nw, nh);
  };
  net(m); // top goal
  net(g.H - m - nh); // bottom goal
  ctx.restore();
}

function stageFootball(ctx: Ctx, g: Geo) {
  const m = Math.min(g.W, g.H) * 0.05;
  const ez = g.W * 0.09; // end zones
  ctx.save();
  ctx.fillStyle = "rgba(40,90,200,0.5)";
  ctx.fillRect(0, 0, ez, g.H);
  ctx.fillStyle = "rgba(200,50,50,0.5)";
  ctx.fillRect(g.W - ez, 0, ez, g.H);
  ctx.strokeStyle = "rgba(255,255,255,0.6)";
  ctx.lineWidth = 2 * g.dpr;
  const lines = 10; // yard lines
  for (let i = 0; i <= lines; i++) {
    const x = ez + (i / lines) * (g.W - ez * 2);
    ctx.beginPath();
    ctx.moveTo(x, m);
    ctx.lineTo(x, g.H - m);
    ctx.stroke();
  }
  ctx.restore();
}

function stageStadium(ctx: Ctx, g: Geo) {
  mowStripes(ctx, g, "rgba(255,255,255,0.04)", "rgba(0,0,0,0.06)", 9);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = 3 * g.dpr;
  ctx.beginPath();
  ctx.arc(g.W / 2, g.H / 2, Math.min(g.W, g.H) * 0.13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  // floodlight towers at the four corners with a warm glow
  const lamp = (x: number, y: number) => {
    const r = g.bandHalf * 0.55;
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 3);
    glow.addColorStop(0, "rgba(255,244,190,0.5)");
    glow.addColorStop(1, "rgba(255,244,190,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f6efc4";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  };
  const m = g.bandHalf * 0.7;
  lamp(m, m);
  lamp(g.W - m, m);
  lamp(m, g.H - m);
  lamp(g.W - m, g.H - m);
}

function stageAirport(ctx: Ctx, g: Geo) {
  const cx = g.W / 2;
  const rw = g.W * 0.2; // runway strip, full height
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(cx - rw / 2, 0, rw, g.H);
  ctx.fillStyle = "rgba(255,255,255,0.8)"; // threshold bars
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(cx + i * rw * 0.14, g.H * 0.05, rw * 0.05, g.H * 0.04);
    ctx.fillRect(cx + i * rw * 0.14, g.H * 0.91, rw * 0.05, g.H * 0.04);
  }
  ctx.strokeStyle = "rgba(255,235,120,0.9)"; // dashed centreline
  ctx.lineWidth = 3 * g.dpr;
  ctx.setLineDash([g.H * 0.05, g.H * 0.04]);
  ctx.beginPath();
  ctx.moveTo(cx, g.H * 0.12);
  ctx.lineTo(cx, g.H * 0.88);
  ctx.stroke();
  ctx.setLineDash([]);
  // plane silhouette parked in the centre
  const py = g.H / 2, s = Math.min(g.W, g.H) * 0.1;
  ctx.fillStyle = "rgba(230,236,245,0.9)";
  ctx.beginPath();
  ctx.ellipse(cx, py, s * 0.16, s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.9, py + s * 0.1);
  ctx.lineTo(cx + s * 0.9, py + s * 0.1);
  ctx.lineTo(cx + s * 0.12, py + s * 0.35);
  ctx.lineTo(cx - s * 0.12, py + s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.35, py - s * 0.8);
  ctx.lineTo(cx + s * 0.35, py - s * 0.8);
  ctx.lineTo(cx + s * 0.06, py - s * 0.5);
  ctx.lineTo(cx - s * 0.06, py - s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function stageRiver(ctx: Ctx, g: Geo) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.16)"; // wavy water across the whole map
  ctx.lineWidth = 2 * g.dpr;
  const rows = 16;
  for (let r = 1; r < rows; r++) {
    const y = (r / rows) * g.H;
    ctx.beginPath();
    for (let x = 0; x <= g.W; x += 10 * g.dpr) {
      const yy = y + Math.sin((x / g.W) * Math.PI * 8 + r) * g.H * 0.008;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  const bank = Math.min(g.W, g.H) * 0.05; // grassy banks along top + bottom
  ctx.fillStyle = "rgba(52,140,70,0.85)";
  ctx.fillRect(0, 0, g.W, bank);
  ctx.fillRect(0, g.H - bank, g.W, bank);
  // little sail boat in the centre
  const bx = g.W / 2, by = g.H / 2, s = Math.min(g.W, g.H) * 0.09;
  ctx.fillStyle = "#8a5a30";
  ctx.beginPath();
  ctx.moveTo(bx - s, by);
  ctx.lineTo(bx + s, by);
  ctx.lineTo(bx + s * 0.6, by + s * 0.4);
  ctx.lineTo(bx - s * 0.6, by + s * 0.4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#f4f4f4";
  ctx.beginPath();
  ctx.moveTo(bx, by - s * 1.3);
  ctx.lineTo(bx, by - s * 0.05);
  ctx.lineTo(bx + s * 0.75, by - s * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function stageBeach(ctx: Ctx, g: Geo) {
  ctx.save();
  const sea = g.H * 0.22; // ocean strip along the top of the whole map
  ctx.fillStyle = "rgba(30,140,175,0.9)";
  ctx.fillRect(0, 0, g.W, sea);
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2 * g.dpr;
  for (let r = 1; r < 4; r++) {
    const y = (r / 4) * sea;
    ctx.beginPath();
    for (let x = 0; x <= g.W; x += 10 * g.dpr) {
      const yy = y + Math.sin((x / g.W) * Math.PI * 7 + r) * 3 * g.dpr;
      if (x === 0) ctx.moveTo(x, yy);
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,214,90,0.95)"; // sun
  ctx.beginPath();
  ctx.arc(g.W * 0.14, sea * 0.5, Math.min(g.W, g.H) * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // beach ball just right of centre
  const bx = g.W * 0.56, by = g.H * 0.52, br = Math.min(g.W, g.H) * 0.06;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8483f";
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.arc(bx, by, br, -Math.PI / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.arc(bx, by, br, Math.PI / 2, Math.PI);
  ctx.closePath();
  ctx.fill();
  // palm tree just left of centre
  const px = g.W * 0.44, py = g.H * 0.62, ph = Math.min(g.W, g.H) * 0.2;
  ctx.strokeStyle = "#8a5a30";
  ctx.lineWidth = 4 * g.dpr;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.quadraticCurveTo(px - ph * 0.2, py - ph * 0.6, px + ph * 0.05, py - ph);
  ctx.stroke();
  ctx.strokeStyle = "#2e9e52";
  ctx.lineWidth = 5 * g.dpr;
  ctx.lineCap = "round";
  for (let a = 0; a < 5; a++) {
    const ang = -Math.PI / 2 + (a - 2) * 0.6;
    ctx.beginPath();
    ctx.moveTo(px + ph * 0.05, py - ph);
    ctx.lineTo(px + ph * 0.05 + Math.cos(ang) * ph * 0.5, py - ph + Math.sin(ang) * ph * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function stageSnow(ctx: Ctx, g: Geo) {
  ctx.save();
  // faint ice sheen bands across the whole field
  const n = 7;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.06)" : "rgba(120,160,200,0.06)";
    ctx.fillRect(0, (i / n) * g.H, g.W, g.H / n + 1);
  }
  // scattered snowflakes
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1.5 * g.dpr;
  for (let i = 0; i < 60; i++) {
    const x = (((i * 89) % 100) / 100) * g.W;
    const y = (((i * 47) % 100) / 100) * g.H;
    const s = (2 + (i % 3)) * g.dpr;
    for (let a = 0; a < 3; a++) {
      const ang = (a * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * s, y - Math.sin(ang) * s);
      ctx.lineTo(x + Math.cos(ang) * s, y + Math.sin(ang) * s);
      ctx.stroke();
    }
  }
  // snowman in the centre
  const cx = g.W / 2, cy = g.H / 2, u = Math.min(g.W, g.H) * 0.05;
  ctx.fillStyle = "#ffffff";
  for (const [dy, rr] of [[1.5, 1], [0.2, 0.78], [-0.9, 0.56]] as const) {
    ctx.beginPath();
    ctx.arc(cx, cy + dy * u, rr * u, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#1a1a1a"; // eyes + hat
  ctx.beginPath();
  ctx.arc(cx - 0.2 * u, cy - u, 0.09 * u, 0, Math.PI * 2);
  ctx.arc(cx + 0.2 * u, cy - u, 0.09 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 0.6 * u, cy - 1.55 * u, 1.2 * u, 0.18 * u);
  ctx.fillRect(cx - 0.42 * u, cy - 2.2 * u, 0.84 * u, 0.7 * u);
  ctx.fillStyle = "#e8843f"; // carrot nose
  ctx.beginPath();
  ctx.moveTo(cx, cy - 0.95 * u);
  ctx.lineTo(cx + 0.55 * u, cy - 0.82 * u);
  ctx.lineTo(cx, cy - 0.72 * u);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Roads are a themed TERRAIN surface for each scene (a dirt track, a mown lane, a
// red athletics track, a sandy path, packed snow...) - never a flat black band -
// so the whole map reads as one cohesive theme and the marble runs on the terrain.
export const STAGES: Stage[] = [
  { name: "Horse Race", bg: "#140d05", road: "#9a6a3a", infield: "#3f7a3a", line: "rgba(255,255,255,0.22)", edge: "rgba(255,255,255,0.45)", song: "horse", decor: stageHorse },
  { name: "Soccer Field", bg: "#0a1f0d", road: "#3aa14a", infield: "#2f8f3a", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "soccer", decor: stageSoccer },
  { name: "Football Field", bg: "#0a1f0d", road: "#369640", infield: "#2c7a34", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "football", decor: stageFootball },
  { name: "Stadium", bg: "#080a10", road: "#b5533f", infield: "#2f7d3a", line: "rgba(255,255,255,0.3)", edge: "rgba(255,255,255,0.55)", song: "stadium", decor: stageStadium },
  { name: "Airport", bg: "#0b0e13", road: "#565d68", infield: "#4a4f57", line: "rgba(255,235,120,0.55)", edge: "rgba(255,255,255,0.5)", song: "airport", decor: stageAirport },
  { name: "River Side", bg: "#07171c", road: "#cbb184", infield: "#1c6f8c", line: "rgba(255,255,255,0.28)", edge: "rgba(255,255,255,0.5)", song: "river", decor: stageRiver },
  { name: "Beach Vibe", bg: "#062330", road: "#d8b878", infield: "#e8cd94", line: "rgba(120,90,40,0.4)", edge: "rgba(255,255,255,0.6)", song: "beach", decor: stageBeach },
  { name: "Snow Park", bg: "#0a1622", road: "#eef5fb", infield: "#d7e6f0", line: "rgba(70,110,150,0.4)", edge: "rgba(120,160,200,0.55)", song: "snow", decor: stageSnow },
];
export const STAGE_ICON = ["🐎", "⚽", "🏈", "🏟️", "✈️", "🛶", "🏖️", "⛄"];
