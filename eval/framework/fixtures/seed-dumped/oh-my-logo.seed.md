# SEED: oh-my-logo

A CLI that renders ASCII-art logos with gradients. Here is the implementation.

## src/palettes.ts

```ts
export const PALETTES = {
  'grad-blue': ['#4ea8ff', '#7f88ff'],
  sunset: ['#ff9966', '#ff5e62', '#ffa34e'],
  dawn: ['#00c6ff', '#0072ff'],
  nebula: ['#654ea3', '#eaafc8'],
  mono: ['#f07178', '#f07178'],
  ocean: ['#667eea', '#764ba2'],
  fire: ['#ff0844', '#ffb199'],
  forest: ['#134e5e', '#71b280'],
  gold: ['#f7971e', '#ffd200'],
  purple: ['#667db6', '#0082c8', '#0078ff'],
  mint: ['#00d2ff', '#3a7bd5'],
  coral: ['#ff9a9e', '#fecfef'],
  matrix: ['#00ff41', '#008f11'],
} as const;

export type PaletteName = keyof typeof PALETTES;

export function resolvePalette(name: string): string[] | null {
  const paletteName = name as PaletteName;
  const palette = PALETTES[paletteName];
  return palette ? [...palette] : null;
}

export function getPaletteNames(): string[] {
  return Object.keys(PALETTES);
}

export function getDefaultPalette(): string[] {
  return [...PALETTES['grad-blue']];
}

export function getPalettePreview(name: PaletteName): string {
  const colors = PALETTES[name];
  return colors.join(' → ');
}
```

## src/utils/errors.ts

```ts
export class OhMyLogoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class PaletteError extends OhMyLogoError {
  public readonly palette: string;

  constructor(paletteName: string) {
    super(`Unknown palette: ${paletteName}`);
    this.palette = paletteName;
  }
}

export class InputError extends OhMyLogoError {
  public readonly input: string;

  constructor(input: string) {
    super(`Invalid input: ${input}`);
    this.input = input;
  }
}

export class FontError extends OhMyLogoError {
  public readonly font: string;

  constructor(fontName: string) {
    super(`Font not found: ${fontName}`);
    this.font = fontName;
  }
}
```

Build with `tsc` and run `dist/index.js`.
