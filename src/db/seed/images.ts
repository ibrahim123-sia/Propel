import sharp from "sharp";

/**
 * Placeholder pictures for the demo seed (16 §1 "placeholder photos"): simple drawn scenes,
 * floor plans, portraits and logos. Clearly illustrations, never passed off as real photos.
 */

export type Picture = {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  color: string;
};

type Palette = { sky: [string, string]; wall: string; floor: string; accent: string; ink: string };

export const palettes: Palette[] = [
  {
    sky: ["#9ec9e6", "#f3e3cf"],
    wall: "#efe6da",
    floor: "#c8a989",
    accent: "#a9502f",
    ink: "#14232b",
  },
  {
    sky: ["#f2b88b", "#fbe5c8"],
    wall: "#f6efe6",
    floor: "#b9926d",
    accent: "#4f6b57",
    ink: "#1c2f38",
  },
  {
    sky: ["#7fb3d5", "#dfeef7"],
    wall: "#e9eef0",
    floor: "#a8a29a",
    accent: "#2f6f8f",
    ink: "#14232b",
  },
  {
    sky: ["#c9b8e8", "#f6e9f0"],
    wall: "#f3ede7",
    floor: "#d2b48c",
    accent: "#8a5a44",
    ink: "#2b2b35",
  },
  {
    sky: ["#8fd3c7", "#eef8f4"],
    wall: "#eef1ea",
    floor: "#b8a07e",
    accent: "#3b7a67",
    ink: "#18302b",
  },
];

const W = 1600;
const H = 1200;

async function render(svg: string, color: string, width = W, height = H): Promise<Picture> {
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
  return { bytes: new Uint8Array(bytes), mime: "image/jpeg", width, height, color };
}

const sky = (p: Palette, id: string) => `
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${p.sky[0]}"/><stop offset="1" stop-color="${p.sky[1]}"/>
  </linearGradient></defs>`;

function skyline(p: Palette, seed: number, baseY: number, scale = 1): string {
  let x = 0;
  let out = "";
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  while (x < W) {
    const w = (60 + rnd() * 120) * scale;
    const h = (120 + rnd() * 420) * scale;
    out += `<rect x="${x}" y="${baseY - h}" width="${w}" height="${h}" fill="${p.ink}" opacity="${0.18 + rnd() * 0.25}"/>`;
    x += w + 8 * scale;
  }
  return out;
}

function palm(x: number, y: number, s: number, color: string): string {
  const leaves = [-70, -35, 0, 35, 70]
    .map(
      (a) =>
        `<path d="M0 0 Q ${40 * s} ${-30 * s} ${90 * s} ${-5 * s} Q ${45 * s} ${-12 * s} 0 0" fill="${color}" transform="rotate(${a})"/>`,
    )
    .join("");
  return `<g transform="translate(${x} ${y})"><rect x="${-6 * s}" y="0" width="${12 * s}" height="${260 * s}" fill="${color}" opacity="0.85"/>${leaves}</g>`;
}

export function livingRoom(p: Palette, seed: number): Promise<Picture> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sky(p, "s")}
      <rect width="${W}" height="${H}" fill="${p.wall}"/>
      <rect x="140" y="120" width="1320" height="620" fill="url(#s)"/>
      ${skyline(p, seed, 740, 1)}
      <rect x="140" y="120" width="1320" height="620" fill="none" stroke="${p.ink}" stroke-width="10" opacity="0.5"/>
      <line x1="580" y1="120" x2="580" y2="740" stroke="${p.ink}" stroke-width="8" opacity="0.4"/>
      <line x1="1020" y1="120" x2="1020" y2="740" stroke="${p.ink}" stroke-width="8" opacity="0.4"/>
      <rect y="860" width="${W}" height="${H - 860}" fill="${p.floor}"/>
      <rect x="360" y="760" width="880" height="200" rx="28" fill="${p.accent}"/>
      <rect x="320" y="820" width="960" height="150" rx="30" fill="${p.accent}" opacity="0.85"/>
      <rect x="640" y="1010" width="320" height="40" rx="10" fill="${p.ink}" opacity="0.7"/>
      <circle cx="1380" cy="820" r="70" fill="${p.ink}" opacity="0.15"/>
    </svg>`,
    p.wall,
  );
}

export function bedroom(p: Palette, seed: number): Promise<Picture> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sky(p, "s")}
      <rect width="${W}" height="${H}" fill="${p.wall}"/>
      <rect x="980" y="160" width="460" height="560" fill="url(#s)"/>
      ${`<g clip-path="inset(0)">${skyline(p, seed + 7, 720, 0.6)}</g>`}
      <rect x="980" y="160" width="460" height="560" fill="none" stroke="${p.ink}" stroke-width="10" opacity="0.4"/>
      <rect y="900" width="${W}" height="${H - 900}" fill="${p.floor}"/>
      <rect x="180" y="600" width="720" height="320" rx="24" fill="#ffffff"/>
      <rect x="180" y="520" width="720" height="120" rx="20" fill="${p.accent}" opacity="0.8"/>
      <rect x="220" y="560" width="200" height="90" rx="20" fill="#ffffff" opacity="0.9"/>
      <rect x="660" y="560" width="200" height="90" rx="20" fill="#ffffff" opacity="0.9"/>
      <rect x="180" y="760" width="720" height="160" rx="10" fill="${p.accent}" opacity="0.35"/>
    </svg>`,
    p.wall,
  );
}

export function kitchen(p: Palette): Promise<Picture> {
  const cabinets = Array.from(
    { length: 6 },
    (_, i) =>
      `<rect x="${220 + i * 200}" y="180" width="180" height="260" rx="8" fill="#ffffff" stroke="${p.ink}" stroke-opacity="0.15"/>`,
  ).join("");
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <rect width="${W}" height="${H}" fill="${p.wall}"/>
      ${cabinets}
      <rect x="200" y="600" width="1220" height="60" fill="${p.ink}" opacity="0.75"/>
      <rect x="200" y="660" width="1220" height="300" fill="#ffffff" stroke="${p.ink}" stroke-opacity="0.15"/>
      <rect x="460" y="760" width="700" height="80" rx="16" fill="${p.accent}" opacity="0.8"/>
      <rect y="960" width="${W}" height="${H - 960}" fill="${p.floor}"/>
      <circle cx="560" cy="120" r="34" fill="${p.accent}"/><circle cx="1040" cy="120" r="34" fill="${p.accent}"/>
    </svg>`,
    p.wall,
  );
}

export function tower(p: Palette, seed: number): Promise<Picture> {
  const rows = Array.from({ length: 18 }, (_, r) =>
    Array.from(
      { length: 6 },
      (_, c) =>
        `<rect x="${640 + c * 54}" y="${180 + r * 46}" width="38" height="30" fill="#ffffff" opacity="${((r * 7 + c * 3 + seed) % 5) / 10 + 0.35}"/>`,
    ).join(""),
  ).join("");
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sky(p, "s")}
      <rect width="${W}" height="${H}" fill="url(#s)"/>
      ${skyline(p, seed, 1000, 0.9)}
      <rect x="610" y="140" width="380" height="900" fill="${p.ink}" opacity="0.88"/>
      ${rows}
      <rect y="1000" width="${W}" height="${H - 1000}" fill="${p.floor}"/>
      ${palm(330, 760, 1, p.ink)}${palm(1280, 790, 0.9, p.ink)}
    </svg>`,
    p.sky[1],
  );
}

export function villa(p: Palette, seed: number): Promise<Picture> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sky(p, "s")}
      <rect width="${W}" height="${H}" fill="url(#s)"/>
      <rect x="260" y="420" width="1080" height="440" fill="${p.wall}"/>
      <rect x="380" y="300" width="620" height="140" fill="${p.wall}"/>
      <rect x="230" y="400" width="1140" height="30" fill="${p.ink}" opacity="0.8"/>
      <rect x="360" y="280" width="660" height="26" fill="${p.ink}" opacity="0.8"/>
      <rect x="340" y="520" width="300" height="240" fill="${p.sky[0]}" stroke="${p.ink}" stroke-width="8" stroke-opacity="0.5"/>
      <rect x="720" y="520" width="520" height="240" fill="${p.sky[0]}" stroke="${p.ink}" stroke-width="8" stroke-opacity="0.5"/>
      <rect y="860" width="${W}" height="${H - 860}" fill="${p.accent}" opacity="0.35"/>
      <rect x="260" y="900" width="1080" height="160" rx="10" fill="#5fb5d6" opacity="0.85"/>
      ${palm(160, 600, 1.1, p.ink)}${palm(1470, 640, 1, p.ink)}
      <circle cx="${200 + (seed % 5) * 280}" cy="160" r="70" fill="#fff6e0" opacity="0.8"/>
    </svg>`,
    p.wall,
  );
}

export function pool(p: Palette): Promise<Picture> {
  return render(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${sky(p, "s")}
      <rect width="${W}" height="${H}" fill="url(#s)"/>
      ${skyline(p, 3, 640, 0.8)}
      <rect y="640" width="${W}" height="${H - 640}" fill="${p.floor}" opacity="0.6"/>
      <path d="M180 760 L1420 760 L1540 1120 L60 1120 Z" fill="#4fb0d8"/>
      <path d="M260 860 Q 520 820 780 860 T 1300 860" stroke="#ffffff" stroke-width="10" fill="none" opacity="0.6"/>
      <path d="M220 980 Q 540 940 860 980 T 1420 980" stroke="#ffffff" stroke-width="10" fill="none" opacity="0.5"/>
      ${palm(120, 420, 1.2, p.ink)}${palm(1500, 430, 1.1, p.ink)}
    </svg>`,
    "#4fb0d8",
  );
}

/** A plain floor plan: rooms as labelled rectangles (02: plans are drawings, not photos). */
export function floorPlan(beds: number): Promise<Picture> {
  const rooms: Array<[number, number, number, number, string]> = [
    [120, 120, 760, 520, "Living / dining"],
    [880, 120, 560, 300, "Kitchen"],
    [880, 420, 280, 220, "Bath"],
    [1160, 420, 280, 220, "Laundry"],
  ];
  const n = Math.max(1, Math.min(beds, 4));
  const w = 1320 / n;
  for (let i = 0; i < n; i++)
    rooms.push([120 + i * w, 640, w, 400, i === 0 ? "Master bedroom" : `Bedroom ${i + 1}`]);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    ${rooms
      .map(
        ([x, y, rw, rh, label]) =>
          `<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="none" stroke="#14232b" stroke-width="10"/>
           <text x="${x + rw / 2}" y="${y + rh / 2}" font-family="Arial, sans-serif" font-size="38" fill="#14232b" text-anchor="middle">${label}</text>`,
      )
      .join("")}
    <text x="${W - 80}" y="${H - 60}" font-family="Arial, sans-serif" font-size="30" fill="#5b6670" text-anchor="end">Illustrative plan, not to scale</text>
  </svg>`;
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer()
    .then((bytes) => ({
      bytes: new Uint8Array(bytes),
      mime: "image/png",
      width: W,
      height: H,
      color: "#ffffff",
    }));
}

/** Portrait placeholder: initials on a soft colour. */
export async function portrait(initials: string, color: string): Promise<Picture> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
    <rect width="800" height="800" fill="${color}"/>
    <circle cx="400" cy="320" r="150" fill="#ffffff" opacity="0.35"/>
    <path d="M140 800 Q 400 470 660 800 Z" fill="#ffffff" opacity="0.35"/>
    <text x="400" y="360" font-family="Arial, sans-serif" font-size="130" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text>
  </svg>`;
  const bytes = await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
  return { bytes: new Uint8Array(bytes), mime: "image/jpeg", width: 800, height: 800, color };
}

/** Wordmark logo on a transparent background. */
export async function logo(name: string, color: string): Promise<Picture> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="240">
    <rect x="20" y="60" width="120" height="120" rx="28" fill="${color}"/>
    <text x="80" y="148" font-family="Georgia, serif" font-size="80" fill="#ffffff" text-anchor="middle">${name.charAt(0)}</text>
    <text x="170" y="145" font-family="Georgia, serif" font-size="56" fill="#14232b">${name.replace(/&/g, "&amp;")}</text>
  </svg>`;
  // Trimmed to the mark and the name: the header shows the logo 36 px tall, so empty margins
  // would shrink the name to a few pixels.
  const { data, info } = await sharp(Buffer.from(svg)).trim().png().toBuffer({
    resolveWithObject: true,
  });
  return {
    bytes: new Uint8Array(data),
    mime: "image/png",
    width: info.width,
    height: info.height,
    color: "#ffffff",
  };
}
